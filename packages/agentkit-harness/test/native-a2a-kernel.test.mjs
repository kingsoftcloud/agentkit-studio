// Real NativeKernel + SqliteRunStore + createNativeToolAuthority integration test
// for the A2A tools. NOT fake always-true authority — uses the actual
// ledger-backed authority imported from src/providers/native-tool-authority.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { NativeKernel, configure, emptyUsage, canonical } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createNativeA2aToolPort, nativeA2aToolDefinitions } from '../src/native/a2a-tools.mjs';

const tmp = realpathSync(tmpdir());

// Import the production authority rather than substituting an always-true guard.
import { createNativeToolAuthority } from '../../../src/providers/native-tool-authority.mjs';

// ---- Mock discovery/invocation/exposurePlan for A2A ----

function makeDiscovery(agents) {
  return { list: async ({ signal }) => { signal?.throwIfAborted?.(); return agents; } };
}

function makeInvocation(opts = {}) {
  const { failDispatch = false, status = 'completed', outputRefs = null, snapshots = null, itemKinds = null, taskId = 'a2a-task-001', delayMs = 0 } = opts;
  let dispatchCount = 0;
  return {
    resolve: async ({ signal }) => {
      signal?.throwIfAborted?.();
      return { spec: { target_agent_id: 'a2a-agent-remote-1', binding_id: 'binding-1', space_id: 'a2a-space-1' }, trigger: { scope_id: 'scope-1', item_id: 'item-1', call_id: 'call-1' } };
    },
    dispatch: async ({ request, trigger, signal }) => {
      dispatchCount++;
      signal?.throwIfAborted?.();
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      if (failDispatch) throw Object.assign(new Error('network failed'), { code: 'A2A_NETWORK_ERROR' });
      const result = { agent: request.spec.target_agent_id, task_id: taskId, state: status };
      if (outputRefs) { result.output_refs = outputRefs; result.snapshots = snapshots || {}; result.item_kinds = itemKinds || {}; }
      return result;
    },
    _dispatchCount: () => dispatchCount,
  };
}

function makeExposurePlan(opts = {}) {
  const { allowedTargets = ['a2a-agent-remote-1'], asyncReject = false } = opts;
  return {
    assertGenericTargetAllowed: (targetId) => {
      if (asyncReject) return Promise.reject(Object.assign(new Error('PLAN_DENIED'), { code: 'PLAN_DENIED' }));
      if (!allowedTargets.includes(targetId)) throw Object.assign(new Error('not allowed'), { code: 'A2A_TARGET_NOT_ALLOWED' });
    },
  };
}

const BINDING_DESC = { sourceRef: 'a2a-space-1', sourceDigest: 'sha256:abc', spaceId: 'a2a-space-1', planDigest: 'sha256:plan1', transport: 'managed-invocation/v1', version: 'v1' };
const AGENTS = [{ agent_id: 'a2a-agent-remote-1', name: 'research-agent', description: 'A research agent', version_id: 'v1', source: 'hosted', url: 'https://example.com/card' }];

function setupKernel(t, { maxModelCalls = 2, toolName = 'list_a2a_agents', toolArgs = {}, invocationOpts = {}, exposureOpts = {} }) {
  const root = mkdtempSync(join(tmp, 'a2a-kernel-'));
  const store = new SqliteRunStore(join(root, 'runs.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const a2aDefs = nativeA2aToolDefinitions();
  let toolCallCount = 0;
  let toolExecutor = null;
  const discovery = makeDiscovery(AGENTS);
  const invocation = makeInvocation(invocationOpts);
  const exposurePlan = makeExposurePlan(exposureOpts);
  const ports = {
    model: { generate: async request => {
      if (request.messages[0]?.kind === 'compaction_instructions') return { kind: 'final_candidate', text: 'Compacted.', toolCalls: [], usage: emptyUsage() };
      const modelCalls = request.messages.filter(m => m.role === 'assistant').length;
      if (modelCalls === 0) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'call-1', name: toolName, arguments: toolArgs }], usage: emptyUsage() };
      return { kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async req => { toolCallCount++; return toolExecutor ? toolExecutor(req) : { status: 'ok', content: { ok: true } }; } },
  };
  const worker = () => new NativeKernel({ store, ports, digest, owner: 'test-worker' });
  const config = configure({ ...fixture().config, instructions: 'A2A test.',
    contract: { ...fixture().config.contract, objective: 'A2A test.' },
    tools: a2aDefs, inputMessages: [{ role: 'user', kind: 'user_input', content: 'List A2A agents' }],
    limits: { ...fixture().config.limits, maxModelCalls, maxToolCalls: 5, leaseMs: 60000, effectTimeoutMs: 660000, finalizationReserveModelCalls: 0 },
    profile: { ...fixture().config.profile, requestTimeoutMs: 30000 } });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const toolPort = createNativeA2aToolPort({
    scope, sessionId: 'session', spaceId: 'a2a-space-1', discovery, invocation, exposurePlan,
    authorize: async () => 'allow', assertCurrent: authority, bindingDescription: BINDING_DESC,
  });
  return { root, store, worker, config, toolCallCount: () => toolCallCount, setToolExecutor: fn => { toolExecutor = fn; }, toolPort, authority, invocation };
}

// ---- Tests -----------------------------------------------------------------

test('real Kernel+SQLite+ToolAuthority: list_a2a_agents completes with real authority', async t => {
  const { store, worker, config, toolCallCount, setToolExecutor, toolPort } = setupKernel(t, { toolName: 'list_a2a_agents', toolArgs: {} });
  setToolExecutor(req => toolPort.execute(req));
  worker().start({ ...fixture().snapshot, runId: 'run-1', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-1');
  const record = store.load(scope, 'run-1');
  assert.equal(record.snapshot.phase, 'completed', 'run completed');
  assert.equal(toolCallCount(), 1, 'tool executed once');
  const receipts = record.receipts;
  assert.ok(receipts.length >= 1, 'ledger has receipts');
  const toolReceipt = receipts.find(r => r.result?.results?.[0]?.content?.ok === true);
  assert.ok(toolReceipt, 'tool receipt with ok:true found');
});

test('real Kernel+SQLite: call_a2a_agent with completed output_refs returns selected reply', async t => {
  const outputRefs = [{ scope_id: 's1', item_id: 'art-1', part_id: null }];
  const snapshots = { 's1:art-1': { p1: 'result text' } };
  const itemKinds = { 's1:art-1': 'artifact' };
  const { store, worker, config, toolCallCount, setToolExecutor, toolPort } = setupKernel(t, {
    toolName: 'call_a2a_agent', toolArgs: { agent: 'a2a-agent-remote-1', message: 'hello' },
    invocationOpts: { outputRefs, snapshots, itemKinds },
  });
  setToolExecutor(req => toolPort.execute(req));
  worker().start({ ...fixture().snapshot, runId: 'run-call', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-call');
  const record = store.load(scope, 'run-call');
  assert.equal(record.snapshot.phase, 'completed');
  assert.equal(toolCallCount(), 1);
  const receipt = record.receipts.find(r => r.result?.results?.[0]?.content?.reply === 'result text');
  assert.ok(receipt, 'receipt has selected reply from output_refs');
});

test('real Kernel+SQLite: async exposurePlan rejection prevents dispatch (zero dispatches)', async t => {
  const { store, worker, config, toolCallCount, setToolExecutor, toolPort, invocation } = setupKernel(t, {
    toolName: 'call_a2a_agent', toolArgs: { agent: 'a2a-agent-remote-1', message: 'hello' },
    exposureOpts: { asyncReject: true },
  });
  setToolExecutor(req => toolPort.execute(req));
  worker().start({ ...fixture().snapshot, runId: 'run-plan', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-plan');
  assert.equal(invocation._dispatchCount(), 0, 'NO dispatch occurred — async plan rejected');
  // The run may complete (error result) or be interrupted. Check the receipt.
  const record = store.load(scope, 'run-plan');
  const toolReceipt = record.receipts.find(r => r.result?.results?.[0]?.content?.error_type === 'A2A_EXPOSURE_PLAN_INVALID_RETURN');
  assert.ok(toolReceipt, 'receipt shows A2A_EXPOSURE_PLAN_INVALID_RETURN');
});

test('real Kernel+SQLite: sync exposurePlan target rejection prevents dispatch', async t => {
  const { store, worker, config, setToolExecutor, toolPort, invocation } = setupKernel(t, {
    toolName: 'call_a2a_agent', toolArgs: { agent: 'a2a-agent-remote-1', message: 'hello' },
    exposureOpts: { allowedTargets: ['a2a-agent-other'] },
  });
  setToolExecutor(req => toolPort.execute(req));
  worker().start({ ...fixture().snapshot, runId: 'run-sync', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-sync');
  assert.equal(invocation._dispatchCount(), 0, 'NO dispatch — sync plan rejected');
  const record = store.load(scope, 'run-sync');
  const toolReceipt = record.receipts.find(r => r.result?.results?.[0]?.content?.error_type === 'A2A_TARGET_NOT_ALLOWED');
  assert.ok(toolReceipt, 'receipt shows A2A_TARGET_NOT_ALLOWED');
});

test('real Kernel+SQLite: dispatch failure returns uncertain with frozen locator', async t => {
  const { store, worker, config, setToolExecutor, toolPort } = setupKernel(t, {
    toolName: 'call_a2a_agent', toolArgs: { agent: 'a2a-agent-remote-1', message: 'hello' },
    invocationOpts: { failDispatch: true },
  });
  setToolExecutor(req => toolPort.execute(req));
  worker().start({ ...fixture().snapshot, runId: 'run-fail', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  const result = await worker().runUntilIdle(scope, 'run-fail');
  // Dispatch failed → uncertain. The run should be interrupted or have an uncertain receipt.
  const record = store.load(scope, 'run-fail');
  const uncertainReceipt = record.receipts.find(r => r.result?.results?.some(res => res.status === 'uncertain' || res.content?.error_type === 'A2A_INVOCATION_UNCERTAIN'));
  assert.ok(uncertainReceipt || result.phase === 'interrupted', 'uncertain receipt or interrupted phase');
  if (uncertainReceipt) {
    const res = uncertainReceipt.result.results.find(r => r.content?.error_type === 'A2A_INVOCATION_UNCERTAIN' || r.status === 'uncertain');
    assert.ok(res, 'uncertain result found');
    if (res.content?.operation_locator) {
      assert.equal(res.content.operation_locator.scope.agentId, scope.agentId, 'locator uses bound scope');
      assert.equal(res.content.operation_locator.runId, 'run-fail', 'locator has correct runId');
    }
  }
});

test('real Kernel+SQLite: wrong scope rejected by createNativeToolAuthority', async t => {
  const { store, worker, config, toolCallCount, setToolExecutor, authority, toolPort } = setupKernel(t, { toolName: 'list_a2a_agents' });
  setToolExecutor(req => {
    // Verify authority rejects wrong scope
    assert.equal(authority({ ...req, scope: { ...scope, workspaceId: 'foreign' } }), false, 'wrong scope rejected');
    assert.equal(authority(req), true, 'correct scope accepted');
    return toolPort.execute(req);
  });
  worker().start({ ...fixture().snapshot, runId: 'run-scope', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-scope');
  assert.equal(toolCallCount(), 1, 'tool executed');
  assert.equal(store.load(scope, 'run-scope').snapshot.phase, 'completed');
});

test('real Kernel+SQLite: wrong sessionId rejected by authority', async t => {
  const { store, worker, config, setToolExecutor, authority, toolPort } = setupKernel(t, { toolName: 'list_a2a_agents' });
  setToolExecutor(req => {
    assert.equal(authority({ ...req, sessionId: 'wrong' }), false, 'wrong session rejected');
    return toolPort.execute(req);
  });
  worker().start({ ...fixture().snapshot, runId: 'run-sess', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-sess');
  // The toolPort will get authority=false from assertCurrent → a2a_lease_lost.
  const record = store.load(scope, 'run-sess');
  assert.equal(record.snapshot.phase, 'completed', 'run completes (error result, not crash)');
});

test('real Kernel+SQLite: wrong executionFence rejected by authority', async t => {
  const { store, worker, config, setToolExecutor, authority, toolPort } = setupKernel(t, { toolName: 'list_a2a_agents' });
  setToolExecutor(req => {
    assert.equal(authority({ ...req, executionFence: 999 }), false, 'wrong fence rejected');
    assert.equal(authority(req), true, 'correct fence accepted');
    return toolPort.execute(req);
  });
  worker().start({ ...fixture().snapshot, runId: 'run-fence', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  await worker().runUntilIdle(scope, 'run-fence');
  assert.equal(store.load(scope, 'run-fence').snapshot.phase, 'completed');
});

test('real Kernel+SQLite: SQLite reopen — unknown cold recovery does not re-dispatch', async t => {
  const root = mkdtempSync(join(tmp, 'a2a-reopen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sqlitePath = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(sqlitePath);
  const a2aDefs = nativeA2aToolDefinitions();
  let toolCallCount = 0;
  let toolExecutor = null;
  const discovery = makeDiscovery(AGENTS);
  const invocation = makeInvocation({ failDispatch: true }); // dispatch throws → uncertain
  const exposurePlan = makeExposurePlan();
  const ports = {
    model: { generate: async request => {
      if (request.messages[0]?.kind === 'compaction_instructions') return { kind: 'final_candidate', text: 'Compacted.', toolCalls: [], usage: emptyUsage() };
      const modelCalls = request.messages.filter(m => m.role === 'assistant').length;
      if (modelCalls === 0) return { kind: 'tool_calls', text: '', toolCalls: [{ callId: 'call-1', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }], usage: emptyUsage() };
      return { kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async req => { toolCallCount++; return toolExecutor ? toolExecutor(req) : { status: 'ok', content: { ok: true } }; } },
  };
  const config = configure({ ...fixture().config, instructions: 'A2A reopen test.',
    contract: { ...fixture().config.contract, objective: 'A2A reopen test.' },
    tools: a2aDefs, inputMessages: [{ role: 'user', kind: 'user_input', content: 'Call A2A agent' }],
    limits: { ...fixture().config.limits, maxModelCalls: 2, maxToolCalls: 5, leaseMs: 60000, effectTimeoutMs: 660000, finalizationReserveModelCalls: 0 },
    profile: { ...fixture().config.profile, requestTimeoutMs: 30000 } });
  const authority = createNativeToolAuthority({ scope, sessionId: 'session', store });
  const toolPort = createNativeA2aToolPort({
    scope, sessionId: 'session', spaceId: 'a2a-space-1', discovery, invocation, exposurePlan,
    authorize: async () => 'allow', assertCurrent: authority, bindingDescription: BINDING_DESC,
  });
  // First run: dispatch fails → uncertain → interrupted.
  const kernel1 = new NativeKernel({ store, ports, digest, owner: 'first' });
  kernel1.start({ ...fixture().snapshot, runId: 'run-reopen', parentRunId: null, sessionId: 'session', buildId: 'build-1' }, config);
  toolExecutor = req => toolPort.execute(req);
  const result1 = await kernel1.runUntilIdle(scope, 'run-reopen');
  assert.equal(toolCallCount, 1, 'tool called once in first run');
  // Close and reopen SQLite.
  store.close();
  store = new SqliteRunStore(sqlitePath);
  // Replacement kernel: should NOT re-execute the tool (the run is already
  // in an interrupted/uncertain state, not preparing_context).
  const kernel2 = new NativeKernel({ store, ports: {
    model: ports.model, tools: { execute: async req => { toolCallCount++; return toolExecutor(req); } },
  }, digest, owner: 'replacement' });
  // The replacement kernel should find the run in a terminal/interrupted state
  // and not re-execute the tool.
  const result2 = await kernel2.runUntilIdle(scope, 'run-reopen');
  assert.equal(toolCallCount, 1, 'tool NOT re-executed after reopen');
  store.close();
});
