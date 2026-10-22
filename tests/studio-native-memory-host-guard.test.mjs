import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, configure, emptyUsage, canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { SqliteNativeMemoryProvider } from '../packages/agentkit-harness/src/native/memory-store.mjs';
import { memoryDigest, nativeMemoryScopeBindings, nativeUserMemoryCandidate } from '../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { bindStudioNativeMemoryHost } from '../src/providers/native-memory-host.mjs';
import { bindNativeContext } from '../src/providers/native-context.mjs';
import { nativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';

// Focused guard tests (items 2-3): the Memory tool write is re-verified against
// the real ledger/fence/capsule at authorize, after the async consent, and right
// before provider.applyMutation. A late allow arriving after the owner closed,
// the turn was aborted, or a forged definition/call reached the body commits
// nothing. Parallel reads carry their own per-call dispatch on AsyncLocalStorage.
// Real SqliteRunStore + real Memory provider + real NativeKernel; only the model
// and the approval service are fixtures.

const memoryFile = (root, principal) => join(root, 'native-harness', 'memory-v1',
  memoryDigest(principal.tenantId).slice(7), 'memory.sqlite');
const noWrites = async (root, principal) => {
  const provider = new SqliteNativeMemoryProvider(memoryFile(root, principal), { principal });
  try { return provider.list().length; } finally { provider.close(); }
};

function setup(t, { spec, buildId = null, approval }) {
  const root = mkdtempSync(join(tmpdir(), 'studio-memory-guard-'));
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => store.close());
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec };
  const context = bindNativeContext({ description: { protocol: 'openai-chat', modelName: 'pinned', parameters: {},
    contextWindow: 16000, maxOutputTokens: 1024 }, context: spec.context });
  let resolveApproval, approvalValue = approval ?? 'allowed-once';
  const approvalPromise = new Promise(resolve => { resolveApproval = resolve; });
  let approvalCalledResolve;
  const approvalCalled = new Promise(resolve => { approvalCalledResolve = resolve; });
  const approvalService = { request: async () => { approvalCalledResolve(); await approvalPromise; return approvalValue; } };
  const toolRegistry = new Map();
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: approvalService,
    tools: { register: tool => { toolRegistry.set(tool.name, tool); return () => toolRegistry.delete(tool.name); },
      execute: async input => { const r = toolRegistry.get(input.name); const value = await r.execute(input.arguments, input);
        return { isError: false, value, content: r.output.render(input.arguments, value) }; } },
    get: id => id === 'approval' ? approvalService : id === 'sandboxPolicy' ? ctx.sandboxPolicy : undefined };
  const gateway = createNativeDshTools({ ctx, config: { toolBindings: [], toolContracts: [] }, workspaceRoot, stateDir: join(root, 'state') });
  t.after(() => gateway.close());
  // Seal a Host recovery capsule for this Build so the Memory guard can compare
  // the CURRENT configuration's capsule to the bound identity. The objective
  // below matches what the run is seeded with.
  const objective = 'Save my current preference.';
  const sealedCapsule = nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1, ...(buildId ? { buildId } : {}) },
    input: { messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: objective }] }] },
    source: { provider: 'fixture', model: 'pinned' }, selection: {}, systemPrompt: 'Answer the current user.' });
  const memoryHost = bindStudioNativeMemoryHost({ record, scope, sessionId: 'session', store, storeDir: root, buildId, context, ctx, sealedCapsule });
  gateway.bindMemory(memoryHost);
  return { root, store, record, memoryHost, gateway, ctx, context, objective, sealedCapsule,
    resolveApproval: (v = 'allowed-once') => { approvalValue = v; resolveApproval(v); },
    approvalCalled };
}

function configFor(goal, tools, buildId, capsule, contextPolicy) {
  const base = fixture().config;
  return configure({ ...base, instructions: 'Answer the current user.',
    contract: { ...base.contract, objective: goal }, inputMessages: [{ role: 'user', kind: 'user_input', content: goal }],
    tools, limits: { ...base.limits, maxRepairs: 0, maxModelCalls: 6, effectTimeoutMs: 130000 },
    ...(contextPolicy ? { contextPolicy } : {}),
    hostRecoveryBinding: capsule ?? nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1, ...(buildId ? { buildId } : {}) },
      input: { messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: goal }] }] },
      source: { provider: 'fixture', model: 'pinned' }, selection: {}, systemPrompt: 'Answer the current user.' }) });
}

// Drive a real kernel that emits a manage_memory write needing consent. The
// objective is NOT an explicit memory instruction, so resolveAuthority routes
// to consent (the deferred approval); the run is in executing_tools while
// approvalCalled is pending. Returns controls to manipulate during the defer.
async function startWriteRun(t, { objective = 'Save my current preference.', content = 'my coffee is flat white' } = {}) {
  const h = setup(t, { spec: { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
    scopes: ['user'], write: { mode: 'candidate', flushAfterTurn: false }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } } });
  let models = 0;
  const model = { generate: async () => {
    if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'm1', name: 'manage_memory', arguments: { action: 'remember', scope: 'user', content } }] };
    return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
  } };
  const agentPort = h.gateway.forAgent({ session: { id: 'session' } }, { scope, store: h.store });
  const captured = [];
  const toolsExecute = async request => { captured.push(request); return agentPort.tools.execute(request); };
  const ports = { ...agentPort, tools: { execute: toolsExecute }, model, context: h.context.port };
  const kernel = new NativeKernel({ store: h.store, ports, digest, owner: 'guard-worker' });
  const config = configFor(objective, h.memoryHost.port.definitions, null, h.sealedCapsule, h.context.policy);
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session' }, config);
  const controller = new AbortController();
  const runPromise = kernel.runUntilIdle(scope, 'run', { signal: controller.signal });
  return { ...h, captured, controller, runPromise, kernel };
}

test('a late allow after the Memory owner is closed commits no write', async t => {
  const h = await startWriteRun(t, { content: 'my coffee is flat white' });
  // The run is in executing_tools; the deferred consent is in flight.
  await h.approvalCalled;
  // The owner is replaced/closed while the deferred approval is in flight.
  h.memoryHost.close();
  h.resolveApproval('allowed-once'); // the late allow arrives
  const snapshot = await h.runPromise;
  assert.ok(['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase), snapshot.phase);
  assert.equal(await noWrites(h.root, scope), 0, 'no Memory fact after the owner closed mid-approval');
});

test('gateway retirement closes a pending Memory owner before late consent', async t => {
  const h = await startWriteRun(t);
  try { await h.approvalCalled; await h.gateway.close(); }
  finally { h.resolveApproval('allowed-once'); }
  await h.runPromise;
  assert.equal(await noWrites(h.root, scope), 0, 'retired preset cannot commit a pending Memory write');
});

test('a new lease fences a pending Memory write even if its approval arrives later', async t => {
  const h = await startWriteRun(t);
  // Attach rejection handling before advancing the real store lease. The old
  // Kernel must lose commit authority as well as mutation authority.
  const oldRun = h.runPromise.then(() => null, error => error);
  await h.approvalCalled;
  const before = h.store.load(scope, 'run');
  h.store.release(scope, 'run', before.lease);
  const nextLease = h.store.acquire(scope, 'run', 'replacement-host', Date.now(), 60000);
  try {
    assert.ok(nextLease.fence > before.lease.fence);
    h.resolveApproval('allowed-once');
    assert.equal((await oldRun)?.code, 'stale_fence');
    assert.equal(await noWrites(h.root, scope), 0);
    const after = h.store.load(scope, 'run');
    assert.deepEqual(after.snapshot, before.snapshot, 'old executor cannot change the new owner ledger');
    assert.deepEqual(after.lease, nextLease);
  } finally { h.resolveApproval('rejected'); h.store.release(scope, 'run', nextLease); }
});

test('aborting the turn during a deferred approval commits no write', async t => {
  const h = await startWriteRun(t, { content: 'my editor is helix' });
  await h.approvalCalled;
  h.controller.abort(new Error('turn canceled')); // cancel the turn mid-approval
  h.resolveApproval('allowed-once'); // a late allow must not revive it
  const snapshot = await h.runPromise;
  assert.ok(['canceled', 'interrupted', 'failed', 'completed'].includes(snapshot.phase), snapshot.phase);
  assert.equal(await noWrites(h.root, scope), 0, 'no Memory fact after the turn was aborted mid-approval');
});

test('a forged locked formal definition is rejected before any write', async t => {
  const h = setup(t, { spec: { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
    scopes: ['user'], write: { mode: 'candidate', flushAfterTurn: false }, recall: { enabled: false, maxTokens: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } } });
  const manage = h.memoryHost.port.definitions.find(d => d.name === 'manage_memory');
  // A forged definition that flips readOnly/permissions cannot reproduce the
  // locked formal; bindingResult rejects before the ledger guard or write.
  const forged = { ...manage, readOnly: true, permissions: [] };
  const request = { call: { name: 'manage_memory', callId: 'c1', arguments: { action: 'remember', scope: 'user', content: 'forged' } },
    definition: forged, scope, runId: 'run', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null,
    taskChainId: 'session', operationKey: 'op', executionFence: 1, signal: new AbortController().signal };
  const result = await h.memoryHost.withDispatch({ request, agent: { session: { id: 'session' } }, signal: request.signal },
    () => h.memoryHost.port.execute(request));
  assert.equal(result.status, 'error');
  assert.equal(result.content.code, 'native_memory_definition_unbound');
  assert.equal(await noWrites(h.root, scope), 0);
});

test('a forged per-call callId (not the running batch call) is rejected by the ledger guard', async t => {
  const content = 'my editor is helix';
  const h = await startWriteRun(t, { content });
  await h.approvalCalled; // run in executing_tools, the real manage_memory batch is running
  const real = h.captured[0];
  // Forge a different callId for the SAME batch operationKey: the ledger guard
  // resolves the batch intent but the per-call callId does not match the running
  // call, so the forged request is rejected (no write of the forged identity).
  // approvalOrDenied normalizes the guard's denial to policy_denied, so assert
  // the forged request errored and did not write; the REAL call may still write
  // its own content once the deferred allow resolves (it is a separate, guarded
  // execution with the real callId).
  const forged = { ...real, call: { ...real.call, callId: 'forged-call-id' } };
  const result = await h.memoryHost.withDispatch({ request: forged, agent: { session: { id: 'session' } }, signal: real.signal },
    () => h.memoryHost.port.execute(forged));
  assert.equal(result.status, 'error');
  assert.equal(result.content.executed, false);
  assert.equal(await noWrites(h.root, scope), 0, 'forged call writes nothing before the genuine approval');
  h.resolveApproval('allowed-once'); // let the real (guarded) call finish
  await h.runPromise;
  const provider = new SqliteNativeMemoryProvider(memoryFile(h.root, scope), { principal: scope });
  try {
    const records = provider.list();
    // The forged request wrote nothing; only the real call's content may persist.
    assert.equal(records.length, 1, 'the genuine approved call wrote exactly one fact');
    assert.equal(records[0].content, content);
  } finally { provider.close(); }
});

test('parallel search_memory calls each observe their own per-call signal (AsyncLocalStorage isolation)', async t => {
  const h = setup(t, { spec: { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
    scopes: ['user'], write: { mode: 'off' }, recall: { enabled: true, maxTokens: 1600, topK: 8, minScore: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } } });
  // Record the signal the planner passes to the counter per tool_call_id. With
  // ALS isolation each parallel search's planner sees its OWN signal instance;
  // the old shared-dispatchRef bug would let both see the same (last-set) signal.
  const signals = new Map();
  const realCount = h.context.port.tokens.countRequest;
  const wrappedTokens = { ...h.context.port.tokens,
    countRequest: async req => {
      // The planner wraps the lone tool message in a legal replay batch
      // (assistant.toolCalls + tool message); the tool_call_id lives on the
      // tool message, and the assistant toolCall carries the original callId.
      const toolMsg = req.messages?.find(m => m.role === 'tool');
      const callId = toolMsg?.callId ?? req.messages?.[0]?.tool_call_id;
      if (callId) signals.set(callId, req.signal);
      return realCount(req);
    } };
  const context = { ...h.context, port: { ...h.context.port, tokens: wrappedTokens } };
  // Rebind the memory host against the wrapped counter so its planner uses it.
  h.memoryHost.close();
  const memoryHost = bindStudioNativeMemoryHost({ record: h.record, scope, sessionId: 'session', store: h.store,
    storeDir: h.root, buildId: null, context, ctx: h.ctx, sealedCapsule: h.sealedCapsule });
  h.gateway.bindMemory(memoryHost);
  let models = 0;
  const model = { generate: async () => {
    if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
      { callId: 's1', name: 'search_memory', arguments: { query: 'alpha' } },
      { callId: 's2', name: 'search_memory', arguments: { query: 'beta' } }] };
    return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
  } };
  const agentPort = h.gateway.forAgent({ session: { id: 'session' } }, { scope, store: h.store });
  const ports = { ...agentPort, tools: { execute: agentPort.tools.execute }, model, context: context.port };
  const kernel = new NativeKernel({ store: h.store, ports, digest, owner: 'guard-worker' });
  // The search run has its own objective/capsule; seal a matching capsule for
  // the guard so the read-only searches are not rejected by the build guard.
  const searchCapsule = nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
    input: { messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'search please' }] }] },
    source: { provider: 'fixture', model: 'pinned' }, selection: {}, systemPrompt: 'Answer the current user.' });
  // Rebind the memory host with the search-run capsule so the guard binds it.
  memoryHost.close();
  const searchHost = bindStudioNativeMemoryHost({ record: h.record, scope, sessionId: 'session', store: h.store,
    storeDir: h.root, buildId: null, context, ctx: h.ctx, sealedCapsule: searchCapsule });
  h.gateway.bindMemory(searchHost);
  const config = configFor('search please', searchHost.port.definitions, null, searchCapsule, h.context.policy);
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session' }, config);
  const snapshot = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'completed', snapshot.reason);
  // Two parallel searches, two distinct per-call signals — proving the planner
  // read each call's own dispatch context, not a shared mutable ref.
  assert.equal(signals.size, 2, 'both parallel searches ran their planner');
  assert.notEqual(signals.get('s1'), signals.get('s2'), 'per-call signals are distinct (ALS isolation)');
  searchHost.close();
});

test('search_memory counts non-empty results through the real counter and returns ok', async t => {
  const h = setup(t, { spec: { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
    scopes: ['user'], write: { mode: 'off' }, recall: { enabled: true, maxTokens: 1600, topK: 8, minScore: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } } });
  // Seed a real fact so search returns a non-empty record the planner must count.
  const binding = nativeMemoryScopeBindings(scope, ['user'])[0];
  const candidate = nativeUserMemoryCandidate({ text: '记住：my editor is helix', sourceEventId: 'seed-event', ...binding });
  assert.ok(candidate, 'explicit seed candidate');
  const seed = new SqliteNativeMemoryProvider(memoryFile(h.root, scope), { principal: scope });
  try { seed.applyCandidate({ candidate, operationKey: 'seed',
    sourceSessionId: 'session', sourceDigest: memoryDigest(candidate.content) }); }
  finally { seed.close(); }
  let models = 0, counts = 0;
  const realCount = h.context.port.tokens.countRequest;
  const wrappedTokens = { ...h.context.port.tokens,
    countRequest: async req => { counts++; return realCount(req); } };
  const context = { ...h.context, port: { ...h.context.port, tokens: wrappedTokens } };
  h.memoryHost.close();
  const searchCapsule = nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
    input: { messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'find my editor' }] }] },
    source: { provider: 'fixture', model: 'pinned' }, selection: {}, systemPrompt: 'Answer the current user.' });
  const searchHost = bindStudioNativeMemoryHost({ record: h.record, scope, sessionId: 'session', store: h.store,
    storeDir: h.root, buildId: null, context, ctx: h.ctx, sealedCapsule: searchCapsule });
  h.gateway.bindMemory(searchHost);
  const model = { generate: async () => {
    if (++models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 's1', name: 'search_memory', arguments: { query: 'editor' } }] };
    return { kind: 'final_candidate', text: 'Done', usage: emptyUsage(), toolCalls: [] };
  } };
  const agentPort = h.gateway.forAgent({ session: { id: 'session' } }, { scope, store: h.store });
  const ports = { ...agentPort, tools: { execute: agentPort.tools.execute }, model, context: context.port };
  const kernel = new NativeKernel({ store: h.store, ports, digest, owner: 'guard-worker' });
  const config = configFor('find my editor', searchHost.port.definitions, null, searchCapsule, h.context.policy);
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session' }, config);
  const snapshot = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'completed', snapshot.reason);
  assert.ok(counts > 0, 'the real counter ran for the non-empty search envelope');
  const toolIntent = h.store.load(scope, 'run').intents.find(i => i.kind === 'tool');
  const toolReceipt = h.store.load(scope, 'run').receipts.find(r => r.operationKey === toolIntent.operationKey);
  assert.equal(toolReceipt.result.results[0].status, 'ok', 'search_memory returned ok, not an error');
  assert.ok(toolReceipt.result.results[0].content.records.length >= 1, 'non-empty search returned the seeded record');
  searchHost.close();
});

// Two sessions share ONE preset gateway (the real production shape). Session A
// hangs in a deferred manage_memory approval; session B binds its own owner on
// the SAME gateway, runs a manage_memory that succeeds and terminates; then A
// is approved and its write commits; A releases; B runs another tool and still
// works. Proves per-session owner isolation: B's bind/release never interrupts
// A, A's release never removes B's shared registration, and each session's
// read/write/receipt stays in its own scope/session.
test('two sessions sharing one preset gateway isolate their Memory owners', async t => {
  const root = mkdtempSync(join(tmpdir(), 'studio-memory-parallel-'));
  const workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storeA = new SqliteRunStore(join(root, 'runsA.sqlite')), storeB = new SqliteRunStore(join(root, 'runsB.sqlite'));
  t.after(() => { storeA.close(); storeB.close(); });
  const scopeA = { ...scope, agentId: 'agent', userId: 'user-a' };
  const scopeB = { ...scope, agentId: 'agent', userId: 'user-b' };
  const spec = { runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default',
    scopes: ['user'], write: { mode: 'candidate', flushAfterTurn: false }, recall: { enabled: true, maxTokens: 1600, topK: 8, minScore: 0 } },
    context: { rollout: { memoryWrite: 'enabled' } } };
  const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec };
  const context = bindNativeContext({ description: { protocol: 'openai-chat', modelName: 'pinned', parameters: {},
    contextWindow: 16000, maxOutputTokens: 1024 }, context: spec.context });
  // Per-session approval services: A defers until approved, then returns
  // allowed-once; B resolves immediately. Separate the "arrived" signal (A is
  // mid-approval) from the "decision" release so the test never deadlocks.
  let aDecisionResolve, aArriveResolve;
  const approvalArrivedA = new Promise(r => { aArriveResolve = r; });
  const approvalDecisionA = new Promise(r => { aDecisionResolve = r; });
  const approvalA = { request: async () => { aArriveResolve(); const d = await approvalDecisionA; return d; } };
  const approvalB = { request: async () => 'allowed-once' };
  const approvalC = { request: async () => 'allowed-once' };
  const approvals = new Map([['sessionA', approvalA], ['sessionB', approvalB], ['sessionC', approvalC]]);
  const toolRegistry = new Map();
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
    approval: { request: async req => approvals.get(String(req.agent.session.id))?.request(req) },
    tools: { register: tool => { toolRegistry.set(tool.name, tool); return () => toolRegistry.delete(tool.name); },
      execute: async input => { const r = toolRegistry.get(input.name); const value = await r.execute(input.arguments, input);
        return { isError: false, value, content: r.output.render(input.arguments, value) }; } },
    get: id => id === 'approval' ? ctx.approval : id === 'sandboxPolicy' ? ctx.sandboxPolicy : undefined };
  // ONE shared preset gateway, exactly as production (one activate per preset).
  const gateway = createNativeDshTools({ ctx, config: { toolBindings: [], toolContracts: [] }, workspaceRoot, stateDir: join(root, 'state') });
  t.after(() => gateway.close());
  const capsuleFor = (sessionId, sessScope, goal) => nativeRecoveryBinding({ binding: { agentId: sessScope.agentId, agentRevision: 1 },
    input: { messages: [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: goal }] }] },
    source: { provider: 'fixture', model: 'pinned' }, selection: {}, systemPrompt: 'Answer the current user.' });
  const hostFor = (sessionId, sessScope, store, goal) => {
    const host = bindStudioNativeMemoryHost({ record, scope: sessScope, sessionId, store, storeDir: root, buildId: null, context, ctx,
      sealedCapsule: capsuleFor(sessionId, sessScope, goal) });
    const dispose = gateway.bindMemory(host);
    return { host, dispose };
  };
  // Session A: bind, start a manage_memory that hangs in deferred approval, then
  // a follow-up search_memory that must succeed after the approval resolves.
  const { host: hostA } = hostFor('sessionA', scopeA, storeA, 'Save my preference A.');
  const agentA = { session: { id: 'sessionA' } };
  let modelsA = 0;
  const modelA = { generate: async () => {
    if (++modelsA === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'a1', name: 'manage_memory', arguments: { action: 'remember', scope: 'user', content: 'preference A' } }] };
    if (modelsA === 2) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'a2', name: 'search_memory', arguments: { query: 'preference' } }] };
    return { kind: 'final_candidate', text: 'Done A', usage: emptyUsage(), toolCalls: [] }; } };
  const agentPortA = gateway.forAgent(agentA, { scope: scopeA, store: storeA });
  const portsA = { ...agentPortA, tools: { execute: agentPortA.tools.execute }, model: modelA, context: context.port };
  const kernelA = new NativeKernel({ store: storeA, ports: portsA, digest, owner: 'parallel-A' });
  const configA = configFor('Save my preference A.', hostA.port.definitions, null, capsuleFor('sessionA', scopeA, 'Save my preference A.'), context.policy);
  kernelA.start({ ...fixture().snapshot, runId: 'runA', sessionId: 'sessionA', scope: scopeA }, configA);
  const runPromiseA = kernelA.runUntilIdle(scopeA, 'runA');
  await approvalArrivedA; // A is mid-approval (deferred), in executing_tools.
  // Session B: bind its OWN owner on the same gateway, run a manage_memory that
  // succeeds (approval resolves immediately) and terminate.
  const { host: hostB, dispose: disposeB } = hostFor('sessionB', scopeB, storeB, 'Save my preference B.');
  const agentB = { session: { id: 'sessionB' } };
  let modelsB = 0;
  const modelB = { generate: async () => { if (++modelsB === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
    toolCalls: [{ callId: 'b1', name: 'manage_memory', arguments: { action: 'remember', scope: 'user', content: 'preference B' } }] };
    return { kind: 'final_candidate', text: 'Done B', usage: emptyUsage(), toolCalls: [] }; } };
  const agentPortB = gateway.forAgent(agentB, { scope: scopeB, store: storeB });
  const portsB = { ...agentPortB, tools: { execute: agentPortB.tools.execute }, model: modelB, context: context.port };
  const kernelB = new NativeKernel({ store: storeB, ports: portsB, digest, owner: 'parallel-B' });
  const configB = configFor('Save my preference B.', hostB.port.definitions, null, capsuleFor('sessionB', scopeB, 'Save my preference B.'), context.policy);
  kernelB.start({ ...fixture().snapshot, runId: 'runB', sessionId: 'sessionB', scope: scopeB }, configB);
  const snapB = await kernelB.runUntilIdle(scopeB, 'runB');
  assert.equal(snapB.phase, 'completed', snapB.reason);
  // B wrote its own fact in its own scope.
  const provB = new SqliteNativeMemoryProvider(memoryFile(root, scopeB), { principal: scopeB });
  try { assert.equal(provB.list().length, 1); assert.equal(provB.list()[0].content, 'preference B'); } finally { provB.close(); }
  // A wrote nothing yet (still deferred).
  const provA0 = new SqliteNativeMemoryProvider(memoryFile(root, scopeA), { principal: scopeA });
  try { assert.equal(provA0.list().length, 0); } finally { provA0.close(); }
  // Release session B (releaseResources): it drops only B's owner entry; A's
  // deferred approval and the shared Memory registration are untouched.
  disposeB(); // drops B's routing entry only; shared registration stays
  hostB.close();
  // Now approve A: its write must commit (the shared registration was NOT removed
  // by B's release), then A's follow-up search_memory must succeed. A was not
  // interrupted by B's bind/release.
  aDecisionResolve('allowed-once');
  const snapA = await runPromiseA;
  assert.equal(snapA.phase, 'completed', `A completed, not interrupted by B: ${snapA.phase}/${snapA.reason}`);
  const provA = new SqliteNativeMemoryProvider(memoryFile(root, scopeA), { principal: scopeA });
  try { assert.equal(provA.list().length, 1, 'A committed its write after approval, not interrupted by B');
    assert.equal(provA.list()[0].content, 'preference A'); } finally { provA.close(); }
  // A's post-approval search_memory succeeded (read-only, not misjudged as a write).
  const aRecord = storeA.load(scopeA, 'runA');
  const aSearchReceipt = aRecord.receipts.flatMap(r => r.result.results ?? []).find(r => r.content?.records !== undefined);
  assert.ok(aSearchReceipt && aSearchReceipt.status === 'ok', 'A search_memory succeeded after approval (read not misjudged as write)');
  // After A releases, B's owner is already gone but the shared registration is
  // intact; a fresh session C can bind and run. (A's release must not remove it.)
  hostA.close();
  const scopeC = { ...scope, agentId: 'agent', userId: 'user-c' };
  const storeC = new SqliteRunStore(join(root, 'runsC.sqlite')); t.after(() => storeC.close());
  const { host: hostC } = hostFor('sessionC', scopeC, storeC, 'Save my preference C.');
  const agentC = { session: { id: 'sessionC' } };
  let modelsC = 0;
  const modelC = { generate: async () => { if (++modelsC === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(),
    toolCalls: [{ callId: 'c1', name: 'manage_memory', arguments: { action: 'remember', scope: 'user', content: 'preference C' } }] };
    return { kind: 'final_candidate', text: 'Done C', usage: emptyUsage(), toolCalls: [] }; } };
  const agentPortC = gateway.forAgent(agentC, { scope: scopeC, store: storeC });
  const portsC = { ...agentPortC, tools: { execute: agentPortC.tools.execute }, model: modelC, context: context.port };
  const kernelC = new NativeKernel({ store: storeC, ports: portsC, digest, owner: 'parallel-C' });
  const configC = configFor('Save my preference C.', hostC.port.definitions, null, capsuleFor('sessionC', scopeC, 'Save my preference C.'), context.policy);
  kernelC.start({ ...fixture().snapshot, runId: 'runC', sessionId: 'sessionC', scope: scopeC }, configC);
  const snapC = await kernelC.runUntilIdle(scopeC, 'runC');
  assert.equal(snapC.phase, 'completed', snapC.reason);
  // C's manage_memory actually committed (tool receipt ok, not just phase).
  const cRecord = storeC.load(scopeC, 'runC');
  const cToolReceipt = cRecord.receipts.flatMap(r => r.result.results ?? []).find(r => r.content?.committed === true || r.content?.status === 'deleted');
  assert.ok(cToolReceipt && cToolReceipt.status === 'ok', 'C manage_memory committed (receipt ok, not just phase)');
  const provC = new SqliteNativeMemoryProvider(memoryFile(root, scopeC), { principal: scopeC });
  try { assert.equal(provC.list().length, 1); assert.equal(provC.list()[0].content, 'preference C'); } finally { provC.close(); }
  hostC.close();
});
