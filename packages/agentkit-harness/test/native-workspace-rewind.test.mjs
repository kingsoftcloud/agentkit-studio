import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, chmodSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { committedWorkspaceCheckpoint } from '@kingsoftcloud/agentkit-harness-node/native/workspace-checkpoints';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { NativeKernel, emptyUsage, planModeToolDefinitions } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from '../../../tests/fixtures/native-core.mjs';
import { createNativeToolAuthority, createNativeToolReceiptAuthority, createNativeWorkspaceRepairAuthority } from '../../../src/providers/native-tool-authority.mjs';

function setup(t, authorize = async () => 'allow') {
  const root = mkdtempSync(join(tmpdir(), 'native-rewind-')), workspace = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspace); t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new SqliteRunStore(join(root, 'runs.sqlite')), tools, sequence = 0;
  const create = () => createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir, sessionId: 'session', authorize, enablePatches: true, enableRewind: true });
  tools = create(); t.after(() => store.close());
  const committed = row => committedWorkspaceCheckpoint(row, { store, scope, sessionId: 'session' });
  async function run(name, args, overrides = {}, options = {}) {
    const runId = `run-${++sequence}`, { config, snapshot } = fixture({ tools: tools.definitions, ...overrides }); let models = 0;
    const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
    const ports = { workspace: tools, tools: { ...tools, execute: async request => {
      const result = await tools.execute(request, { checkpointCommitted: committed, assertCurrent: authority });
      if (!options.skipReceipt) tools.recordReceipt(request, result, { assertCurrent: authority });
      return options.afterReceipt ? options.afterReceipt(result, request) : result;
    } },
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

test('v2 Edit creation has a durable absent preimage and cold file rewind removes only that creation', async t => {
  const f = setup(t);
  const tools = f.tools.definitions.map(tool => tool.name === 'edit_workspace_file' ? { ...tool, workspaceEditPolicy: 'zcode-match/v2' } : tool);
  const created = await f.run('edit_workspace_file', { path: 'created.txt', old_text: '', new_text: 'created through Edit\n' }, { tools });
  assert.equal(created.output.status, 'ok', JSON.stringify(created.output));
  assert.ok(created.output.content.checkpoint_id); assert.deepEqual(created.output.workspaceChangedPaths, ['created.txt']);
  assert.equal(f.read('created.txt'), 'created through Edit\n');
  f.reopen();
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id: created.output.content.checkpoint_id });
  assert.equal(preview.output.content.can_apply, true, JSON.stringify(preview.output));
  assert.deepEqual(preview.output.content.files.map(file => [file.path, file.action]), [['created.txt', 'delete']]);
  const undone = await f.run('rewind_workspace_files', { checkpoint_id: created.output.content.checkpoint_id, preview_token: preview.output.content.preview_token });
  assert.equal(undone.output.status, 'ok', JSON.stringify(undone.output));
  assert.equal(existsSync(join(f.workspace, 'created.txt')), false);
  assert.deepEqual(f.store.load(scope, created.runId), created.record, 'rewind does not change the admitted v2 Run');
});

function conversationControl(record, commandId = 'combined') {
  return { contract: 'agentkit.native-conversation-workspace-control/v1', scope, sessionId: 'session',
    commandId, requestDigest: `request-${commandId}`, sourceDigest: digest(record),
    expectedHeadRunId: record.snapshot.runId, expectedGeneration: 0, targetMessageId: 'input', selectionDigest: 'selection' };
}

test('Host combined rewind uses a separate durable intent, retains earlier files, and cold-retries without rewriting its source Run', async t => {
  const f = setup(t);
  const kept = await f.run('write_workspace_file', { path: 'kept.txt', content: 'Keep' });
  const removed = await f.run('write_workspace_file', { path: 'removed.txt', content: 'Remove' });
  const control = conversationControl(removed.record), options = { signal: new AbortController().signal, assertCurrent: () => true,
    checkpointCommitted: f.committed, selectCheckpoint: () => removed.output.content.checkpoint_id };
  const preview = f.tools.previewConversationRewind(control, options);
  assert.equal(preview.canApply, true); assert.deepEqual(preview.files.map(file => file.path), ['removed.txt']);
  assert.equal(f.read('removed.txt'), 'Remove', 'preview does not publish');
  const request = { ...control, workspacePreviewToken: preview.previewToken };
  const result = f.tools.rewindConversation(request, options);
  assert.equal(existsSync(join(f.workspace, 'removed.txt')), false); assert.equal(f.read('kept.txt'), 'Keep');
  assert.deepEqual(f.store.load(scope, kept.runId), kept.record); assert.deepEqual(f.store.load(scope, removed.runId), removed.record);
  assert.deepEqual(f.tools.pendingConversationRewind([]), request);
  assert.equal(f.tools.pendingConversationRewind([{ commandId: request.commandId, requestDigest: request.requestDigest }]), null);
  f.reopen();
  assert.deepEqual(f.tools.rewindConversation(request, { ...options, checkpointCommitted: f.committed }), result);
  const inverse = await f.run('preview_workspace_rewind', { checkpoint_id: result.checkpointId });
  assert.equal(inverse.output.content.can_apply, true, 'ordinary file rewind verifies the Host control receipt provenance');
});

test('Host combined rewind refuses external edits after its frozen preview', async t => {
  const f = setup(t), changed = await f.run('write_workspace_file', { path: 'a.txt', content: 'Native' });
  const control = conversationControl(changed.record), options = { signal: new AbortController().signal, assertCurrent: () => true,
    checkpointCommitted: f.committed, selectCheckpoint: () => changed.output.content.checkpoint_id };
  const preview = f.tools.previewConversationRewind(control, options); f.write('a.txt', 'External');
  assert.throws(() => f.tools.rewindConversation({ ...control, workspacePreviewToken: preview.previewToken }, options), { code: 'checkpoint_rewind_conflict' });
  assert.equal(f.read('a.txt'), 'External'); assert.equal(f.tools.pendingConversationRewind([]), null);
});

test('retry observes a completed Host result while preserving subsequent user edits', async t => {
  const f = setup(t), changed = await f.run('write_workspace_file', { path: 'a.txt', content: 'Native' });
  const control = conversationControl(changed.record), options = { signal: new AbortController().signal, assertCurrent: () => true,
    checkpointCommitted: f.committed, selectCheckpoint: () => changed.output.content.checkpoint_id };
  const preview = f.tools.previewConversationRewind(control, options), request = { ...control, workspacePreviewToken: preview.previewToken };
  const result = f.tools.rewindConversation(request, options); f.write('a.txt', 'Later user edit'); f.reopen();
  assert.deepEqual(f.tools.rewindConversation(request, { ...options, checkpointCommitted: f.committed }), result);
  assert.equal(f.read('a.txt'), 'Later user edit');
});

test('an earlier rewind includes both an undone publication and its inverse, without resurrecting a removed file', async t => {
  const f = setup(t);
  const first = await f.run('write_workspace_file', { path: 'a.txt', content: 'A' });
  const second = await f.run('write_workspace_file', { path: 'b.txt', content: 'B' });
  const options = { signal: new AbortController().signal, assertCurrent: () => true, checkpointCommitted: f.committed,
    selectCheckpoint: () => second.output.content.checkpoint_id };
  const control = conversationControl(second.record, 'remove-second');
  const preview = f.tools.previewConversationRewind(control, options);
  f.tools.rewindConversation({ ...control, workspacePreviewToken: preview.previewToken }, options);
  assert.equal(existsSync(join(f.workspace, 'b.txt')), false);
  const earlier = conversationControl(second.record, 'remove-first');
  const rootOptions = { ...options, selectCheckpoint: () => first.output.content.checkpoint_id };
  const rootPreview = f.tools.previewConversationRewind(earlier, rootOptions); assert.equal(rootPreview.canApply, true);
  f.tools.rewindConversation({ ...earlier, workspacePreviewToken: rootPreview.previewToken }, rootOptions);
  assert.equal(existsSync(join(f.workspace, 'a.txt')), false);
  assert.equal(existsSync(join(f.workspace, 'b.txt')), false, 'undoing an older input must not revive a removed branch file');
});

test('cold retry compensates an interrupted Host restore and never blindly repeats the file operation', async t => {
  const f = setup(t); f.write('a.txt', 'Before');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-Before', '+After') });
  assert.equal(changed.output.status, 'ok');
  const control = conversationControl(changed.record), controller = new AbortController();
  const options = { signal: controller.signal, checkpointCommitted: f.committed,
    selectCheckpoint: () => changed.output.content.checkpoint_id,
    assertCurrent: () => { if (f.read('a.txt') === 'Before') controller.abort(Error('lost Host after publication')); return true; } };
  const preview = f.tools.previewConversationRewind(control, options), request = { ...control, workspacePreviewToken: preview.previewToken };
  assert.throws(() => f.tools.rewindConversation(request, options), /lost Host/);
  assert.equal(f.read('a.txt'), 'Before'); assert.deepEqual(f.tools.pendingConversationRewind([]), request);
  f.reopen();
  assert.throws(() => f.tools.rewindConversation(request, { ...options, signal: new AbortController().signal, assertCurrent: () => true,
    checkpointCommitted: f.committed }), { code: 'checkpoint_control_compensated' });
  assert.equal(f.read('a.txt'), 'After\n'); assert.equal(f.tools.pendingConversationRewind([]), null);
  assert.deepEqual(f.store.load(scope, changed.runId), changed.record);
  assert.throws(() => f.tools.rewindConversation(request, { ...options, signal: new AbortController().signal, assertCurrent: () => true,
    checkpointCommitted: f.committed }), { code: 'checkpoint_control_compensated' });
});

test('actual SIGKILL after Host file publication leaves a durable intent that cold retry compensates', async t => {
  const f = setup(t); f.write('a.txt', 'Before');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-Before', '+After') });
  const control = conversationControl(changed.record, 'actual-process-death'), options = { signal: new AbortController().signal,
    assertCurrent: () => true, checkpointCommitted: f.committed, selectCheckpoint: () => changed.output.content.checkpoint_id };
  const preview = f.tools.previewConversationRewind(control, options), request = { ...control, workspacePreviewToken: preview.previewToken };
  const input = join(f.root, 'crash-input.json'); writeFileSync(input, JSON.stringify({ root: f.root, control: request, checkpointId: changed.output.content.checkpoint_id }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../tests/fixtures/native-conversation-workspace-crash.mjs', import.meta.url)), input],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes);
  const exited = once(child, 'exit'); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [code, signal] = await exited; assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'control-publication-crash.json'), 'utf8')).commandId, request.commandId);
  assert.equal(f.read('a.txt'), 'Before');
  f.reopen(); assert.deepEqual(f.tools.pendingConversationRewind([]), request);
  assert.throws(() => f.tools.rewindConversation(request, { ...options, checkpointCommitted: f.committed }), { code: 'checkpoint_control_compensated' });
  assert.equal(f.read('a.txt'), 'After\n'); assert.equal(f.tools.pendingConversationRewind([]), null);
  assert.deepEqual(f.store.load(scope, changed.runId), changed.record);
});

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
  const f = setup(t); const { sessionKeyFor } = await import('@kingsoftcloud/agentkit-harness-node/native/workspace-state');
  mkdirSync(join(f.stateDir, sessionKeyFor('session'), 'read-state.json'), { recursive: true });
  const interrupted = await f.run('apply_workspace_patch', { patch_text: patch('*** Add File: first.txt', '+first', '*** Add File: second.txt', '+second') });
  assert.equal(interrupted.result.phase, 'awaiting_reconciliation'); assert.equal(interrupted.result.reason, 'effect_outcome_unknown');
  assert.equal(f.read('first.txt'), 'first\n'); assert.equal(existsSync(join(f.workspace, 'second.txt')), false); f.reopen();
  await assert.rejects(f.run('list_workspace_checkpoints', {}), /session_already_active/);
  const list = await f.tools.execute({ sessionId: 'session', call: { name: 'list_workspace_checkpoints', arguments: {} } });
  assert.equal(list.content.checkpoints[0].status, 'prepared');
  const preview = await f.tools.execute({ sessionId: 'session', call: { name: 'preview_workspace_rewind',
    arguments: { checkpoint_id: list.content.checkpoints[0].checkpoint_id } } }, { checkpointCommitted: f.committed });
  assert.equal(preview.content.can_apply, false);
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

for (const lostReceipt of [false, true]) test(`a real rewind state-write failure compensates files${lostReceipt ? ' and its lost final error receipt is read after cold reopen' : ' and preserves original checkpoints for a fresh attempt'}`, async t => {
  const f = setup(t); f.write('a.txt', 'old a\n'); f.write('b.txt', 'old b\n');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-old a', '+new a', '*** Update File: b.txt', '@@', '-old b', '+new b') });
  const checkpoint_id = changed.output.content.checkpoint_id, preview = await f.run('preview_workspace_rewind', { checkpoint_id });
  const { sessionKeyFor } = await import('@kingsoftcloud/agentkit-harness-node/native/workspace-state');
  const statePath = join(f.stateDir, sessionKeyFor('session'), 'read-state.json'); rmSync(statePath); mkdirSync(statePath);
  let actual;
  const failed = await f.run('rewind_workspace_files', { checkpoint_id, preview_token: preview.output.content.preview_token }, {}, {
    afterReceipt: result => { actual = result; return lostReceipt ? { status: 'uncertain', content: { code: 'lost_compensated_error' } } : result; },
  });
  assert.equal(actual.status, 'error', JSON.stringify(actual)); assert.equal(actual.content.compensated, true);
  assert.equal(failed.result.phase, lostReceipt ? 'awaiting_reconciliation' : 'completed');
  assert.equal(f.read('a.txt'), 'new a\n'); assert.equal(f.read('b.txt'), 'new b\n');
  if (lostReceipt) {
    f.reopen(); const authority = createNativeToolReceiptAuthority({ scope, sessionId: 'session', store: f.store });
    const kernel = new NativeKernel({ store: f.store, digest, owner: 'cold-compensated-error', ports: { workspace: f.tools,
      tools: { execute: async () => assert.fail('compensated rewind must not replay'),
        observeReceipt: request => f.tools.observeReceipt(request, { assertCurrent: authority }) },
      model: { generate: async request => { assert.match(request.messages.filter(message => message.role === 'tool').at(-1).content, /checkpoint_rewind_compensated/);
        return { kind: 'final_candidate', text: 'Rewind failed and was compensated', usage: emptyUsage(), toolCalls: [] }; } },
    } });
    kernel.reconcileTool(scope, failed.runId, failed.result.toolReconciliation.operationKey, 'read-compensated-result');
    assert.equal((await kernel.runUntilIdle(scope, failed.runId)).phase, 'completed');
  }
  rmSync(statePath, { recursive: true }); f.reopen();
  const list = await f.run('list_workspace_checkpoints', {});
  assert.equal(list.output.content.checkpoints[0].status, 'failed'); assert.equal(list.output.content.checkpoints[1].status, 'completed');
  const next = await f.run('preview_workspace_rewind', { checkpoint_id }); assert.equal(next.output.content.can_apply, true);
  const restored = await f.run('rewind_workspace_files', { checkpoint_id, preview_token: next.output.content.preview_token });
  assert.equal(restored.output.status, 'ok'); assert.equal(f.read('a.txt'), 'old a\n'); assert.equal(f.read('b.txt'), 'old b\n');
});

const compensationConflicts = { cancel: 'lost cancel authority', fence: 'lost fence authority', external: 'an external edit',
  repoint: 'a repointed path with identical bytes', escape: 'a path repointed outside the workspace' };
for (const reason of Object.keys(compensationConflicts)) test(`partial rewind does not compensate over ${compensationConflicts[reason]}`, async t => {
  const f = setup(t); f.write('a.txt', 'old a\n'); f.write('b.txt', 'old b\n');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-old a', '+new a', '*** Update File: b.txt', '@@', '-old b', '+new b') });
  const checkpoint_id = changed.output.content.checkpoint_id, preview = await f.run('preview_workspace_rewind', { checkpoint_id });
  const definition = f.tools.definitions.find(tool => tool.name === 'rewind_workspace_files'), controller = new AbortController(); let injected = false;
  const result = await f.tools.execute({ scope, sessionId: 'session', runId: 'partial-rewind', turnId: 'turn', operationKey: 'partial', definition,
    call: { name: definition.name, callId: 'partial-call', arguments: { checkpoint_id, preview_token: preview.output.content.preview_token } }, signal: controller.signal },
  { checkpointCommitted: f.committed, assertCurrent: () => {
    if (!injected && f.read('b.txt') === 'old b\n') {
      injected = true;
      if (reason === 'cancel') controller.abort();
      if (reason === 'external') { f.write('b.txt', 'external\n'); throw Object.assign(Error('known failure after external edit'), { code: 'EIO' }); }
      if (reason === 'repoint') {
        renameSync(join(f.workspace, 'b.txt'), join(f.workspace, 'held.txt')); f.write('other.txt', 'old b\n');
        symlinkSync('other.txt', join(f.workspace, 'b.txt')); throw Object.assign(Error('known failure after path swap'), { code: 'EIO' });
      }
      if (reason === 'escape') {
        renameSync(join(f.workspace, 'b.txt'), join(f.workspace, 'held.txt')); writeFileSync(join(f.root, 'outside.txt'), 'old b\n');
        symlinkSync(join(f.root, 'outside.txt'), join(f.workspace, 'b.txt'));
      }
    }
    return !(injected && reason === 'fence');
  } });
  assert.equal(injected, true); assert.equal(result.status, 'uncertain', JSON.stringify(result));
  assert.equal(f.read('a.txt'), 'new a\n'); assert.equal(f.read('b.txt'), reason === 'external' ? 'external\n' : 'old b\n');
  if (reason === 'repoint') assert.equal(f.read('other.txt'), 'old b\n');
  if (reason === 'escape') assert.equal(readFileSync(join(f.root, 'outside.txt'), 'utf8'), 'old b\n');
  f.reopen(); const list = await f.run('list_workspace_checkpoints', {});
  assert.equal(list.output.content.checkpoints[0].status, ['external', 'repoint', 'escape'].includes(reason) ? 'compensating' : 'prepared');
  assert.equal((await f.run('preview_workspace_rewind', { checkpoint_id })).output.content.can_apply, false);
});

for (const persisted of [true, false]) test(`cold receipt observation ${persisted ? 'settles the original effect without replay' : 'cannot certify a raw filesystem success before final post-policy receipt'}`, async t => {
  const f = setup(t); let calls = 0, checkpoint_id;
  const waiting = await f.run('write_workspace_file', { path: 'once.txt', content: 'published once' }, {}, {
    skipReceipt: !persisted, afterReceipt: result => { calls++; checkpoint_id = result.content.checkpoint_id;
      return { status: 'uncertain', content: { code: 'lost_final_delivery' } }; },
  });
  assert.equal(waiting.result.phase, 'awaiting_reconciliation'); assert.equal(calls, 1); f.reopen();
  const before = f.store.load(scope, waiting.runId), authority = createNativeToolReceiptAuthority({ scope, sessionId: 'session', store: f.store }); let reads = 0, models = 0;
  const kernel = new NativeKernel({ store: f.store, digest, owner: 'cold-owner', ports: {
    workspace: f.tools, tools: { execute: async () => assert.fail('the original file write must never replay'),
      observeReceipt: request => { reads++; return f.tools.observeReceipt(request, { assertCurrent: authority }); } },
    model: { generate: async () => { models++; return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() }; } },
  } });
  kernel.reconcileTool(scope, waiting.runId, waiting.result.toolReconciliation.operationKey, 'inspect-original-receipt');
  const resumed = await kernel.runUntilIdle(scope, waiting.runId);
  assert.equal(reads, 1); assert.equal(resumed.phase, persisted ? 'completed' : 'awaiting_reconciliation', JSON.stringify(f.store.load(scope, waiting.runId).receipts)); assert.equal(models, persisted ? 1 : 0);
  assert.equal(resumed.usage.toolCalls, 1); assert.equal(f.read('once.txt'), 'published once');
  const after = f.store.load(scope, waiting.runId);
  const queryReceipt = after.receipts.find(row => row.result.contract === 'agentkit.tool-receipt-observation/v1');
  assert.equal(queryReceipt?.status, 'committed'); assert.equal(queryReceipt.result.result === null, !persisted);
  assert.deepEqual(after.receipts.find(row => row.operationKey === waiting.result.toolReconciliation.operationKey),
    before.receipts.find(row => row.operationKey === waiting.result.toolReconciliation.operationKey));
  if (persisted) {
    assert.equal(after.events.filter(event => event.kind === 'tool.receipt_reconciled').length, 1);
    const preview = await f.run('preview_workspace_rewind', { checkpoint_id }); assert.equal(preview.output.content.can_apply, true);
    assert.equal((await f.run('rewind_workspace_files', { checkpoint_id, preview_token: preview.output.content.preview_token })).output.status, 'ok');
    assert.equal(existsSync(join(f.workspace, 'once.txt')), false);
  }
});

test('explicit compensation of an unconfirmed completed rewind restores its original checkpoint chain', async t => {
  const f = setup(t); f.write('a.txt', 'before\n');
  const changed = await f.run('apply_workspace_patch', { patch_text: patch('*** Update File: a.txt', '@@', '-before', '+after') });
  const checkpoint_id = changed.output.content.checkpoint_id;
  const preview = await f.run('preview_workspace_rewind', { checkpoint_id });
  const waiting = await f.run('rewind_workspace_files', { checkpoint_id, preview_token: preview.output.content.preview_token }, {}, {
    skipReceipt: true, afterReceipt: () => ({ status: 'uncertain', content: { code: 'lost_after_raw_rewind' } }),
  });
  assert.equal(f.read('a.txt'), 'before\n'); assert.equal(waiting.result.phase, 'awaiting_reconciliation'); f.reopen();
  const authority = createNativeWorkspaceRepairAuthority({ scope, sessionId: 'session', store: f.store });
  const kernel = new NativeKernel({ store: f.store, digest, owner: 'repair-rewind', ports: { workspace: f.tools,
    tools: { execute: async () => assert.fail('original rewind cannot replay'), repairWorkspace: async request => {
      const result = await f.tools.repairWorkspace(request, { assertCurrent: authority });
      f.tools.recordRepairReceipt(request, result.result, { assertCurrent: authority }); return result;
    } }, model: { generate: async () => ({ kind: 'final_candidate', text: 'Undo compensated', toolCalls: [], usage: emptyUsage() }) },
  } });
  kernel.submit(scope, waiting.runId, { kind: 'repair_workspace', commandId: 'operator-undo-unconfirmed-rewind',
    payload: { originalOperationKey: waiting.result.toolReconciliation.operationKey } });
  assert.equal((await kernel.runUntilIdle(scope, waiting.runId)).phase, 'completed'); assert.equal(f.read('a.txt'), 'after\n');
  const next = await f.run('preview_workspace_rewind', { checkpoint_id }); assert.equal(next.output.content.can_apply, true);
  assert.equal((await f.run('rewind_workspace_files', { checkpoint_id, preview_token: next.output.content.preview_token })).output.status, 'ok');
  assert.equal(f.read('a.txt'), 'before\n');
});
