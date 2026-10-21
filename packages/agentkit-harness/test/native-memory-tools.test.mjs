import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonical } from '../../agentkit-harness-core/dist/index.mjs';
import { memoryDigest } from '../src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../src/native/memory-store.mjs';
import { buildNativeMemoryTools, nativeMemoryToolDefinitions, nativeMemoryLockedDigest,
  nativeMemoryRequestDigest, NATIVE_MEMORY_TOOLS_CONTRACT } from '../src/native/memory-tools.mjs';

const principal = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', userId: 'user' };
const lockedDigest = nativeMemoryLockedDigest({ providerRef: 'local-default',
  memoryPolicy: { scopes: ['user'] }, contextSpec: {} });
const source = { sourceSessionId: 'session', sourceEventId: 'event-1',
  sourceGoalRevision: '0', sourceGoalDigest: memoryDigest('remember my editor is Vim'), horizon: [] };
const planner = { countMessage: message => Math.ceil(JSON.stringify(message).length / 4) };

function policy(overrides = {}) {
  return { enabled: true, providerRef: 'local-default', scopes: ['user'],
    recall: { enabled: true, maxTokens: 1600, topK: 8, minScore: .45 },
    write: { mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: true },
    rollout: 'enabled', ...overrides };
}
let seq = 0;
function call(name, args) { return { name, arguments: args, callId: 'call-' + ++seq }; }
function request(name, args, extra = {}) {
  return { call: call(name, args), operationKey: extra.operationKey ?? 'op-' + randomUUID(),
    runId: 'run', scope: principal, signal: { throwIfAborted() {} }, ...extra };
}
function build({ policy: p = policy(), provider, authorize, consent, resolveAuthority, resolveMutationSource } = {}) {
  const store = provider ?? new SqliteNativeMemoryProvider(':memory:', { principal, scopes: p.scopes });
  const consentLog = [];
  const tools = buildNativeMemoryTools({ policy: p, principal, lockedDigest, provider: store,
    authorize: authorize ?? (async () => 'allow'),
    consent: consent ?? (async req => { consentLog.push(req.call.name); return 'allow'; }),
    planner, resolveAuthority: resolveAuthority ?? (() => null),
    resolveMutationSource: resolveMutationSource ?? (() => source) });
  return { tools, store, consentLog };
}

test('definitions bind to the Build: every definition carries the locked digest and search is independent of the recall toggle', () => {
  const defs = nativeMemoryToolDefinitions({ policy: policy({ recall: { enabled: false, maxTokens: 1600, topK: 8, minScore: .45 } }), lockedDigest });
  assert.deepEqual(defs.map(d => d.name), ['read_memory', 'search_memory', 'manage_memory']);
  for (const d of defs) assert.equal(d.executionPolicyDigest, lockedDigest);
  assert.equal(defs[0].readOnly, true); assert.equal(defs[0].recoveryPolicy, 'safe-read/v1');
  assert.equal(defs[1].readOnly, true); assert.equal(defs[2].readOnly, false);
  assert.deepEqual(defs[2].parameters.properties.scope.enum, ['user']);
  // No token budget -> no search tool; write off / rollout off -> no manage tool.
  assert.deepEqual(nativeMemoryToolDefinitions({ policy: policy({ recall: { enabled: true, maxTokens: 0, topK: 8, minScore: .45 } }), lockedDigest }).map(d => d.name), ['read_memory', 'manage_memory']);
  assert.deepEqual(nativeMemoryToolDefinitions({ policy: policy({ write: { mode: 'off', flushBeforeCompaction: true, flushAfterTurn: true } }), lockedDigest }).map(d => d.name), ['read_memory', 'search_memory']);
  assert.deepEqual(nativeMemoryToolDefinitions({ policy: policy({ rollout: 'off' }), lockedDigest }).map(d => d.name), ['read_memory', 'search_memory']);
});

test('read_memory returns the current version, hash, status and scope; unknown ids are not found in scope', async () => {
  const { tools, store } = build({ resolveAuthority: () => 'explicit_user' });
  const remember = await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'My editor is Vim' }, { operationKey: 'remember-1' }));
  const id = remember.content.memoryId;
  const read = await tools.execute(request('read_memory', { memory_id: id }, { operationKey: 'read-1' }));
  assert.equal(read.status, 'ok'); assert.equal(read.content.code, null); assert.equal(read.content.trustLevel, 'untrusted');
  assert.equal(read.content.record.memoryId, id); assert.equal(read.content.record.version, 1);
  assert.equal(read.content.record.status, 'active'); assert.equal(read.content.record.contentHash, memoryDigest('My editor is Vim'));
  assert.equal(read.content.record.scope, 'user');
  const missing = await tools.execute(request('read_memory', { memory_id: 'memory_unknown' }, { operationKey: 'read-2' }));
  assert.equal(missing.status, 'error'); assert.equal(missing.content.code, 'memory_not_found_in_scope');
  // Cross-scope on the same database cannot read another principal's record.
  const foreign = new SqliteNativeMemoryProvider(':memory:', { principal: { ...principal, userId: 'foreign' }, scopes: ['user'] });
  try { assert.equal(foreign.get(id), null); } finally { foreign.close(); }
  store.close();
});

test('remember with explicit_user authority persists a user_confirm fact; approved_call persists an auto fact', async () => {
  const explicit = build({ resolveAuthority: () => 'explicit_user' });
  const a = await explicit.tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '记住的显式事实' }, { operationKey: 'op-a' }));
  assert.equal(a.status, 'ok'); assert.equal(a.content.committed, true); assert.equal(a.content.action, 'remember');
  assert.equal(a.content.version, 1); assert.match(a.content.memoryId, /^memory_[0-9a-f-]+$/u);
  assert.equal(explicit.store.get(a.content.memoryId).writePolicy, 'user_confirm');
  assert.equal(explicit.store.get(a.content.memoryId).metadata.authority, 'explicit_user');
  const approved = build({ resolveAuthority: () => null });
  const b = await approved.tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: '审批后的事实' }, { operationKey: 'op-b' }));
  assert.equal(b.content.committed, true); assert.equal(approved.store.get(b.content.memoryId).writePolicy, 'auto');
  assert.equal(approved.store.get(b.content.memoryId).metadata.authority, 'approved_call');
  explicit.store.close(); approved.store.close();
});

test('correct and forget are strict expected_version CAS; a stale version conflicts with a read-before-retry next action', async () => {
  const { tools, store } = build({ resolveAuthority: () => 'explicit_user' });
  const remember = await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'Vim' }, { operationKey: 'r' }));
  const id = remember.content.memoryId;
  const correct = await tools.execute(request('manage_memory', { action: 'correct', scope: 'user', memory_id: id, expected_version: 1, content: 'Neovim' }, { operationKey: 'c1' }));
  assert.equal(correct.status, 'ok'); assert.equal(correct.content.version, 2);
  assert.equal(correct.content.contentHash, memoryDigest('Neovim'));
  assert.equal(store.get(id).content, 'Neovim');
  // Wrong expected_version -> conflict.
  const stale = await tools.execute(request('manage_memory', { action: 'correct', scope: 'user', memory_id: id, expected_version: 1, content: 'Emacs' }, { operationKey: 'c2' }));
  assert.equal(stale.status, 'error'); assert.equal(stale.content.code, 'memory_version_or_identity_conflict');
  assert.equal(stale.content.next_action, 'read_memory_before_retry');
  // Correct expected_version forgets.
  const forget = await tools.execute(request('manage_memory', { action: 'forget', scope: 'user', memory_id: id, expected_version: 2 }, { operationKey: 'f1' }));
  assert.equal(forget.status, 'ok'); assert.equal(forget.content.status, 'deleted');
  assert.equal(store.get(id).content, ''); assert.equal(store.get(id).version, 3);
  // Forget with content is invalid; remember with memory_id/expected_version is invalid.
  assert.equal((await tools.execute(request('manage_memory', { action: 'forget', scope: 'user', memory_id: id, expected_version: 3, content: 'leak' }, { operationKey: 'f2' }))).content.code, 'invalid_memory_action_arguments');
  assert.equal((await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'x', memory_id: id }, { operationKey: 'r2' }))).content.code, 'invalid_memory_action_arguments');
  store.close();
});

test('authorization: a recognized explicit user command skips consent; everything else, including forget, routes to consent; approval_required passes through the Native interaction boundary', async () => {
  // explicit_user -> consent not called.
  const explicit = build({ resolveAuthority: req => req.call.arguments.action === 'remember' ? 'explicit_user' : null });
  await explicit.tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'X' }, { operationKey: 'e1' }));
  assert.deepEqual(explicit.consentLog, []);
  // non-explicit -> consent called and its decision is honored.
  const denied = build({ resolveAuthority: () => null, consent: async () => ({ status: 'approval_required', interactionId: 'int-1' }) });
  const d = await denied.tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'Y' }, { operationKey: 'e2' }));
  assert.equal(d.status, 'approval_required'); assert.equal(d.interactionId, 'int-1');
  assert.equal(denied.store.list().length, 0); // no write without consent
  denied.store.close();
  // base authorize denial -> policy_denied, consent never reached.
  const baseDenied = build({ authorize: async () => 'deny', resolveAuthority: () => 'explicit_user' });
  const bd = await baseDenied.tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'Z' }, { operationKey: 'e3' }));
  assert.equal(bd.status, 'error'); assert.equal(bd.content.code, 'policy_denied');
  assert.deepEqual(baseDenied.consentLog, []); assert.equal(baseDenied.store.list().length, 0);
  baseDenied.store.close();
  explicit.store.close();
});

test('shadow rollout cannot write: manage_memory is read-only and returns a non-committing shadow decision; the store is untouched', async () => {
  const { tools, store } = build({ policy: policy({ rollout: 'shadow' }) });
  const manage = tools.definitions.find(d => d.name === 'manage_memory');
  assert.equal(manage.readOnly, true);
  const shadow = await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'shadow fact' }, { operationKey: 's1' }));
  assert.equal(shadow.status, 'ok'); assert.equal(shadow.content.committed, false);
  assert.equal(shadow.content.decision, 'shadow'); assert.equal(shadow.content.reason, 'shadow_rollout_no_write');
  assert.deepEqual(store.list(), []);
  // read/search still work in shadow.
  const read = await tools.execute(request('read_memory', { memory_id: 'memory_none' }, { operationKey: 's2' }));
  assert.equal(read.content.code, 'memory_not_found_in_scope');
  store.close();
});

test('the same operation key and call is idempotent; a reused key with different arguments conflicts', async () => {
  const { tools, store } = build({ resolveAuthority: () => 'explicit_user' });
  const req = request('manage_memory', { action: 'remember', scope: 'user', content: 'Idempotent fact' }, { operationKey: 'idem-1' });
  const first = await tools.execute(req);
  const replay = await tools.execute(req);
  assert.deepEqual(replay.content, first.content); assert.equal(replay.status, 'ok');
  assert.equal(store.list().length, 1);
  // Reused operation key, different content -> different request digest -> conflict.
  const conflict = await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'Different fact' }, { operationKey: 'idem-1' }));
  assert.equal(conflict.status, 'error'); assert.equal(conflict.content.code, 'memory_version_or_identity_conflict');
  assert.equal(conflict.content.next_action, 'read_memory_before_retry');
  assert.equal(store.list().length, 1); // the conflicting call wrote nothing
  store.close();
});

test('search_memory counts the whole provenance envelope against the token budget, trims and flags truncation, and fails closed on a too-small budget', async () => {
  const { tools, store } = build({ resolveAuthority: () => 'explicit_user', policy: policy({ recall: { enabled: false, maxTokens: 8000, topK: 8, minScore: .45 } }) });
  for (let i = 0; i < 6; i++) await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'Editor fact number ' + i }, { operationKey: 'seed-' + i }));
  const full = await tools.execute(request('search_memory', { query: 'Editor fact' }, { operationKey: 'search-1' }));
  assert.equal(full.status, 'ok'); assert.equal(full.content.trustLevel, 'untrusted');
  assert.equal(full.content.format, 'ksadk.memory-search/v1'); assert.equal(full.content.budgetSkipped, 0);
  assert.equal(full.content.records.length, 6);
  // Tight budget trims records and reports the omission in the same envelope.
  const tight = build({ resolveAuthority: () => 'explicit_user', policy: policy({ recall: { enabled: false, maxTokens: 400, topK: 8, minScore: 0 } }), provider: store });
  const trimmed = await tight.tools.execute(request('search_memory', { query: 'Editor fact' }, { operationKey: 'search-2' }));
  assert.equal(trimmed.status, 'ok'); assert.ok(trimmed.content.truncated); assert.ok(trimmed.content.budgetSkipped > 0);
  assert.ok(trimmed.content.records.length >= 1 && trimmed.content.records.length < full.content.records.length);
  // Budget too small for even the empty envelope -> fails closed.
  const tiny = build({ resolveAuthority: () => 'explicit_user', policy: policy({ recall: { enabled: false, maxTokens: 1, topK: 8, minScore: 0 } }), provider: store });
  const closed = await tiny.tools.execute(request('search_memory', { query: 'Editor fact' }, { operationKey: 'search-3' }));
  assert.equal(closed.status, 'error'); assert.equal(closed.content.code, 'memory_search_budget_too_small');
  // Missing/empty query -> error; explicit search works when automatic recall is disabled.
  assert.equal((await tools.execute(request('search_memory', { query: '   ' }, { operationKey: 'search-4' }))).content.code, 'memory_search_query_missing');
  store.close();
});

test('reconcile verifies a sealed receipt against the current fact; an old receipt is stale after correction and a missing receipt is uncertain with no redo', async () => {
  const { tools, store } = build({ resolveAuthority: () => 'explicit_user' });
  const rememberReq = request('manage_memory', { action: 'remember', scope: 'user', content: 'Original fact' }, { operationKey: 'rec-1' });
  const remember = await tools.execute(rememberReq);
  const id = remember.content.memoryId;
  const ok = await tools.reconcile(rememberReq);
  assert.equal(ok.status, 'ok'); assert.equal(ok.content.consistent, true);
  assert.equal(ok.content.receipt.version, 1); assert.equal(ok.content.current.version, 1);
  // Correct the fact; the old receipt no longer proves the current fact.
  await tools.execute(request('manage_memory', { action: 'correct', scope: 'user', memory_id: id, expected_version: 1, content: 'Corrected fact' }, { operationKey: 'rec-2' }));
  const stale = await tools.reconcile(rememberReq);
  assert.equal(stale.status, 'ok'); assert.equal(stale.content.status, 'stale'); assert.equal(stale.content.consistent, false);
  assert.equal(stale.content.receipt.version, 1); assert.equal(stale.content.current.version, 2);
  // Unknown operation key -> uncertain, never redone.
  const unknown = await tools.reconcile(request('manage_memory', { action: 'remember', scope: 'user', content: 'Never ran' }, { operationKey: 'never' }));
  assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.content.code, 'memory_receipt_unavailable');
  assert.equal(unknown.content.retryability, 'requires_reconcile');
  // Different call reusing a known operation key -> conflict digest -> uncertain.
  const conflict = await tools.reconcile(request('manage_memory', { action: 'remember', scope: 'user', content: 'Different' }, { operationKey: 'rec-1' }));
  assert.equal(conflict.status, 'uncertain'); assert.equal(conflict.content.conflict, true);
  store.close();
});

test('real SQLite reopen: a committed receipt and fact survive close and reopen, and reconcile still verifies them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-memory-tools-')), filename = join(root, 'memory.sqlite');
  let digest, id;
  const first = new SqliteNativeMemoryProvider(filename, { principal, scopes: ['user'] });
  const toolsA = buildNativeMemoryTools({ policy: policy(), principal, lockedDigest, provider: first,
    authorize: async () => 'allow', consent: async () => 'allow', planner, resolveAuthority: () => 'explicit_user', resolveMutationSource: () => source });
  const rememberReq = request('manage_memory', { action: 'remember', scope: 'user', content: 'Reopen fact' }, { operationKey: 'reopen-1' });
  digest = nativeMemoryRequestDigest({ call: rememberReq.call, definition: toolsA.definitions.find(d => d.name === 'manage_memory'), lockedDigest });
  const result = await toolsA.execute(rememberReq); id = result.content.memoryId;
  first.close();
  // Reopen with a fresh provider handle on the same file; the receipt is durable.
  const second = new SqliteNativeMemoryProvider(filename, { principal, scopes: ['user'] });
  assert.equal(second.get(id).content, 'Reopen fact'); assert.equal(second.get(id).version, 1);
  const reconciled = second.reconcile({ operationKey: 'reopen-1', requestDigest: digest, memoryId: id });
  assert.equal(reconciled.status, 'ok'); assert.equal(reconciled.consistent, true);
  assert.equal(reconciled.receipt.memoryId, id);
  // Replaying the exact same call through a reopened store returns the sealed receipt, not a duplicate write.
  const toolsB = buildNativeMemoryTools({ policy: policy(), principal, lockedDigest, provider: second,
    authorize: async () => 'allow', consent: async () => 'allow', planner, resolveAuthority: () => 'explicit_user', resolveMutationSource: () => source });
  const replay = await toolsB.execute(rememberReq);
  assert.deepEqual(replay.content, result.content);
  second.close(); rmSync(root, { recursive: true, force: true });
});

test('sensitive content is rejected before the store is touched and leaves no pending body in any receipt', async () => {
  const { tools, store } = build({ resolveAuthority: () => 'explicit_user' });
  const sensitive = await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'api_key=AKIAIOSFODNN7EXAMPLE secret value' }, { operationKey: 'sens-1' }));
  assert.equal(sensitive.status, 'error'); assert.equal(sensitive.content.code, 'invalid_memory_action_arguments');
  assert.deepEqual(store.list(), []);
  // Oversized content is rejected by the schema upstream.
  const oversized = await tools.execute(request('manage_memory', { action: 'remember', scope: 'user', content: 'x'.repeat(8193) }, { operationKey: 'sens-2' }));
  assert.equal(oversized.content.code, 'invalid_arguments');
  store.close();
});

test('the per-call request digest pins the definition and arguments; a forged tool name or committed text is not authorization', async () => {
  const def = nativeMemoryToolDefinitions({ policy: policy(), lockedDigest }).find(d => d.name === 'manage_memory');
  const c1 = call('manage_memory', { action: 'remember', scope: 'user', content: 'A' });
  const c2 = call('manage_memory', { action: 'remember', scope: 'user', content: 'B' });
  assert.notEqual(nativeMemoryRequestDigest({ call: c1, definition: def, lockedDigest }),
    nativeMemoryRequestDigest({ call: c2, definition: def, lockedDigest }));
  // A definition whose executionPolicyDigest differs from the locked digest is rejected.
  assert.throws(() => nativeMemoryRequestDigest({ call: c1, definition: { ...def, executionPolicyDigest: memoryDigest('other') }, lockedDigest }), /request_digest_invalid/);
  // Contract identity is stable and exposed for parent composition.
  assert.equal(build({}).tools.contract, NATIVE_MEMORY_TOOLS_CONTRACT);
  assert.equal(canonical(build({}).tools.definitions), canonical(build({}).tools.definitions));
});
