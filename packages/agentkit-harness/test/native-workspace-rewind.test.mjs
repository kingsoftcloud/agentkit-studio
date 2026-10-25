import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { committedWorkspaceCheckpoint } from '../src/native/workspace-checkpoints.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { NativeKernel, emptyUsage, planModeToolDefinitions } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';

function setup(t, authorize = async () => 'allow') {
  const root = mkdtempSync(join(tmpdir(), 'native-rewind-')), workspace = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspace); t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new SqliteRunStore(join(root, 'runs.sqlite')), tools, sequence = 0;
  const create = () => createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir, sessionId: 'session', authorize, enablePatches: true, enableRewind: true });
  tools = create(); t.after(() => store.close());
  const committed = row => committedWorkspaceCheckpoint(row, { store, scope, sessionId: 'session' });
  async function run(name, args, overrides = {}) {
    const runId = `run-${++sequence}`, { config, snapshot } = fixture({ tools: tools.definitions, ...overrides }); let models = 0;
    const ports = { workspace: tools, tools: { ...tools, execute: request => tools.execute(request, { checkpointCommitted: committed }) },
      model: { generate: async () => ++models === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
        toolCalls: [{ name, callId: `call-${sequence}`, arguments: args }] } : { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() } } };
    const kernel = new NativeKernel({ store, digest, owner: runId, ports });
    kernel.start({ ...snapshot, runId, turnId: runId }, config);
    const result = await kernel.runUntilIdle(scope, runId), record = store.load(scope, runId);
    const output = record.receipts.flatMap(row => row.result.results ?? [])[0];
    assert.ok(output, JSON.stringify(record.receipts));
    return { result, record, kernel, runId, output };
  }
  return { root, workspace, stateDir, run, committed, create, get store() { return store; }, get tools() { return tools; },
    reopen() { store.close(); store = new SqliteRunStore(join(root, 'runs.sqlite')); tools = create(); },
    write: (path, text) => writeFileSync(join(workspace, path), text), read: path => readFileSync(join(workspace, path), 'utf8') };
}
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

test('committed preimages survive cold reopen and rewind all later file changes without rerunning tools', async t => {
  const f = setup(t); f.write('a.txt', 'original\r\n'); f.write('script.sh', 'echo old\n'); chmodSync(join(f.workspace, 'script.sh'), 0o755);
  f.write('deleted.bin', Buffer.from([0, 255, 17]));
  const first = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-original', '+first',
    '*** Add File: added.txt', '+created', '*** Update File: script.sh', '*** Move to: moved.sh', '@@', '-echo old', '+echo new') });
  assert.equal(first.result.phase, 'completed'); assert.ok(first.output.content.checkpoint_id);
  await f.run('delete_workspace_file', { path: 'deleted.bin' });
  const second = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-first', '+second') });
  assert.ok(second.output.content.checkpoint_id); f.reopen();
  const list = await f.run('list_workspace_checkpoints', {}); assert.equal(list.output.content.checkpoints.length, 3);
  assert.equal(JSON.stringify(list.output.content).includes('original'), false);
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id: first.output.content.checkpoint_id });
  assert.equal(preview.output.content.can_apply, true); assert.equal(preview.output.content.files.length, 5);
  const rewind = await f.run('rewind_workspace_files', { checkpoint_id: first.output.content.checkpoint_id, preview_token: preview.output.content.preview_token });
  assert.equal(rewind.output.status, 'ok', JSON.stringify(rewind.output)); assert.equal(f.read('a.txt'), 'original\r\n');
  assert.equal(f.read('script.sh'), 'echo old\n'); assert.equal(statSync(join(f.workspace, 'script.sh')).mode & 0o777, 0o755);
  assert.equal(existsSync(join(f.workspace, 'moved.sh')), false); assert.equal(existsSync(join(f.workspace, 'added.txt')), false);
  assert.deepEqual(readFileSync(join(f.workspace, 'deleted.bin')), Buffer.from([0, 255, 17]));
  f.reopen(); const after = await f.run('list_workspace_checkpoints', {});
  assert.equal(after.output.content.checkpoints.filter(row => row.status === 'undone').length, 3);
  assert.equal(after.output.content.checkpoints[0].status, 'completed');
  const repeat = await f.run('rewind_workspace_files', { checkpoint_id: first.output.content.checkpoint_id, preview_token: preview.output.content.preview_token });
  assert.equal(repeat.output.status, 'error'); assert.equal(f.read('a.txt'), 'original\r\n');
});

test('external edits after preview reject the whole rewind before any restoration', async t => {
  const f = setup(t); f.write('a.txt', 'old\n');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-old', '+new', '*** Add File: added.txt', '+created') });
  const checkpoint_id = changed.output.content.checkpoint_id;
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id }); assert.equal(preview.output.content.can_apply, true);
  f.write('a.txt', 'external\n');
  const rejected = await f.run('rewind_workspace_files', { checkpoint_id, preview_token: preview.output.content.preview_token });
  assert.equal(rejected.output.status, 'error'); assert.equal(rejected.output.content.executed, false);
  assert.equal(f.read('a.txt'), 'external\n'); assert.equal(f.read('added.txt'), 'created\n');
});

test('rewind restores empty-directory/file transitions and its own inverse', async t => {
  const f = setup(t); mkdirSync(join(f.workspace, 'changed'), { mode: 0o750 });
  const first = await f.run('delete_workspace_file', { path: 'changed' });
  assert.equal(first.output.status, 'ok');
  assert.equal((await f.run('write_workspace_file', { path: 'changed', content: 'new file' })).output.status, 'ok');
  const checkpoint_id = first.output.content.checkpoint_id;
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id }); assert.equal(preview.output.content.can_apply, true);
  const restored = await f.run('rewind_workspace_files', { checkpoint_id, preview_token: preview.output.content.preview_token });
  assert.equal(restored.output.status, 'ok', JSON.stringify(restored.output));
  assert.equal(statSync(join(f.workspace, 'changed')).isDirectory(), true);
  assert.equal(statSync(join(f.workspace, 'changed')).mode & 0o777, 0o750);
  f.reopen();
  const inverseId = restored.output.content.checkpoint_id;
  const inverse = await f.run('preview_workspace_rewind', { checkpoint_id: inverseId }); assert.equal(inverse.output.content.can_apply, true);
  const replay = await f.run('rewind_workspace_files', { checkpoint_id: inverseId, preview_token: inverse.output.content.preview_token });
  assert.equal(replay.output.status, 'ok', JSON.stringify(replay.output)); assert.equal(f.read('changed'), 'new file');
});

test('a local completed journal without a committed Native receipt cannot authorize rewind', async t => {
  const f = setup(t), definition = f.tools.definitions.find(tool => tool.name === 'apply_workspace_patch');
  const result = await f.tools.execute({ scope, runId: 'not-admitted', sessionId: 'session', operationKey: 'uncommitted', definition,
    call: { name: definition.name, callId: 'call', arguments: { patch_text: patch('*** Add File: added.txt', '+created') } }, signal: new AbortController().signal });
  assert.equal(result.status, 'ok');
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id: result.content.checkpoint_id });
  assert.equal(preview.output.content.can_apply, false); assert.equal(preview.output.content.unsafe_files[0].reason, 'checkpoint_receipt_uncommitted');
  assert.equal(f.read('added.txt'), 'created\n');
});

test('legacy frozen writer definitions do not gain checkpoints when the Host enables rewind', async t => {
  const f = setup(t), definition = { ...f.tools.definitions.find(tool => tool.name === 'write_workspace_file') }; delete definition.workspaceCheckpointPolicy;
  const result = await f.tools.execute({ sessionId: 'session', operationKey: 'legacy', definition,
    call: { name: definition.name, callId: 'legacy', arguments: { path: 'legacy.txt', content: 'legacy' } }, signal: new AbortController().signal });
  assert.equal(result.status, 'ok'); assert.equal(result.content.checkpoint_id, undefined);
  const list = await f.run('list_workspace_checkpoints', {}); assert.deepEqual(list.output.content.checkpoints, []);
});

test('a changed execution fence cannot replay an already completed publication without its Native receipt', async t => {
  const f = setup(t), definition = f.tools.definitions.find(tool => tool.name === 'write_workspace_file');
  const request = { scope, sessionId: 'session', runId: 'lost-receipt', turnId: 'turn', operationKey: 'same-effect', executionFence: 1, definition,
    call: { name: definition.name, callId: 'same-call', arguments: { path: 'once.txt', content: 'published once' } }, signal: new AbortController().signal };
  assert.equal((await f.tools.execute(request)).status, 'ok'); f.reopen();
  const retry = await f.tools.execute({ ...request, executionFence: 2 });
  assert.equal(retry.status, 'error'); assert.equal(retry.content.error_type, 'checkpoint_operation_already_recorded');
  assert.equal(f.read('once.txt'), 'published once');
});

test('a real post-publication state failure leaves an unknown journal across cold reopen', async t => {
  const f = setup(t); const { sessionKeyFor } = await import('../src/native/workspace-state.mjs');
  mkdirSync(join(f.stateDir, sessionKeyFor('session'), 'read-state.json'), { recursive: true });
  const interrupted = await f.run('apply_workspace_patch', { patch_text: patch('*** Add File: first.txt', '+first', '*** Add File: second.txt', '+second') });
  assert.equal(interrupted.result.phase, 'interrupted'); assert.equal(interrupted.result.reason, 'effect_outcome_unknown');
  assert.equal(f.read('first.txt'), 'first\n'); assert.equal(existsSync(join(f.workspace, 'second.txt')), false); f.reopen();
  const list = await f.run('list_workspace_checkpoints', {}); assert.equal(list.output.content.checkpoints[0].status, 'prepared');
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id: list.output.content.checkpoints[0].checkpoint_id });
  assert.equal(preview.output.content.can_apply, false);
  assert.equal(f.read('first.txt'), 'first\n'); assert.equal(existsSync(join(f.workspace, 'second.txt')), false);
});

test('mode drift before checkpoint completion leaves an uncertain effect instead of certifying the wrong mode', async t => {
  const f = setup(t); f.write('script.sh', 'old'); chmodSync(join(f.workspace, 'script.sh'), 0o755);
  await f.run('read_workspace_file', { path: 'script.sh' });
  const definition = f.tools.definitions.find(tool => tool.name === 'write_workspace_file'); let changed = false;
  const result = await f.tools.execute({ scope, sessionId: 'session', runId: 'mode-drift', turnId: 'turn', operationKey: 'write-mode', definition,
    call: { name: definition.name, callId: 'mode-call', arguments: { path: 'script.sh', content: 'new' } }, signal: new AbortController().signal },
  { assertCurrent: () => { if (!changed && f.read('script.sh') === 'new') { chmodSync(join(f.workspace, 'script.sh'), 0o600); changed = true; } return true; } });
  assert.equal(changed, true); assert.equal(result.status, 'uncertain'); assert.equal(f.read('script.sh'), 'new');
  f.reopen(); const list = await f.run('list_workspace_checkpoints', {});
  assert.equal(list.output.content.checkpoints[0].status, 'prepared');
});

test('approval resumes the exact preview and refuses edits made while the user was deciding', async t => {
  let decision = 'allow'; const f = setup(t, async () => decision); f.write('a.txt', 'old\n');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-old', '+new') });
  const checkpoint_id = changed.output.content.checkpoint_id;
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id }); decision = 'approval_required';
  const waiting = await f.run('rewind_workspace_files', { checkpoint_id, preview_token: preview.output.content.preview_token });
  assert.equal(waiting.result.phase, 'awaiting_interaction'); f.write('a.txt', 'external\n');
  waiting.kernel.submit(scope, waiting.runId, { commandId: 'approve', kind: 'submit_interaction', payload: {
    interactionId: waiting.result.pendingInteraction.interactionId, decision: 'allow' } });
  assert.equal((await waiting.kernel.runUntilIdle(scope, waiting.runId)).phase, 'completed'); assert.equal(f.read('a.txt'), 'external\n');
  const errors = f.store.load(scope, waiting.runId).receipts.flatMap(row => row.result.results ?? []).filter(row => row.status === 'error');
  assert.equal(errors.at(-1).content.error_type, 'checkpoint_rewind_conflict');
});

test('Plan mode cannot execute a previewed rewind', async t => {
  const f = setup(t); f.write('a.txt', 'old\n');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-old', '+new') });
  const checkpoint_id = changed.output.content.checkpoint_id, preview = await f.run('preview_workspace_rewind', { checkpoint_id });
  const denied = await f.run('rewind_workspace_files', { checkpoint_id, preview_token: preview.output.content.preview_token }, {
    planModePolicy: 'session-plan/v1', planModeInitialActive: true, tools: [...f.tools.definitions, ...planModeToolDefinitions()] });
  assert.equal(denied.output.status, 'error'); assert.equal(denied.output.content.code, 'plan_mode_write_denied'); assert.equal(f.read('a.txt'), 'new\n');
});

test('checkpoint output bounds reject an oversized write before publishing bytes', async t => {
  const f = setup(t), definition = f.tools.definitions.find(tool => tool.name === 'write_workspace_file');
  const result = await f.tools.execute({ sessionId: 'session', operationKey: 'oversize', definition,
    call: { name: definition.name, callId: 'oversize', arguments: { path: 'large.txt', content: 'x'.repeat(2 * 1024 * 1024 + 1) } }, signal: new AbortController().signal });
  assert.equal(result.status, 'error'); assert.equal(result.content.error_type, 'checkpoint_budget_exceeded');
  assert.equal(existsSync(join(f.workspace, 'large.txt')), false);
});
