import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { sessionKeyFor } from '../src/native/workspace-state.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { NativeKernel, emptyUsage, planModeToolDefinitions } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
function setup(t, { authorize = async () => 'allow', enablePatches = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-patch-')), workspace = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspace); t.after(() => rmSync(root, { recursive: true, force: true }));
  const create = () => createNativeWorkspaceTools({ workspaceRoot: workspace, stateDir, sessionId: 'session', authorize, enablePatches });
  const tools = create(); let sequence = 0;
  const call = (patch_text, options = {}) => tools.execute({ sessionId: 'session', operationKey: `op-${++sequence}`,
    call: { name: 'apply_workspace_patch', callId: `patch-${sequence}`, arguments: { patch_text } },
    definition: tools.definitions.find(tool => tool.name === 'apply_workspace_patch'), signal: new AbortController().signal,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'assertCurrent')) },
  { assertCurrent: options.assertCurrent });
  return { root, workspace, stateDir, tools, create, call, write: (path, text) => writeFileSync(join(workspace, path), text),
    read: path => readFileSync(join(workspace, path), 'utf8') };
}

test('structured add, update, move and delete verify together, preserve EOL/mode and refresh successful read state', async t => {
  const f = setup(t); f.write('source.txt', 'keep\r\nold\r\n'); f.write('script.sh', 'echo old\n');
  chmodSync(join(f.workspace, 'script.sh'), 0o755); f.write('gone.txt', 'delete me\n');
  const result = await f.call(patch('*** Update File: source.txt', '@@', ' keep', '-old', '+new',
    '*** Add File: nested/added.txt', '+新增', '*** Update File: script.sh', '*** Move to: moved.sh', '@@', '-echo old', '+echo new',
    '*** Delete File: gone.txt'));
  assert.equal(result.status, 'ok', JSON.stringify(result)); assert.deepEqual(result.content.files.map(file => file.type), ['update', 'add', 'move', 'delete']);
  assert.equal(f.read('source.txt'), 'keep\r\nnew\r\n'); assert.equal(f.read('nested/added.txt'), '新增\n'); assert.equal(f.read('moved.sh'), 'echo new\n');
  assert.equal(statSync(join(f.workspace, 'moved.sh')).mode & 0o777, 0o755);
  assert.equal(existsSync(join(f.workspace, 'script.sh')), false); assert.equal(existsSync(join(f.workspace, 'gone.txt')), false);
  assert.deepEqual(new Set(result.workspaceChangedPaths), new Set(['source.txt', 'nested/added.txt', 'moved.sh', 'script.sh', 'gone.txt']));
  const edit = f.tools.definitions.find(tool => tool.name === 'edit_workspace_file');
  assert.equal((await f.tools.execute({ sessionId: 'session', operationKey: 'follow-up', signal: new AbortController().signal,
    definition: edit, call: { name: edit.name, callId: 'follow-up', arguments: { path: 'source.txt', old_text: 'new', new_text: 'newer' } } })).status, 'ok');
});

test('a later invalid hunk leaves every file unchanged, including earlier adds/deletes', async t => {
  const f = setup(t); f.write('source.txt', 'old\n');
  const result = await f.call(patch('*** Add File: added.txt', '+first', '*** Delete File: source.txt',
    '*** Update File: other.txt', '@@', '-absent', '+new'));
  assert.equal(result.status, 'error'); assert.equal(result.content.executed, false);
  assert.equal(f.read('source.txt'), 'old\n'); assert.equal(existsSync(join(f.workspace, 'added.txt')), false);
  const hunk = await f.call(patch('*** Add File: added.txt', '+first', '*** Update File: source.txt', '@@', '-absent', '+new'));
  assert.equal(hunk.content.error_type, 'apply_patch_hunk_not_found'); assert.equal(existsSync(join(f.workspace, 'added.txt')), false);
});

test('upstream whitespace, Unicode, EOF and context hunk matching enter real publication', async t => {
  const f = setup(t); f.write('a.txt', 'header\n  const msg = “old”\nlast\n');
  const result = await f.call(patch('*** Update File: a.txt', '@@ header', '-const msg = "old"', '+const msg = "new"',
    '@@', '-last', '+end', '*** End of File'));
  assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(f.read('a.txt'), 'header\nconst msg = "new"\nend\n');
});

for (const [title, lines] of [
  ['empty', []], ['missing hunks', ['*** Update File: a.txt']],
  ['duplicate', ['*** Delete File: a.txt', '*** Add File: a.txt', '+replacement']],
  ['overlap', ['*** Add File: a', '+file', '*** Add File: a/nested', '+file']],
  ['occupied move destination', ['*** Update File: a.txt', '*** Move to: occupied.txt', '@@', '-old', '+new']],
  ['path escape', ['*** Add File: ../outside.txt', '+escape']],
]) test(`patch rejects ${title} before changing files`, async t => {
  const f = setup(t); f.write('a.txt', 'old\n'); f.write('occupied.txt', 'user content\n');
  const result = await f.call(patch(...lines)); assert.equal(result.status, 'error');
  assert.equal(f.read('a.txt'), 'old\n'); assert.equal(f.read('occupied.txt'), 'user content\n');
  assert.equal(existsSync(join(f.root, 'outside.txt')), false);
});

test('symlink aliases and a destination created during verification are refused', async t => {
  const f = setup(t); f.write('a.txt', 'old\n'); symlinkSync('a.txt', join(f.workspace, 'alias.txt'));
  assert.equal((await f.call(patch('*** Delete File: a.txt', '*** Delete File: alias.txt'))).content.error_type, 'patch_path_conflict');
  const race = setup(t); let changed = false;
  const result = await race.call(patch('*** Add File: created.txt', '+new'), { assertCurrent: () => {
    if (!changed) { race.write('created.txt', 'external\n'); changed = true; } return true;
  } });
  assert.equal(result.status, 'error'); assert.equal(race.read('created.txt'), 'external\n');
});

test('external edits during verification and cancellation retain every original file', async t => {
  const f = setup(t); f.write('a.txt', 'old\n'); let changed = false;
  const result = await f.call(patch('*** Update File: a.txt', '@@', '-old', '+new', '*** Add File: created.txt', '+new'), {
    assertCurrent: () => { if (!changed) { f.write('a.txt', 'external\n'); changed = true; } return true; },
  });
  assert.equal(result.content.error_type, 'file_modified_since_read'); assert.equal(f.read('a.txt'), 'external\n');
  assert.equal(existsSync(join(f.workspace, 'created.txt')), false);
  const g = setup(t), controller = new AbortController(); g.write('a.txt', 'old\n');
  const pending = g.call(patch('*** Update File: a.txt', '@@', '-old', '+new'), { signal: controller.signal });
  setTimeout(() => controller.abort(), 1); assert.equal((await pending).content.code, 'canceled'); assert.equal(g.read('a.txt'), 'old\n');
});

test('legacy ports have no patch executor and denied patches cannot publish', async t => {
  const legacy = setup(t, { enablePatches: false });
  assert.equal((await legacy.call(patch('*** Add File: a.txt', '+new'))).content.code, 'unknown_tool');
  const denied = setup(t, { authorize: async () => 'deny' });
  assert.equal((await denied.call(patch('*** Add File: a.txt', '+new'))).content.code, 'policy_denied');
  assert.equal(existsSync(join(denied.workspace, 'a.txt')), false);
});

test('SQLite cold approval resumes the exact original patch and commits it once', async t => {
  const f = setup(t, { authorize: async () => 'approval_required' }); f.write('a.txt', 'old\n');
  const filename = join(f.root, 'runs.sqlite'); let store = new SqliteRunStore(filename); t.after(() => store.close());
  const { config, snapshot } = fixture({ tools: f.tools.definitions });
  let calls = 0;
  const model = { generate: async () => ++calls === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ name: 'apply_workspace_patch', callId: 'patch',
    arguments: { patch_text: patch('*** Update File: a.txt', '@@', '-old', '+new', '*** Add File: added.txt', '+created') } }] }
    : { kind: 'final_candidate', text: 'Patched', toolCalls: [], usage: emptyUsage() } };
  const first = new NativeKernel({ store, digest, owner: 'first', ports: { model, tools: f.tools, workspace: f.tools } });
  first.start(snapshot, config); const waiting = await first.runUntilIdle(scope, 'run'); assert.equal(waiting.phase, 'awaiting_interaction');
  assert.equal(f.read('a.txt'), 'old\n'); store.close(); store = new SqliteRunStore(filename); const tools = f.create();
  const next = new NativeKernel({ store, digest, owner: 'replacement', ports: { model, tools, workspace: tools } });
  next.submit(scope, 'run', { commandId: 'approve', kind: 'submit_interaction', payload: { interactionId: waiting.pendingInteraction.interactionId, decision: 'allow' } });
  assert.equal((await next.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(f.read('a.txt'), 'new\n'); assert.equal(f.read('added.txt'), 'created\n');
  assert.equal(store.load(scope, 'run').receipts.filter(row => row.result.results?.[0]?.content?.files?.length === 2).length, 1);
  assert.equal((await next.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(calls, 2);
});

test('Plan mode rejects structured workspace patches before filesystem execution', async t => {
  const f = setup(t), store = new SqliteRunStore(join(f.root, 'plan.sqlite')); t.after(() => store.close());
  const { config, snapshot } = fixture({ tools: [...f.tools.definitions, ...planModeToolDefinitions()], planModePolicy: 'session-plan/v1', planModeInitialActive: true });
  let models = 0, effects = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'plan-worker', ports: { workspace: f.tools,
    tools: { ...f.tools, execute: async request => { effects++; return f.tools.execute(request); } },
    model: { generate: async () => ++models === 1
      ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ name: 'apply_workspace_patch', callId: 'patch',
        arguments: { patch_text: patch('*** Add File: forbidden.txt', '+must not appear') } }] }
      : { kind: 'final_candidate', text: 'Planning only', toolCalls: [], usage: emptyUsage() } },
  } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.planMode.active, true);
  assert.equal(effects, 0); assert.equal(existsSync(join(f.workspace, 'forbidden.txt')), false);
});

test('publication followed by a real state failure records uncertain paths and never blindly replays the patch', async t => {
  let f;
  f = setup(t, { authorize: async () => { const state = join(f.stateDir, sessionKeyFor('session')); mkdirSync(state, { recursive: true });
    mkdirSync(join(state, 'read-state.json')); return 'allow'; } });
  const store = new SqliteRunStore(join(f.root, 'runs.sqlite')); t.after(() => store.close());
  const { config, snapshot } = fixture({ tools: f.tools.definitions }); let calls = 0;
  const model = { generate: async () => { calls++; return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ name: 'apply_workspace_patch', callId: 'patch',
    arguments: { patch_text: patch('*** Add File: first.txt', '+first', '*** Add File: second.txt', '+second') } }] }; } };
  const kernel = new NativeKernel({ store, digest, owner: 'first', ports: { model, tools: f.tools, workspace: f.tools } });
  kernel.start(snapshot, config); const result = await kernel.runUntilIdle(scope, 'run'); assert.equal(result.phase, 'interrupted');
  assert.equal(result.reason, 'effect_outcome_unknown'); assert.equal(f.read('first.txt'), 'first\n'); assert.equal(existsSync(join(f.workspace, 'second.txt')), false);
  const receipt = store.load(scope, 'run').receipts.find(row => row.result.results?.[0]?.status === 'uncertain');
  assert.deepEqual(receipt.result.results[0].workspaceChangedPaths, ['first.txt']);
  const second = new NativeKernel({ store, digest, owner: 'second', ports: { model, tools: f.tools, workspace: f.tools } });
  assert.equal((await second.runUntilIdle(scope, 'run')).phase, 'interrupted'); assert.equal(calls, 1);
});
