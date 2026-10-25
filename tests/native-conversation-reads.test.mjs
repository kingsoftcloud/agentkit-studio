import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, projectSessionHistory } from '../packages/agentkit-harness-core/dist/index.mjs';
import { scope, fixture, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { createNativeWorkspaceTools } from '../packages/agentkit-harness/src/native/workspace-tools.mjs';
import { sessionKeyFor, WorkspaceStateStore } from '../packages/agentkit-harness/src/native/workspace-state.mjs';
import { nativeConversationReadStates } from '../src/providers/native-conversation-reads.mjs';

async function source(t, { partial = false, operation = 'read' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-retained-reads-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  if (operation !== 'write') writeFileSync(join(workspaceRoot, 'source.txt'), 'original\nsecond\n');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { workspaceRoot, stateDir: join(root, 'state'), sessionId: 'session', authorize: async () => 'allow' };
  const tools = createNativeWorkspaceTools(options), store = new MemoryRunStore();
  const { config, snapshot } = fixture({ tools: tools.definitions });
  let calls = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'source', ports: { tools, model: { generate: async request => {
    assert.doesNotMatch(JSON.stringify(request.messages), /nativeWorkspaceReads|native-workspace-read-observation/);
    ++calls;
    const call = calls === 1 ? operation === 'write'
      ? { callId: 'write', name: 'write_workspace_file', arguments: { path: 'source.txt', content: 'original\nsecond\n' } }
      : { callId: 'read', name: 'read_workspace_file', arguments: { path: 'source.txt', ...(partial ? { start_line: 2, end_line: 2 } : {}) } }
      : calls === 2 && operation === 'edit' ? { callId: 'edit', name: 'edit_workspace_file', arguments: { path: 'source.txt', old_text: 'original', new_text: 'edited' } } : null;
    return call ? { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [call] }
      : { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
  } } } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const record = store.load(scope, 'run'), seed = { messages: projectSessionHistory(record, config, digest, { identityNamespace: 'rewind' }) };
  const execute = (port, name, args) => port.execute({ scope, runId: 'test-edit', sessionId: 'session', operationKey: 'test-edit',
    signal: new AbortController().signal, call: { name, callId: 'edit', arguments: args }, definition: port.definitions.find(tool => tool.name === name) });
  const edit = (port, old_text = 'original', new_text = 'changed') => execute(port, 'edit_workspace_file', { path: 'source.txt', old_text, new_text });
  return { root, options, store, record, seed, execute, edit, reads: () => nativeConversationReadStates({ store, scope, seed }) };
}

const branch = { commandId: 'rewind', generation: 1 };

test('actual successful full Read receipts hydrate cold retained knowledge without leaking metadata or rewriting the source', async t => {
  const h = await source(t), reads = h.reads();
  assert.equal(reads.length, 1); assert.equal(typeof reads[0].mtimeNs, 'string'); assert.match(reads[0].contentSha256, /^[0-9a-f]{64}$/);
  const cold = createNativeWorkspaceTools(h.options); let restored = 0;
  cold.adoptConversationBranch(branch, () => { ++restored; return h.reads(); });
  assert.equal((await h.edit(cold)).status, 'ok'); assert.equal(restored, 1);
  const follow = createNativeWorkspaceTools(h.options);
  follow.adoptConversationBranch(branch, () => assert.fail('The already adopted generation must retain fresh reads'));
  assert.equal((await h.edit(follow, 'changed', 'follow')).status, 'ok');
  assert.deepEqual(h.store.load(scope, 'run'), h.record);
});

for (const operation of ['write', 'edit']) test(`successful ${operation} metadata restores the latest bytes that the retained branch authored`, async t => {
  const h = await source(t, { operation }), cold = createNativeWorkspaceTools(h.options);
  assert.equal(h.reads().length, 1);
  cold.adoptConversationBranch(branch, h.reads);
  assert.equal((await h.edit(cold, operation === 'edit' ? 'edited' : 'original', 'after-rewind')).status, 'ok');
  assert.match(readFileSync(join(h.options.workspaceRoot, 'source.txt'), 'utf8'), /after-rewind/);
  assert.deepEqual(h.store.load(scope, 'run'), h.record);
});

test('retained freshness does not certify an externally changed file or use a newer removed cache', async t => {
  const h = await source(t);
  writeFileSync(join(h.options.workspaceRoot, 'source.txt'), 'externally changed bytes');
  const current = createNativeWorkspaceTools(h.options);
  assert.equal((await h.execute(current, 'read_workspace_file', { path: 'source.txt' })).status, 'ok');
  current.adoptConversationBranch(branch, h.reads);
  const stale = await h.edit(current, 'externally', 'wrong');
  assert.equal(stale.status, 'error'); assert.equal(stale.content.error_type, 'file_modified_since_read');
  const persisted = JSON.parse(readFileSync(join(h.options.stateDir, sessionKeyFor('session'), 'read-state.json'), 'utf8'));
  assert.equal(persisted.entries['source.txt'].contentSha256, h.reads()[0].contentSha256);
  assert.equal(readFileSync(join(h.options.workspaceRoot, 'source.txt'), 'utf8'), 'externally changed bytes');
});

test('a partial historical Read is not promoted to full retained knowledge', async t => {
  const h = await source(t, { partial: true }); assert.deepEqual(h.reads(), []);
  const cold = createNativeWorkspaceTools(h.options); cold.adoptConversationBranch(branch, h.reads);
  assert.equal((await h.edit(cold)).content.error_type, 'file_not_read');
});

test('root cuts and unavailable source evidence cannot manufacture reads', async t => {
  const h = await source(t);
  assert.deepEqual(nativeConversationReadStates({ store: { load: () => assert.fail('Empty cut must not load a source') }, scope, seed: { messages: [] } }), []);
  assert.deepEqual(nativeConversationReadStates({ store: { load: () => { throw Object.assign(Error('Missing'), { code: 'run_not_found' }); } }, scope, seed: h.seed }), []);
  assert.deepEqual(nativeConversationReadStates({ store: h.store, scope, seed: { messages: h.seed.messages.filter(message => message.role !== 'tool') } }), []);
});

test('a later root rewind uses its own empty seed instead of replaying the first generation hydration', async t => {
  const h = await source(t), tools = createNativeWorkspaceTools(h.options);
  tools.adoptConversationBranch(branch, h.reads);
  assert.equal((await h.edit(tools)).status, 'ok');
  tools.adoptConversationBranch({ commandId: 'root', generation: 2 }, () => nativeConversationReadStates({
    store: h.store, scope, seed: { messages: [] } }));
  assert.equal((await h.edit(tools, 'changed', 'wrong')).content.error_type, 'file_not_read');
});

for (const problem of ['uncertain', 'uncommitted', 'uncertain-result', 'error', 'unread', 'changed-context', 'invalid-state', 'wrong-tool'])
  test(`${problem}: a retained-looking result cannot restore invalid or unknown observations`, async t => {
    const h = await source(t), altered = structuredClone(h.record);
    const receipt = altered.receipts.find(row => row.result.results), result = receipt.result.results[0];
    if (problem === 'uncertain') receipt.status = 'uncertain';
    if (problem === 'uncommitted') altered.receipts = altered.receipts.filter(row => row !== receipt);
    if (problem === 'uncertain-result') result.status = 'uncertain';
    if (problem === 'error') result.status = 'error';
    if (problem === 'unread') result.sourceObservationState = 'unread';
    if (problem === 'changed-context') result.context = { content: 'filtered' };
    if (problem === 'invalid-state') result.metadata.nativeWorkspaceReads.states[0].contentSha256 = 'invalid';
    if (problem === 'wrong-tool') result.metadata.nativeWorkspaceReads.tool = 'untrusted-external-tool';
    assert.deepEqual(nativeConversationReadStates({ store: { load: () => altered }, scope, seed: h.seed }), []);
  });

test('retained states from a different canonical workspace cannot authorize the new workspace', async t => {
  const h = await source(t), otherRoot = join(h.root, 'other'); mkdirSync(otherRoot); writeFileSync(join(otherRoot, 'source.txt'), 'original');
  const other = createNativeWorkspaceTools({ ...h.options, workspaceRoot: otherRoot });
  other.adoptConversationBranch(branch, h.reads);
  assert.equal((await h.edit(other)).content.error_type, 'file_not_read');
  assert.throws(() => nativeConversationReadStates({ store: { load: () => ({ ...h.record, snapshot: { ...h.record.snapshot,
    scope: { ...scope, workspaceId: 'different' } } }) }, scope, seed: h.seed }), { code: 'native_conversation_read_scope_mismatch' });
});

test('a failed branch-state publication is retried instead of being treated as already adopted', async t => {
  const h = await source(t), state = new WorkspaceStateStore(h.options.stateDir, 'session');
  const persist = state._persistReadState; let failed = false, restores = 0;
  state._persistReadState = function () { if (!failed) { failed = true; throw Error('Injected state publication failure'); } return persist.call(this); };
  const restore = () => { ++restores; return h.reads(); };
  assert.throws(() => state.adoptConversationBranch(branch, restore), /Injected/);
  assert.equal(state._conversationBranch, undefined);
  state.adoptConversationBranch(branch, restore);
  assert.equal(restores, 2); assert.deepEqual(state._conversationBranch, branch);
  assert.equal(state.getReadState('source.txt').contentSha256, h.reads()[0].contentSha256);
});
