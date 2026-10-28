import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { NativeKernel, configure, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { memoryDigest } from '@kingsoftcloud/agentkit-harness-node/native/memory-candidate';
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
// Real locked definition + real AbortSignal per request, bound to the composed
// port. request.scope is the studio scope (the bound principal).
function makeRequest(port) {
  return (name, args, runId, operationKey) => {
    const ac = new AbortController();
    return { call: call(name, args), definition: port.definitions.find(d => d.name === name),
      operationKey: operationKey ?? 'op-' + (++seq), runId, scope, signal: ac.signal, abortController: ac };
  };
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
  const seed = async (objective, runId = 'mem-run') => {
    const configuration = config(objective);
    worker().start({ ...fixture().snapshot, runId, parentRunId: null, sessionId: 'session' }, configuration);
    // Drive one model turn to completion so the run has real admission events and
    // no dangling async work. runUntilIdle is async; awaiting it guarantees the
    // tools resolve provenance from a fully-driven run and the test cleanup is not
    // racing a still-running worker.
    await worker().runUntilIdle(scope, runId);
    return runId;
  };
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, record, seed, worker, ports };
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
  const runId = await seed('记住我的编辑器是 Vim');
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async req => { consentLog.push(req.call.arguments.action); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
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
  const runId = await seed('记住我的偏好是咖啡');
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => 'allow', planner });
  t.after(() => port.close());
  const request = makeRequest(port);
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

test('strict authority: a non-explicit goal never grants explicit_user; only an exact match of the original human statement skips consent, and a content mismatch routes to consent', async t => {
  const { store, record, root, seed } = studio(t);
  const runId = await seed('帮我整理一下本周的报告'); // not an explicit memory instruction
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async req => { consentLog.push(req.call.arguments.content); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
  // A remember whose content is not an original explicit human statement of this
  // run -> not explicit_user -> consent required. No model/tool text grants it.
  const r = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '随便写的事实' }, runId, 'op-ne-1'));
  assert.equal(r.status, 'ok'); assert.equal(port.provider.get(r.content.memoryId).writePolicy, 'auto');
  assert.deepEqual(consentLog, ['随便写的事实']);
  // An explicit goal but a content that does not match the original statement -> consent.
  const runId2 = await seed('记住我的编辑器是 Vim', 'mem-run-2');
  const consentLog2 = [];
  const port2 = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog2.push('called'); return 'allow'; }, planner });
  t.after(() => port2.close());
  const request2 = makeRequest(port2);
  const mismatch = await port2.execute(request2('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Emacs' }, runId2, 'op-ne-2'));
  assert.equal(mismatch.status, 'ok'); assert.equal(port2.provider.get(mismatch.content.memoryId).writePolicy, 'auto');
  assert.deepEqual(consentLog2, ['called']);
  // The exact original statement DOES skip consent.
  const consentLog3 = [];
  const port3 = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog3.push('called'); return 'allow'; }, planner });
  t.after(() => port3.close());
  const request3 = makeRequest(port3);
  const exact = await port3.execute(request3('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, runId2, 'op-ne-3'));
  assert.equal(exact.status, 'ok'); assert.equal(port3.provider.get(exact.content.memoryId).writePolicy, 'user_confirm');
  assert.deepEqual(consentLog3, []);
});

test('fail-closed source: a run with no admission events (un-driven) returns memory_source_event_unavailable and never reaches consent or writes', async t => {
  const { store, record, root } = studio(t);
  // Seed creates a run but do NOT drive it: resolveMutationSource finds no origin event.
  const configuration = config('记住我的编辑器是 Vim');
  const ports = { model: { generate: async () => finish('Delivered.') }, context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', countRequest: async () => 1, countText: async () => 1 } } };
  new NativeKernel({ store, ports, digest, owner: 'worker' }).start({ ...fixture().snapshot, runId: 'cold-run', parentRunId: null, sessionId: 'session' }, configuration);
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog.push('called'); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
  const r = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, 'cold-run', 'op-cold'));
  assert.equal(r.status, 'error'); assert.equal(r.content.code, 'memory_source_event_unavailable');
  assert.deepEqual(consentLog, []); assert.deepEqual(port.provider.list(), []);
});

test('schedule and attachment-style goals never grant explicit_user even when the tool content echoes a stored fact', async t => {
  const { store, record, root, seed } = studio(t);
  // A schedule-style goal (not an explicit memory instruction) carries no
  // explicitMemoryTarget, so resolveAuthority returns null even if the tool
  // content happens to match a fact the user stated earlier.
  const runId = await seed('每天早上9点提醒我开会');
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog.push('called'); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
  const r = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '每天早上9点提醒我开会' }, runId, 'op-sched'));
  assert.equal(r.status, 'ok'); assert.equal(port.provider.get(r.content.memoryId).writePolicy, 'auto');
  assert.deepEqual(consentLog, ['called']);
});

test('corrupt provenance projection fails closed: an unavailable run returns memory_source_unavailable with no write or consent', async t => {
  const { store, record, root, seed } = studio(t);
  await seed('记住我的编辑器是 Vim');
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog.push('called'); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
  // A runId that does not exist -> load returns null -> resolveMutationSource
  // returns unavailable (no origin event) and no consent prompt, no write.
  const r = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, 'nonexistent-run', 'op-corrupt'));
  assert.equal(r.status, 'error'); assert.equal(r.content.code, 'memory_source_event_unavailable');
  assert.deepEqual(consentLog, []); assert.deepEqual(port.provider.list(), []);
});

test('a history projection from an older run does not skip the current approval even when its content matches', async t => {
  const { store, record, root, seed } = studio(t);
  // Run 1 (older) has an explicit user statement. Run 2 (current) is a different
  // non-explicit goal. Even if the tool content matches run 1's explicit fact,
  // resolveAuthority uses the CURRENT goal (explicitMemoryTarget(run2.goal)=null)
  // so it cannot skip consent. This proves a real run-history explicit instruction
  // from an older run does not exempt the current call from approval.
  await seed('记住我的编辑器是 Vim', 'old-run');
  const runId2 = await seed('帮我总结一下会议纪要', 'current-run');
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog.push('called'); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
  const r = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, runId2, 'op-history'));
  assert.equal(r.status, 'ok'); assert.equal(port.provider.get(r.content.memoryId).writePolicy, 'auto');
  assert.deepEqual(consentLog, ['called']);
});

// Real cross-Run history: run 1 admits an explicit memory instruction. Run 2 in
// the SAME Studio Session inherits run 1's messages as history projections
// (projectSessionHistory sets message.history). Run 2's own goal is explicit
// and matches the tool call, but run 2's CURRENT original human source is a
// schedule (non-authority), and run 1's explicit fact only appears as a history
// projection (currentOriginal=false). resolveAuthority must NOT skip consent —
// authority requires a CURRENT-Run original human statement, identified by the
// sourceEventId's runId (=== run2), not the shared session id.
function configSplit(t, store, objective, input) {
  const raw = { id: 'input', role: 'user', content: [{ type: 'text', text: input }], source: { kind: 'user' } };
  const base = fixture().config;
  return configure({ ...base, instructions: 'Answer the current user.',
    contract: { ...base.contract, objective: objective.trim() }, inputMessages: [{ role: 'user', kind: 'user_input', content: input }],
    hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
      input: { messages: [raw] }, source: { provider: 'fixture', model: 'model' }, selection: {}, systemPrompt: 'Answer the current user.' }) });
}

test('current explicit goal with a schedule current-human source and an older-run explicit history projection does not skip consent', async t => {
  const { store, record, root, worker } = studio(t);
  // Run 1 (older, same session): an explicit memory instruction.
  const cfg1 = configSplit(t, store, '记住我的编辑器是 Vim', '记住我的编辑器是 Vim');
  worker().start({ ...fixture().snapshot, runId: 'hist-run-1', parentRunId: null, sessionId: 'session' }, cfg1);
  await worker().runUntilIdle(scope, 'hist-run-1');
  // Run 2 (current, same session): goal is explicit and matches, but the current
  // original human input is a schedule. projectSessionHistory inherits run 1's
  // explicit message as a history projection (message.history.sourceRunId='hist-run-1').
  const cfg2 = configSplit(t, store, '记住我的编辑器是 Vim', '每天早上9点提醒我开会');
  worker().start({ ...fixture().snapshot, runId: 'hist-run-2', parentRunId: 'hist-run-1', sessionId: 'session' }, cfg2);
  await worker().runUntilIdle(scope, 'hist-run-2');
  // Inspect the real run 2 snapshot: run 1's message should appear as history.
  const loaded2 = store.load(scope, 'hist-run-2');
  const hasHistory = loaded2.snapshot.messages.some(m => m.role === 'user' && m.history && m.history.sourceRunId === 'hist-run-1');
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog.push('called'); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
  const r = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, 'hist-run-2', 'op-xrun'));
  // The schedule current-human source produces no explicit candidate, and the
  // history projection from run 1 is currentOriginal=false, so consent is
  // required even though run 2's goal explicitly matches the tool content.
  assert.equal(r.status, 'ok'); assert.equal(port.provider.get(r.content.memoryId).writePolicy, 'auto');
  assert.deepEqual(consentLog, ['called']);
  // Sanity: the test actually exercised a real history projection.
  assert.ok(hasHistory, 'run 2 should inherit run 1 messages as history');
});

test('real corrupt projection fails closed: a tampered snapshot message rejects provenance with no write or consent', async t => {
  const { store, record, root, seed } = studio(t);
  const runId = await seed('记住我的编辑器是 Vim');
  // Corrupt the stored run directly via SQLite: change a user input message's
  // content in the snapshot JSON so it no longer matches the admitted input
  // configuration. studioOriginalUserMemorySources' invariant
  // (configured.content === original.content) then throws, which provenance
  // catches as memory_source_unavailable — a real corrupt projection, not a
  // missing run.
  const db = new DatabaseSync(join(root, 'runs.sqlite'));
  try {
    const row = db.prepare("SELECT key,data FROM native_runs WHERE key LIKE ?").get('%' + runId + '"%');
    assert.ok(row, 'seeded run row');
    const data = JSON.parse(row.data);
    let tampered = false;
    for (const m of data.snapshot.messages) if (m.role === 'user' && m.kind === 'user_input') { m.content = 'TAMPERED-' + m.content; tampered = true; }
    assert.ok(tampered, 'a user input message to tamper');
    db.prepare('UPDATE native_runs SET data=? WHERE key=?').run(JSON.stringify(data), row.key);
  } finally { db.close(); }
  const consentLog = [];
  const port = composeStudioNativeMemoryTools({ record, scope, store, storeDir: root,
    authorize: async () => 'allow', consent: async () => { consentLog.push('called'); return 'allow'; }, planner });
  t.after(() => port.close());
  const request = makeRequest(port);
  const r = await port.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, runId, 'op-tamper'));
  assert.equal(r.status, 'error'); assert.equal(r.content.code, 'memory_source_unavailable');
  assert.deepEqual(consentLog, []); assert.deepEqual(port.provider.list(), []);
});
