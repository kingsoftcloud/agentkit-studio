import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, configure, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { memoryDigest } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
import { composeStudioNativeMemoryTools, explicitMemoryTarget } from '../src/providers/native-memory-tools.mjs';

const finish = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
function config(text, source = { kind: 'user' }) {
  const raw = { id: 'input', role: 'user', content: [{ type: 'text', text }], ...(source ? { source } : {}) };
  const base = fixture().config;
  return configure({ ...base, instructions: 'Answer the current user.',
    contract: { ...base.contract, objective: text.trim() }, inputMessages: [{ role: 'user', kind: 'user_input', content: text }],
    hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
      input: { messages: [raw] }, source: { provider: 'fixture', model: 'model' }, selection: {}, systemPrompt: 'Answer the current user.' }) });
}
const planner = { countMessage: message => Math.ceil(JSON.stringify(message).length / 4) };
let seq = 0;
function call(name, args) { return { name, arguments: args, callId: 'call-' + ++seq }; }
function request(name, args, runId, operationKey) {
  return { call: call(name, args), operationKey: operationKey ?? 'op-' + (++seq), runId, scope, signal: { throwIfAborted() {} } };
}

function studio(t, spec = { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
  scopes: ['user'], write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: true } },
  context: { rollout: { memoryWrite: 'enabled' } } }) {
  const root = mkdtempSync(join(tmpdir(), 'studio-memory-tools-')), store = new SqliteRunStore(join(root, 'runs.sqlite'));
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec };
  const ports = { model: { generate: async () => finish('Delivered.') }, context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
    countRequest: async request => Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4),
    countText: async request => Math.ceil(request.text.length / 4) } } };
  const worker = () => new NativeKernel({ store, ports, digest, owner: 'worker' });
  const seed = objective => {
    const configuration = config(objective);
    worker().start({ ...fixture().snapshot, runId: 'mem-run', parentRunId: null, sessionId: 'session' }, configuration);
    // Drive one model turn so the run has real admission events; the memory tools
    // resolve provenance from the latest actual Run event, not an invented one.
    worker().runUntilIdle(scope, 'mem-run');
    return 'mem-run';
  };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, record, seed };
}

test('explicitMemoryTarget decodes one whole explicit goal without truncating its requested fact', () => {
  assert.deepEqual(explicitMemoryTarget('记住我的编辑器是 Vim'), ['add', '我的编辑器是 Vim']);
  assert.deepEqual(explicitMemoryTarget('我喜欢用Neovim，而不是Vim。'), ['update', '我喜欢用Neovim']);
  assert.deepEqual(explicitMemoryTarget('Remember that my editor is Vim.'), ['add', 'my editor is Vim']);
  assert.equal(explicitMemoryTarget('For this session remember my editor is Vim'), null); // session-only
  assert.equal(explicitMemoryTarget('随便一句话，不是记忆指令'), null); // not explicit
  assert.equal(explicitMemoryTarget(''), null); assert.equal(explicitMemoryTarget(null), null);
});

test('composeStudioNativeMemoryTools is gated by enabled, local-default provider and non-empty scopes', t => {
  const { record, store, root } = studio(t);
  const base = { record, scope, store, storeDir: root, authorize: async () => 'allow', consent: async () => 'allow', planner };
  assert.equal(composeStudioNativeMemoryTools({ ...base, record: { ...record, spec: { ...record.spec, memory: { enabled: false } } } }), null);
  assert.equal(composeStudioNativeMemoryTools({ ...base, record: { ...record, spec: { ...record.spec, memory: { enabled: true, providerRef: 'cloud-http' } } } }), null);
  assert.equal(composeStudioNativeMemoryTools({ ...base, record: { ...record, spec: { ...record.spec, memory: { enabled: true, providerRef: 'local-default', scopes: [] } } } }), null);
  const composed = composeStudioNativeMemoryTools(base);
  assert.ok(composed); assert.equal(composed.contract, 'agentkit.native-memory-tools/v1');
  assert.ok(composed.definitions.some(d => d.name === 'manage_memory'));
  composed.close();
});

test('composed port resolves explicit authority from the actual admitted goal: an exact match skips consent, a mismatch and forget route to consent', async t => {
  const { store, record, root, seed } = studio(t);
  const runId = seed('记住我的编辑器是 Vim');
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async req => { consentLog.push(req.call.arguments.action); return 'allow'; }, planner });
  t.after(() => port.close());
  // Exact explicit content -> explicit_user authority, consent NOT called, user_confirm fact.
  const exact = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, runId, 'op-exact'));
  assert.equal(exact.status, 'ok'); assert.equal(exact.content.committed, true);
  assert.equal(port.provider.get(exact.content.memoryId).writePolicy, 'user_confirm');
  assert.deepEqual(consentLog, []);
  // Mismatched content -> not explicit -> consent called -> approved_call -> auto fact.
  const mismatch = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '别的内容' }, runId, 'op-mismatch'));
  assert.equal(mismatch.status, 'ok'); assert.equal(port.provider.get(mismatch.content.memoryId).writePolicy, 'auto');
  assert.deepEqual(consentLog, ['remember']);
  // Forget never qualifies as explicit even when the goal mentions the fact -> consent called.
  const forget = await port.execute(request('manage_memory', { action: 'forget', scope: 'user', memory_id: exact.content.memoryId, expected_version: 1 }, runId, 'op-forget'));
  assert.equal(forget.status, 'ok'); assert.equal(forget.content.status, 'deleted');
  assert.deepEqual(consentLog, ['remember', 'forget']);
  // read_memory returns the current (deleted) record and untrusted projection.
  const read = await port.execute(request('read_memory', { memory_id: exact.content.memoryId }, runId, 'op-read'));
  assert.equal(read.status, 'ok'); assert.equal(read.content.trustLevel, 'untrusted');
  assert.equal(read.content.record.status, 'deleted'); assert.equal(read.content.record.version, 2);
});

test('composed port reconcile verifies a committed receipt against the current fact after a real run', async t => {
  const { store, record, root, seed } = studio(t);
  const runId = seed('记住我的偏好是咖啡');
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => 'allow', planner });
  t.after(() => port.close());
  const rememberReq = request('manage_memory', { action: 'remember', scope: 'user', content: '我的偏好是咖啡' }, runId, 'op-rec');
  const remembered = await port.execute(rememberReq);
  assert.equal(remembered.content.committed, true);
  const ok = await port.reconcile(rememberReq);
  assert.equal(ok.status, 'ok'); assert.equal(ok.content.consistent, true);
  assert.equal(ok.content.receipt.memoryId, remembered.content.memoryId);
  // Correct changes the current fact; the old receipt is now stale, not proof of current data.
  await port.execute(request('manage_memory', { action: 'correct', scope: 'user', memory_id: remembered.content.memoryId, expected_version: 1, content: '我的偏好是茶' }, runId, 'op-correct'));
  const stale = await port.reconcile(rememberReq);
  assert.equal(stale.content.status, 'stale'); assert.equal(stale.content.consistent, false);
  assert.equal(stale.content.current.version, 2); assert.equal(stale.content.receipt.version, 1);
  // An operation key that never ran is uncertain and never redone.
  const unknown = await port.reconcile(request('manage_memory', { action: 'remember', scope: 'user', content: 'never' }, runId, 'op-never'));
  assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.content.retryability, 'requires_reconcile');
});
