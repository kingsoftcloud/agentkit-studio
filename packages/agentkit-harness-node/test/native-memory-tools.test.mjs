import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical } from '../../agentkit-harness-core/dist/index.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeUserMemoryCandidate } from '../src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../src/native/memory-store.mjs';
import { buildNativeMemoryTools, nativeMemoryToolDefinitions, nativeMemoryLockedDigest,
  nativeMemoryRequestDigest, NATIVE_MEMORY_TOOLS_CONTRACT } from '../src/native/memory-tools.mjs';

const principal = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', userId: 'user' };
const lockedDigest = nativeMemoryLockedDigest({ providerRef: 'local-default',
  memoryPolicy: { scopes: ['user'] }, contextSpec: {} });
const source = { sourceSessionId: 'session', sourceEventId: 'event-1',
  sourceGoalRevision: '0', sourceGoalDigest: memoryDigest('remember my editor is Vim'), horizon: [] };
const planner = { countMessage: message => Math.ceil(JSON.stringify(message).length / 4) };
const userBinding = nativeMemoryScopeBindings(principal, ['user'])[0];

function policy(overrides = {}) {
  return { enabled: true, providerRef: 'local-default', scopes: ['user'],
    recall: { enabled: true, maxTokens: 1600, topK: 8, minScore: .45 },
    write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: true },
    rollout: 'enabled', ...overrides };
}
let seq = 0;
function call(name, args) { return { name, arguments: args, callId: 'call-' + ++seq }; }

function build({ policy: p = policy(), provider, authorize, consent, resolveAuthority, resolveMutationSource, planner: pPlanner } = {}) {
  const store = provider ?? new SqliteNativeMemoryProvider(':memory:', { principal, scopes: p.scopes });
  const consentLog = [];
  const tools = buildNativeMemoryTools({ policy: p, principal, lockedDigest, provider: store,
    authorize: authorize ?? (async () => 'allow'),
    consent: consent ?? (async req => { consentLog.push(req.call.name); return 'allow'; }),
    planner: pPlanner ?? planner, resolveAuthority: resolveAuthority ?? (() => null),
    resolveMutationSource: resolveMutationSource ?? (() => source) });
  // Real locked formal definition + real AbortSignal per request. A request must
  // carry the exact locked definition and the bound principal, with a real
  // cancellable signal; the binding checks reject a forged/missing definition,
  // a foreign scope, or a fake signal before any authorize/read.
  const def = name => tools.definitions.find(d => d.name === name);
  const req = (name, args, extra = {}) => {
    const ac = extra.abortController ?? new AbortController();
    return { call: call(name, args), definition: def(name), operationKey: extra.operationKey ?? 'op-' + randomUUID(),
      runId: 'run', scope: principal, signal: ac.signal, abortController: ac, ...extra };
  };
  return { tools, store, consentLog, req, def };
}
function rows(filename, table = 'memory_records') {
  const db = new DatabaseSync(filename); try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); }
}
function sql(filename, statement) { const db = new DatabaseSync(filename); try { db.exec(statement); } finally { db.close(); } }

test('definitions bind to the Build: every definition carries the locked digest and search is independent of the recall toggle', () => {
  const defs = nativeMemoryToolDefinitions({ policy: policy({ recall: { enabled: false, maxTokens: 1600, topK: 8, minScore: .45 } }), lockedDigest });
  assert.deepEqual(defs.map(d => d.name), ['read_memory', 'search_memory', 'manage_memory']);
  for (const d of defs) assert.equal(d.executionPolicyDigest, lockedDigest);
  assert.equal(defs[0].readOnly, true); assert.equal(defs[0].recoveryPolicy, 'safe-read/v1');
  assert.equal(defs[1].readOnly, true); assert.equal(defs[2].readOnly, false);
  assert.deepEqual(defs[2].parameters.properties.scope.enum, ['user']);
  assert.deepEqual(nativeMemoryToolDefinitions({ policy: policy({ recall: { enabled: true, maxTokens: 0, topK: 8, minScore: .45 } }), lockedDigest }).map(d => d.name), ['read_memory', 'manage_memory']);
  assert.deepEqual(nativeMemoryToolDefinitions({ policy: policy({ write: { mode: 'off', flushBeforeCompaction: true, flushAfterTurn: true } }), lockedDigest }).map(d => d.name), ['read_memory', 'search_memory']);
  assert.deepEqual(nativeMemoryToolDefinitions({ policy: policy({ rollout: 'off' }), lockedDigest }).map(d => d.name), ['read_memory', 'search_memory']);
});

test('binding checks: a forged or missing definition, foreign scope, or fake signal is rejected before authorize/read', async () => {
  const { tools, store, consentLog, req, def } = build({ authorize: async () => 'allow' });
  // Forged readOnly:true in request.definition -> rejected; consent never reached.
  const forged = await tools.execute({ ...req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'b1' }),
    definition: { ...def('manage_memory'), readOnly: true } });
  assert.equal(forged.status, 'error'); assert.equal(forged.content.code, 'native_memory_definition_unbound');
  assert.deepEqual(consentLog, []);
  // Forged permissions/parameters also rejected.
  const forgedPerms = await tools.execute({ ...req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'b2' }),
    definition: { ...def('manage_memory'), permissions: ['memory:admin'] } });
  assert.equal(forgedPerms.content.code, 'native_memory_definition_unbound');
  // Missing definition entirely.
  const noDef = await tools.execute({ ...req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'b3' }), definition: undefined });
  assert.equal(noDef.content.code, 'native_memory_definition_unbound');
  // Foreign scope (not the bound principal) -> rejected.
  const foreignScope = await tools.execute({ ...req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'b4' }),
    scope: { ...principal, userId: 'foreign' } });
  assert.equal(foreignScope.content.code, 'native_memory_scope_unbound');
  // Fake signal (not an AbortSignal) -> rejected.
  const fakeSignal = await tools.execute({ ...req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'b5' }),
    signal: { throwIfAborted() {} } });
  assert.equal(fakeSignal.content.code, 'native_memory_signal_unbound');
  // Missing callId -> rejected.
  const noCallId = await tools.execute({ ...req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'b6' }),
    call: { name: 'manage_memory', arguments: { action: 'remember', scope: 'user', content: 'X' } } });
  assert.equal(noCallId.content.code, 'native_memory_request_unbound');
  // Unknown tool name -> unbound.
  const unknown = await tools.execute({ ...req('read_memory', { memory_id: 'm' }, { operationKey: 'b7' }),
    call: { name: 'manage_workspace', arguments: {}, callId: 'c' }, definition: def('read_memory') });
  assert.equal(unknown.content.code, 'native_memory_tool_unbound');
  assert.deepEqual(store.list(), []); assert.deepEqual(consentLog, []);
  store.close();
});

test('a late allowance arriving after cancellation does not trigger the mutation', async () => {
  const { tools, store, req } = build({ authorize: async () => 'allow' });
  const r = req('manage_memory', { action: 'remember', scope: 'user', content: 'Cancelled fact' }, { operationKey: 'late-1' });
  r.abortController.abort(); // cancelled before dispatch
  await assert.rejects(tools.execute(r), /aborted/i);
  assert.deepEqual(store.list(), []);
  // Even an authorize that returns allow after the signal is aborted cannot write.
  const { tools: tools2, store: store2, req: req2 } = build({ authorize: async request => { request.signal; return 'allow'; } });
  const r2 = req2('manage_memory', { action: 'remember', scope: 'user', content: 'Late fact' }, { operationKey: 'late-2' });
  // Abort during the authorize await, then return allow.
  const ac = r2.abortController;
  const { tools: tools3, store: store3 } = build({ provider: store2, authorize: async () => { ac.abort(); return 'allow'; } });
  await assert.rejects(tools3.execute(r2), /aborted/i);
  assert.deepEqual(store2.list(), []); assert.deepEqual(store3.list(), []);
  store.close(); store2.close();
});

test('deferred authorization drift: mutating call arguments, operationKey, definition or scope during the authorize await rejects with no write', async () => {
  // The caller mutates ITS OWN request object during the async authorize window
  // (e.g. a racing re-dispatch). The approved identity is captured before the
  // await, so the drift is detected and the write is refused — not silently
  // recomputed with the changed arguments.
  let target;
  const { tools, store, req } = build({ resolveAuthority: () => null,
    authorize: async request => { request.signal; // simulate caller-side mutation of the live request
      target.call.arguments.content = 'Hijacked'; return 'allow'; } });
  target = req('manage_memory', { action: 'remember', scope: 'user', content: 'Original' }, { operationKey: 'drift-args' });
  const res = await tools.execute(target);
  assert.equal(res.status, 'error'); assert.equal(res.content.code, 'native_memory_request_drifted_after_authorize');
  assert.equal(res.content.executed, false); assert.deepEqual(store.list(), []);
  store.close();
  // operationKey mutation during consent await.
  let target2;
  const { tools: t2, store: s2 } = build({ resolveAuthority: () => null,
    consent: async request => { request.signal; target2.operationKey = 'drifted-key'; return 'allow'; } });
  const mk2 = (n, a, op) => { const ac = new AbortController(); return { call: { name: n, arguments: a, callId: 'c-' + op }, definition: t2.definitions.find(d => d.name === n), operationKey: op, runId: 'run', scope: principal, signal: ac.signal, abortController: ac }; };
  target2 = mk2('manage_memory', { action: 'remember', scope: 'user', content: 'Original2' }, 'drift-key');
  const res2 = await t2.execute(target2);
  assert.equal(res2.status, 'error'); assert.equal(res2.content.executed, false);
  assert.equal(res2.content.code, 'native_memory_request_drifted_after_consent');
  assert.deepEqual(s2.list(), []); s2.close();
  // scope mutation during authorize await.
  let target3;
  const { tools: t3, store: s3 } = build({ resolveAuthority: () => null,
    authorize: async request => { request.signal; target3.scope = { ...principal, userId: 'foreign' }; return 'allow'; } });
  const mk3 = (n, a, op) => { const ac = new AbortController(); return { call: { name: n, arguments: a, callId: 'c-' + op }, definition: t3.definitions.find(d => d.name === n), operationKey: op, runId: 'run', scope: principal, signal: ac.signal, abortController: ac }; };
  target3 = mk3('manage_memory', { action: 'remember', scope: 'user', content: 'Original3' }, 'drift-scope');
  const res3 = await t3.execute(target3);
  assert.equal(res3.content.code, 'native_memory_request_drifted_after_authorize');
  assert.deepEqual(s3.list(), []); s3.close();
});

test('a callback cannot poison the internal locked formal definition: mutating the definition it receives does not weaken later requests', async () => {
  const { tools, store, req, def } = build({ resolveAuthority: () => null,
    authorize: async request => { request.signal; // Try to weaken the locked formal via the copy it received.
      request.definition.readOnly = true; request.definition.permissions = ['memory:admin']; return 'allow'; } });
  const r = req('manage_memory', { action: 'remember', scope: 'user', content: 'Poison test' }, { operationKey: 'poison-1' });
  const res = await tools.execute(r);
  // The mutation reached only the isolated copy; the internal formal is untouched,
  // so the request still resolves (the mutated copy is not re-read) and writes.
  assert.equal(res.status, 'ok'); assert.equal(res.content.committed, true);
  // A subsequent request still sees the original locked formal (readOnly:false).
  const manageDef = tools.definitions.find(d => d.name === 'manage_memory');
  assert.equal(manageDef.readOnly, false); assert.deepEqual(manageDef.permissions, ['memory:write']);
  // The poisoned copy did not leak into binding checks: a fresh forged readOnly:true
  // request is still rejected.
  const forged = await tools.execute({ ...req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'poison-2' }),
    definition: { ...def('manage_memory'), readOnly: true } });
  assert.equal(forged.content.code, 'native_memory_definition_unbound');
  store.close();
});

// Reproduces the parent review probe (memory-tools-review-probe.mjs): replacing
// request.definition with a forged readOnly:true, changing request.runId, and a
// shadow authorize flipping the bound policy's rollout all fail closed.
test('probe: replacing request.definition with readOnly:true during authorize rejects no write', async () => {
  let target;
  const { tools, store, req, def } = build({ resolveAuthority: () => null,
    authorize: async () => { target.definition = { ...def('manage_memory'), readOnly: true }; return 'allow'; } });
  target = req('manage_memory', { action: 'remember', scope: 'user', content: 'My editor is Vim' }, { operationKey: 'probe-def' });
  const res = await tools.execute(target);
  assert.equal(res.status, 'error'); assert.equal(res.content.code, 'native_memory_request_drifted_after_authorize');
  assert.equal(res.content.executed, false); assert.deepEqual(store.list(), []);
  store.close();
});

test('probe: changing request.runId during authorize rejects no write', async () => {
  let target;
  const { tools, store, req } = build({ resolveAuthority: () => null,
    authorize: async () => { target.runId = 'other-run'; return 'allow'; } });
  target = req('manage_memory', { action: 'remember', scope: 'user', content: 'My editor is Vim' }, { operationKey: 'probe-runid' });
  const res = await tools.execute(target);
  assert.equal(res.status, 'error'); assert.equal(res.content.code, 'native_memory_request_drifted_after_authorize');
  assert.equal(res.content.executed, false); assert.deepEqual(store.list(), []);
  store.close();
});

test('probe: a shadow authorize flipping the bound policy rollout cannot enable a write (policy is snapshotted)', async () => {
  const p = policy({ rollout: 'shadow' });
  const { tools, store, req } = build({ policy: p, resolveAuthority: () => null,
    authorize: async () => { p.rollout = 'enabled'; return 'allow'; } });
  const res = await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'My editor is Vim' }, { operationKey: 'probe-policy' }));
  // The bound policy was snapshotted as shadow at construction; mutating the
  // original p afterwards does not change the port's bound policy. Shadow cannot
  // write, so this returns a non-committing shadow decision, not an exception.
  assert.equal(res.status, 'ok'); assert.equal(res.content.committed, false);
  assert.equal(res.content.decision, 'shadow'); assert.deepEqual(store.list(), []);
  store.close();
});

test('read_memory returns the current version, hash, status and scope; unknown ids are not found in scope', async () => {
  const { tools, store, req } = build({ resolveAuthority: () => 'explicit_user' });
  const remember = await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'My editor is Vim' }, { operationKey: 'remember-1' }));
  const id = remember.content.memoryId;
  const read = await tools.execute(req('read_memory', { memory_id: id }, { operationKey: 'read-1' }));
  assert.equal(read.status, 'ok'); assert.equal(read.content.code, null); assert.equal(read.content.trustLevel, 'untrusted');
  assert.equal(read.content.record.memoryId, id); assert.equal(read.content.record.version, 1);
  assert.equal(read.content.record.status, 'active'); assert.equal(read.content.record.contentHash, memoryDigest('My editor is Vim'));
  assert.equal(read.content.record.scope, 'user');
  const missing = await tools.execute(req('read_memory', { memory_id: 'memory_unknown' }, { operationKey: 'read-2' }));
  assert.equal(missing.status, 'error'); assert.equal(missing.content.code, 'memory_not_found_in_scope');
  const foreign = new SqliteNativeMemoryProvider(':memory:', { principal: { ...principal, userId: 'foreign' }, scopes: ['user'] });
  try { assert.equal(foreign.get(id), null); } finally { foreign.close(); }
  store.close();
});

test('remember with explicit_user authority persists a user_confirm fact; approved_call persists an auto fact', async () => {
  const explicit = build({ resolveAuthority: () => 'explicit_user' });
  const a = await explicit.tools.execute(explicit.req('manage_memory', { action: 'remember', scope: 'user', content: '记住的显式事实' }, { operationKey: 'op-a' }));
  assert.equal(a.status, 'ok'); assert.equal(a.content.committed, true); assert.equal(a.content.action, 'remember');
  assert.equal(a.content.version, 1); assert.match(a.content.memoryId, /^memory_[0-9a-f-]+$/u);
  assert.equal(explicit.store.get(a.content.memoryId).writePolicy, 'user_confirm');
  assert.equal(explicit.store.get(a.content.memoryId).metadata.authority, 'explicit_user');
  const approved = build({ resolveAuthority: () => null });
  const b = await approved.tools.execute(approved.req('manage_memory', { action: 'remember', scope: 'user', content: '审批后的事实' }, { operationKey: 'op-b' }));
  assert.equal(b.content.committed, true); assert.equal(approved.store.get(b.content.memoryId).writePolicy, 'auto');
  assert.equal(approved.store.get(b.content.memoryId).metadata.authority, 'approved_call');
  explicit.store.close(); approved.store.close();
});

test('correct and forget are strict expected_version CAS; a stale version conflicts with a read-before-retry next action', async () => {
  const { tools, store, req } = build({ resolveAuthority: () => 'explicit_user' });
  const remember = await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'Vim' }, { operationKey: 'r' }));
  const id = remember.content.memoryId;
  const correct = await tools.execute(req('manage_memory', { action: 'correct', scope: 'user', memory_id: id, expected_version: 1, content: 'Neovim' }, { operationKey: 'c1' }));
  assert.equal(correct.status, 'ok'); assert.equal(correct.content.version, 2);
  assert.equal(correct.content.contentHash, memoryDigest('Neovim'));
  assert.equal(store.get(id).content, 'Neovim');
  const stale = await tools.execute(req('manage_memory', { action: 'correct', scope: 'user', memory_id: id, expected_version: 1, content: 'Emacs' }, { operationKey: 'c2' }));
  assert.equal(stale.status, 'error'); assert.equal(stale.content.code, 'memory_version_or_identity_conflict');
  assert.equal(stale.content.next_action, 'read_memory_before_retry');
  const forget = await tools.execute(req('manage_memory', { action: 'forget', scope: 'user', memory_id: id, expected_version: 2 }, { operationKey: 'f1' }));
  assert.equal(forget.status, 'ok'); assert.equal(forget.content.status, 'deleted');
  assert.equal(store.get(id).content, ''); assert.equal(store.get(id).version, 3);
  assert.equal((await tools.execute(req('manage_memory', { action: 'forget', scope: 'user', memory_id: id, expected_version: 3, content: 'leak' }, { operationKey: 'f2' }))).content.code, 'invalid_memory_action_arguments');
  assert.equal((await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'x', memory_id: id }, { operationKey: 'r2' }))).content.code, 'invalid_memory_action_arguments');
  store.close();
});

test('authorization: a recognized explicit user command skips consent; everything else, including forget, routes to consent; approval_required passes through the Native interaction boundary', async () => {
  const explicit = build({ resolveAuthority: req => req.call.arguments.action === 'remember' ? 'explicit_user' : null });
  await explicit.tools.execute(explicit.req('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'e1' }));
  assert.deepEqual(explicit.consentLog, []);
  const denied = build({ resolveAuthority: () => null, consent: async () => ({ status: 'approval_required', interactionId: 'int-1' }) });
  const d = await denied.tools.execute(denied.req('manage_memory', { action: 'remember', scope: 'user', content: 'Y' }, { operationKey: 'e2' }));
  assert.equal(d.status, 'approval_required'); assert.equal(d.interactionId, 'int-1');
  assert.equal(denied.store.list().length, 0);
  denied.store.close();
  const baseDenied = build({ authorize: async () => 'deny', resolveAuthority: () => 'explicit_user' });
  const bd = await baseDenied.tools.execute(baseDenied.req('manage_memory', { action: 'remember', scope: 'user', content: 'Z' }, { operationKey: 'e3' }));
  assert.equal(bd.status, 'error'); assert.equal(bd.content.code, 'policy_denied');
  assert.deepEqual(baseDenied.consentLog, []); assert.equal(baseDenied.store.list().length, 0);
  baseDenied.store.close();
  explicit.store.close();
});

test('shadow rollout cannot write: manage_memory is read-only and returns a non-committing shadow decision; the store is untouched', async () => {
  const { tools, store, req } = build({ policy: policy({ rollout: 'shadow' }) });
  const manage = tools.definitions.find(d => d.name === 'manage_memory');
  assert.equal(manage.readOnly, true);
  const shadow = await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'shadow fact' }, { operationKey: 's1' }));
  assert.equal(shadow.status, 'ok'); assert.equal(shadow.content.committed, false);
  assert.equal(shadow.content.decision, 'shadow'); assert.equal(shadow.content.reason, 'shadow_rollout_no_write');
  assert.deepEqual(store.list(), []);
  const read = await tools.execute(req('read_memory', { memory_id: 'memory_none' }, { operationKey: 's2' }));
  assert.equal(read.content.code, 'memory_not_found_in_scope');
  store.close();
});

test('the same operation key and call is idempotent; a reused key with different arguments conflicts', async () => {
  const { tools, store, req } = build({ resolveAuthority: () => 'explicit_user' });
  const r = req('manage_memory', { action: 'remember', scope: 'user', content: 'Idempotent fact' }, { operationKey: 'idem-1' });
  const first = await tools.execute(r);
  const replay = await tools.execute(r);
  assert.deepEqual(replay.content, first.content); assert.equal(replay.status, 'ok');
  assert.equal(store.list().length, 1);
  const conflict = await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'Different fact' }, { operationKey: 'idem-1' }));
  assert.equal(conflict.status, 'error'); assert.equal(conflict.content.code, 'memory_version_or_identity_conflict');
  assert.equal(conflict.content.next_action, 'read_memory_before_retry');
  assert.equal(store.list().length, 1);
  store.close();
});

test('search_memory counts the whole provenance envelope against the token budget, trims and flags truncation, and fails closed on a too-small budget', async () => {
  const { tools, store, req } = build({ resolveAuthority: () => 'explicit_user', policy: policy({ recall: { enabled: false, maxTokens: 8000, topK: 8, minScore: .45 } }) });
  for (let i = 0; i < 6; i++) await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'Editor fact number ' + i }, { operationKey: 'seed-' + i }));
  const full = await tools.execute(req('search_memory', { query: 'Editor fact' }, { operationKey: 'search-1' }));
  assert.equal(full.status, 'ok'); assert.equal(full.content.trustLevel, 'untrusted');
  assert.equal(full.content.format, 'ksadk.memory-search/v1'); assert.equal(full.content.budgetSkipped, 0);
  assert.equal(full.content.records.length, 6);
  const tight = build({ resolveAuthority: () => 'explicit_user', policy: policy({ recall: { enabled: false, maxTokens: 400, topK: 8, minScore: 0 } }), provider: store });
  const trimmed = await tight.tools.execute(req('search_memory', { query: 'Editor fact' }, { operationKey: 'search-2' }));
  assert.equal(trimmed.status, 'ok'); assert.ok(trimmed.content.truncated); assert.ok(trimmed.content.budgetSkipped > 0);
  assert.ok(trimmed.content.records.length >= 1 && trimmed.content.records.length < full.content.records.length);
  const tiny = build({ resolveAuthority: () => 'explicit_user', policy: policy({ recall: { enabled: false, maxTokens: 1, topK: 8, minScore: 0 } }), provider: store });
  const closed = await tiny.tools.execute(req('search_memory', { query: 'Editor fact' }, { operationKey: 'search-3' }));
  assert.equal(closed.status, 'error'); assert.equal(closed.content.code, 'memory_search_budget_too_small');
  assert.equal((await tools.execute(req('search_memory', { query: '   ' }, { operationKey: 'search-4' }))).content.code, 'memory_search_query_missing');
  store.close();
});

test('reconcile verifies a sealed receipt against the current fact; an old receipt is stale after correction and a missing receipt is uncertain with no redo; a changed callId is a conflict', async () => {
  const { tools, store, req, def } = build({ resolveAuthority: () => 'explicit_user' });
  const rememberReq = req('manage_memory', { action: 'remember', scope: 'user', content: 'Original fact' }, { operationKey: 'rec-1' });
  const remember = await tools.execute(rememberReq);
  const id = remember.content.memoryId;
  const ok = await tools.reconcile(rememberReq);
  assert.equal(ok.status, 'ok'); assert.equal(ok.content.consistent, true);
  assert.equal(ok.content.receipt.version, 1); assert.equal(ok.content.current.version, 1);
  await tools.execute(req('manage_memory', { action: 'correct', scope: 'user', memory_id: id, expected_version: 1, content: 'Corrected fact' }, { operationKey: 'rec-2' }));
  const stale = await tools.reconcile(rememberReq);
  assert.equal(stale.content.status, 'stale'); assert.equal(stale.content.consistent, false);
  assert.equal(stale.content.receipt.version, 1); assert.equal(stale.content.current.version, 2);
  const unknown = await tools.reconcile(req('manage_memory', { action: 'remember', scope: 'user', content: 'Never ran' }, { operationKey: 'never' }));
  assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.content.code, 'memory_receipt_unavailable');
  assert.equal(unknown.content.retryability, 'requires_reconcile');
  // A changed callId (same op key, same args) changes the full call digest -> conflict.
  const changedCallId = { ...rememberReq, call: { ...rememberReq.call, callId: 'call-changed' }, definition: def('manage_memory') };
  const conflict = await tools.reconcile(changedCallId);
  assert.equal(conflict.status, 'uncertain'); assert.equal(conflict.content.conflict, true);
  store.close();
});

test('real SQLite reopen: a committed receipt and fact survive close and reopen, and reconcile still verifies them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-memory-tools-')), filename = join(root, 'memory.sqlite');
  const first = new SqliteNativeMemoryProvider(filename, { principal, scopes: ['user'] });
  const toolsA = buildNativeMemoryTools({ policy: policy(), principal, lockedDigest, provider: first,
    authorize: async () => 'allow', consent: async () => 'allow', planner, resolveAuthority: () => 'explicit_user', resolveMutationSource: () => source });
  const defA = toolsA.definitions.find(d => d.name === 'manage_memory');
  const ac = new AbortController();
  const rememberReq = { call: { name: 'manage_memory', arguments: { action: 'remember', scope: 'user', content: 'Reopen fact' }, callId: 'call-r1' },
    definition: defA, operationKey: 'reopen-1', runId: 'run', scope: principal, signal: ac.signal };
  const digest = nativeMemoryRequestDigest({ call: rememberReq.call, definition: defA, lockedDigest });
  const result = await toolsA.execute(rememberReq); const id = result.content.memoryId;
  first.close();
  const second = new SqliteNativeMemoryProvider(filename, { principal, scopes: ['user'] });
  assert.equal(second.get(id).content, 'Reopen fact'); assert.equal(second.get(id).version, 1);
  const reconciled = second.reconcile({ operationKey: 'reopen-1', requestDigest: digest, memoryId: id });
  assert.equal(reconciled.status, 'ok'); assert.equal(reconciled.consistent, true);
  assert.equal(reconciled.receipt.memoryId, id);
  const toolsB = buildNativeMemoryTools({ policy: policy(), principal, lockedDigest, provider: second,
    authorize: async () => 'allow', consent: async () => 'allow', planner, resolveAuthority: () => 'explicit_user', resolveMutationSource: () => source });
  const replay = await toolsB.execute(rememberReq);
  assert.deepEqual(replay.content, result.content);
  second.close(); rmSync(root, { recursive: true, force: true });
});

test('sensitive content is rejected before the store is touched and leaves no pending body in any receipt', async () => {
  const { tools, store, req } = build({ resolveAuthority: () => 'explicit_user' });
  const sensitive = await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'api_key=AKIAIOSFODNN7EXAMPLE secret value' }, { operationKey: 'sens-1' }));
  assert.equal(sensitive.status, 'error'); assert.equal(sensitive.content.code, 'invalid_memory_action_arguments');
  assert.deepEqual(store.list(), []);
  const oversized = await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'x'.repeat(8193) }, { operationKey: 'sens-2' }));
  assert.equal(oversized.content.code, 'invalid_arguments');
  store.close();
});

test('the per-call request digest pins the complete call (callId) and the complete locked formal definition; a forged executionPolicyDigest is rejected', () => {
  const def = nativeMemoryToolDefinitions({ policy: policy(), lockedDigest }).find(d => d.name === 'manage_memory');
  const c1 = call('manage_memory', { action: 'remember', scope: 'user', content: 'A' });
  const c2 = call('manage_memory', { action: 'remember', scope: 'user', content: 'A' });
  // Same name+args, different callId -> different digest (callId is bound).
  assert.notEqual(nativeMemoryRequestDigest({ call: c1, definition: def, lockedDigest }),
    nativeMemoryRequestDigest({ call: c2, definition: def, lockedDigest }));
  // Same call, different definition (forged executionPolicyDigest) -> rejected.
  assert.throws(() => nativeMemoryRequestDigest({ call: c1, definition: { ...def, executionPolicyDigest: memoryDigest('other') }, lockedDigest }), /request_digest_invalid/);
  // Missing callId -> rejected.
  assert.throws(() => nativeMemoryRequestDigest({ call: { name: 'manage_memory', arguments: {} }, definition: def, lockedDigest }), /request_digest_invalid/);
  assert.equal(build({}).tools.contract, NATIVE_MEMORY_TOOLS_CONTRACT);
});

test('cross-scope CAS: a correct/forget under scope:user cannot touch an agent-scope record on the same database', async () => {
  const { tools, store, req } = build({ policy: policy({ scopes: ['user', 'agent'] }), resolveAuthority: () => 'explicit_user' });
  const agentBinding = nativeMemoryScopeBindings(principal, ['agent'])[0];
  // Create a record in the agent scope.
  const agentRemember = await tools.execute(req('manage_memory', { action: 'remember', scope: 'agent', content: 'Agent fact' }, { operationKey: 'agent-1' }));
  const id = agentRemember.content.memoryId;
  assert.equal(store.get(id).scope, 'agent');
  // Correct it under scope:user with the agent record's memory_id -> conflict, no modification.
  const cross = await tools.execute(req('manage_memory', { action: 'correct', scope: 'user', memory_id: id, expected_version: 1, content: 'Hijacked' }, { operationKey: 'cross-1' }));
  assert.equal(cross.status, 'error'); assert.equal(cross.content.code, 'memory_version_or_identity_conflict');
  assert.equal(store.get(id).content, 'Agent fact'); assert.equal(store.get(id).version, 1);
  // Forget under scope:user also rejected.
  const crossForget = await tools.execute(req('manage_memory', { action: 'forget', scope: 'user', memory_id: id, expected_version: 1 }, { operationKey: 'cross-2' }));
  assert.equal(crossForget.content.code, 'memory_version_or_identity_conflict');
  assert.equal(store.get(id).content, 'Agent fact');
  // Correct under the matching scope:agent succeeds.
  const ok = await tools.execute(req('manage_memory', { action: 'correct', scope: 'agent', memory_id: id, expected_version: 1, content: 'Agent fact v2' }, { operationKey: 'agent-2' }));
  assert.equal(ok.status, 'ok'); assert.equal(ok.content.version, 2); assert.equal(store.get(id).content, 'Agent fact v2');
  store.close();
});

test('remember consumes the original user source horizon in-transaction: PreCompact cannot re-extract it into a second fact', async () => {
  const { tools, store, req } = build({ resolveAuthority: () => 'explicit_user' });
  const originalText = '记住：我的编辑器是 Vim';
  const horizonCandidate = nativeUserMemoryCandidate({ text: originalText, sourceEventId: 'src-1', ...userBinding });
  const sourceDigest = memoryDigest(originalText);
  const horizonSource = { ...source, sourceEventId: 'event-1', horizon: [{ candidate: horizonCandidate, sourceDigest }] };
  const built = build({ resolveAuthority: () => 'explicit_user', resolveMutationSource: () => horizonSource, provider: store });
  const remember = await built.tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: '我的编辑器是 Vim' }, { operationKey: 'rem-h1' }));
  assert.equal(remember.content.committed, true);
  // The same original source is now consumed: applyCandidate returns duplicate_source, no second observation or fact.
  const replay = store.applyCandidate({ candidate: horizonCandidate, sourceDigest, sourceSessionId: 'session', operationKey: 'src-1' });
  assert.equal(replay.decision, 'duplicate_source'); assert.equal(replay.observations, 0);
  assert.equal(store.list().length, 1);
  // A different original source still extracts independently — here an explicit
  // candidate commits on first observation (confidence 1 >= explicit threshold),
  // and is NOT mistaken for the consumed source.
  const otherCandidate = nativeUserMemoryCandidate({ text: '记住：我喜欢吃米饭', sourceEventId: 'src-2', ...userBinding });
  const fresh = store.applyCandidate({ candidate: otherCandidate, sourceDigest: memoryDigest('记住：我喜欢吃米饭'), sourceSessionId: 'session', operationKey: 'src-2' });
  assert.notEqual(fresh.decision, 'duplicate_source');
  assert.equal(fresh.observations, 1);
  assert.equal(store.list().length, 2);
  store.close();
});

test('remember horizon rolls back with the fact if the receipt fails: the source is not consumed on retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-memory-horizon-')), filename = join(root, 'memory.sqlite');
  const store = new SqliteNativeMemoryProvider(filename, { principal, scopes: ['user'] });
  const originalText = '记住：我的偏好是咖啡';
  const horizonCandidate = nativeUserMemoryCandidate({ text: originalText, sourceEventId: 'src-1', ...userBinding });
  const sourceDigest = memoryDigest(originalText);
  const horizonSource = { ...source, sourceEventId: 'event-1', horizon: [{ candidate: horizonCandidate, sourceDigest }] };
  const built = build({ provider: store, resolveAuthority: () => 'explicit_user', resolveMutationSource: () => horizonSource });
  sql(filename, `CREATE TRIGGER fixture_fail BEFORE INSERT ON memory_operation_receipts
    BEGIN SELECT RAISE(ABORT,'fixture receipt interruption'); END`);
  const r = built.req('manage_memory', { action: 'remember', scope: 'user', content: '我的偏好是咖啡' }, { operationKey: 'rem-h2' });
  await assert.rejects(built.tools.execute(r), /fixture receipt interruption/);
  // Rollback: the source is NOT consumed and no record/receipt was written.
  assert.deepEqual(rows(filename, 'memory_candidate_sources'), []);
  assert.deepEqual(rows(filename, 'memory_records'), []);
  assert.deepEqual(rows(filename, 'memory_operation_receipts'), []);
  sql(filename, 'DROP TRIGGER fixture_fail');
  // Retry commits and consumes the source.
  const ok = await built.tools.execute(built.req('manage_memory', { action: 'remember', scope: 'user', content: '我的偏好是咖啡' }, { operationKey: 'rem-h2b' }));
  assert.equal(ok.content.committed, true);
  const replay = store.applyCandidate({ candidate: horizonCandidate, sourceDigest, sourceSessionId: 'session', operationKey: 'src-1' });
  assert.equal(replay.decision, 'duplicate_source'); assert.equal(replay.observations, 0);
  store.close(); rmSync(root, { recursive: true, force: true });
});

test('resolveMutationSource fail-closed: a corrupt source throws a stable error and an unavailable source returns unavailable; neither writes nor reaches consent', async () => {
  const corrupt = build({ resolveMutationSource: () => { throw Object.assign(new Error('provenance'), { code: 'provenance_failed' }); } });
  const c = await corrupt.tools.execute(corrupt.req('manage_memory', { action: 'remember', scope: 'user', content: 'Corrupt' }, { operationKey: 'src-1' }));
  assert.equal(c.status, 'error'); assert.equal(c.content.code, 'memory_source_unavailable');
  assert.equal(c.content.reason, 'provenance_failed'); assert.equal(c.content.executed, false);
  assert.deepEqual(corrupt.consentLog, []); assert.deepEqual(corrupt.store.list(), []);
  const unavailable = build({ resolveMutationSource: () => null });
  const u = await unavailable.tools.execute(unavailable.req('manage_memory', { action: 'remember', scope: 'user', content: 'No event' }, { operationKey: 'src-2' }));
  assert.equal(u.status, 'error'); assert.equal(u.content.code, 'memory_source_event_unavailable');
  assert.deepEqual(unavailable.consentLog, []); assert.deepEqual(unavailable.store.list(), []);
  corrupt.store.close(); unavailable.store.close();
});

test('search_memory awaits an async Host counter (production countRequest/countText) and never substitutes a character estimator', async () => {
  const calls = [];
  const asyncPlanner = { countMessage: async message => {
    calls.push(message.tool_call_id);
    // Yield a microtask to prove the promise is awaited, like the real async counter.
    await Promise.resolve();
    return Math.ceil(JSON.stringify(message).length / 4);
  } };
  const { tools, store, req } = build({ resolveAuthority: () => 'explicit_user',
    policy: policy({ recall: { enabled: false, maxTokens: 8000, topK: 8, minScore: .45 } }), planner: asyncPlanner });
  for (let i = 0; i < 3; i++) await tools.execute(req('manage_memory', { action: 'remember', scope: 'user', content: 'Async counter fact ' + i }, { operationKey: 'async-' + i }));
  const res = await tools.execute(req('search_memory', { query: 'Async counter fact' }, { operationKey: 'async-search' }));
  assert.equal(res.status, 'ok'); assert.equal(res.content.records.length, 3);
  // The async counter was actually called and awaited (not bypassed): every
  // returned value was a resolved number, not a pending promise or undefined.
  // If the await were missing, the budget comparison would compare a Promise to
  // a number and trim/fail the search. Three per-record fits fired on the
  // request's callId; a tight-budget search below fires more (trim + re-fit).
  assert.ok(calls.length >= 3);
  assert.ok(calls.every(id => typeof id === 'string'));
  // A sync planner still works (backward-compatible): the await tolerates a value.
  const syncPlanner = { countMessage: message => Math.ceil(JSON.stringify(message).length / 4) };
  const { tools: syncTools, req: syncReq } = build({ resolveAuthority: () => 'explicit_user', provider: store, planner: syncPlanner });
  const syncRes = await syncTools.execute(syncReq('search_memory', { query: 'Async counter fact' }, { operationKey: 'sync-search' }));
  assert.equal(syncRes.status, 'ok'); assert.equal(syncRes.content.records.length, 3);
  store.close();
});
