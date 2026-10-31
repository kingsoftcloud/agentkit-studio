import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeA2aToolPort, nativeA2aToolDefinitions } from '../src/native/a2a-tools.mjs';

const allowAuthorize = async () => 'allow';
const sig = () => new AbortController().signal;
const assertCurrentTrue = () => true;
const SCOPE = { tenantId: 't1', workspaceId: 'w1', userId: 'u1', agentId: 'ar-local-aabbccddee001122' };
const SESSION_ID = 's1';
const FENCE = 1;
const BINDING_DESC = { sourceRef: 'a2a-space-1', sourceDigest: 'sha256:abc', spaceId: 'a2a-space-1', planDigest: 'sha256:plan1', transport: 'managed-invocation/v1', version: 'v1' };

function makeRequest(call, extra = {}) {
  const definition = DEFINITIONS.get(call.name);
  return { sessionId: SESSION_ID, scope: SCOPE, runId: 'r1', turnId: 't1', buildId: 'b1', parentRunId: null, taskChainId: 'c1', operationKey: 'o1', executionFence: FENCE, signal: sig(), definition, call, ...extra };
}
let DEFINITIONS = new Map();
function setDefinitions(defs) { DEFINITIONS = new Map(defs.map(d => [d.name, d])); }

function makeDiscovery(agents) {
  return { list: async ({ signal }) => { signal?.throwIfAborted?.(); return agents; } };
}

function makeInvocation(opts = {}) {
  const { failDispatch = false, status = 'completed', outputRefs = null, snapshots = null, itemKinds = null, taskId = 'a2a-task-001', delayMs = 0 } = opts;
  let dispatchCount = 0;
  return {
    resolve: async ({ agent, message, signal }) => {
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
      if (!allowedTargets.includes(targetId)) throw Object.assign(new Error('target not allowed'), { code: 'A2A_TARGET_NOT_ALLOWED' });
    },
  };
}

function makeTools(agents = [], invocationOpts = {}, exposureOpts = {}) {
  const discovery = makeDiscovery(agents);
  const invocation = makeInvocation(invocationOpts);
  const exposurePlan = makeExposurePlan(exposureOpts);
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery, invocation, exposurePlan, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  return { tools, invocation };
}

const AGENTS = [
  { agent_id: 'a2a-agent-remote-1', name: 'research-agent', description: 'A research agent', version_id: 'a2a-version-001', card_sha256: 'abc', source: 'hosted', url: 'https://user:pass@example.com/card?q=secret' },
  { agent_id: 'a2a-agent-remote-2', name: 'code-agent', description: 'A code agent', version_id: 'a2a-version-002', card_sha256: 'def', source: 'hosted', url: 'https://example.com/card2' },
];

// ---- Review2 counter-example 1: byte budget on agent list ----

test('list_a2a_agents enforces actual JSON byte budget (not count-based)', async () => {
  // 100 agents × 5000 chars each — well over 256KB
  const bigAgents = Array.from({ length: 100 }, (_, i) => ({
    agent_id: `a2a-agent-${i}`, name: `agent-${i}`, description: '字'.repeat(5000), version_id: 'v1', source: 'hosted', url: 'https://example.com',
  }));
  const { tools } = makeTools(bigAgents);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} }));
  assert.equal(r.status, 'ok');
  const jsonBytes = Buffer.byteLength(JSON.stringify(r.content));
  assert.ok(jsonBytes <= 256 * 1024, `actual JSON bytes ${jsonBytes} must be <= 262144`);
});

test('list_a2a_agents strips userinfo and query from URLs', async () => {
  const { tools } = makeTools(AGENTS);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} }));
  assert.equal(r.status, 'ok');
  const url0 = r.content.agents[0].url;
  assert.doesNotMatch(url0, /user|pass|secret/);
  assert.equal(url0, 'https://example.com/card');
});

test('list_a2a_agents strips secret fields from discovery metadata', async () => {
  const agentsWithSecrets = [{ agent_id: 'a2a-agent-1', name: 'test', api_key: 'SECRET', token: 'LEAK' }];
  const { tools } = makeTools(agentsWithSecrets);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} }));
  assert.equal(r.status, 'ok');
  assert.doesNotMatch(JSON.stringify(r.content), /SECRET|LEAK/);
});

// ---- Review2 counter-example 2: async exposurePlan rejection ----

test('async exposurePlan rejection (thenable) prevents dispatch — no unhandledRejection', async () => {
  const { tools, invocation } = makeTools(AGENTS, {}, { asyncReject: true });
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'A2A_EXPOSURE_PLAN_INVALID_RETURN');
  assert.equal(r.content.executed, undefined); // not uncertain — pre-dispatch
  assert.equal(invocation._dispatchCount(), 0, 'no dispatch occurred');
});

test('exposurePlan returning false (non-undefined) prevents dispatch', async () => {
  const discovery = makeDiscovery(AGENTS);
  const falsePlan = { assertGenericTargetAllowed: () => false };
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery, invocation: makeInvocation(), exposurePlan: falsePlan, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'A2A_EXPOSURE_PLAN_INVALID_RETURN');
});

test('exposurePlan returning 0 (non-undefined) prevents dispatch', async () => {
  const discovery = makeDiscovery(AGENTS);
  const zeroPlan = { assertGenericTargetAllowed: () => 0 };
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery, invocation: makeInvocation(), exposurePlan: zeroPlan, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'A2A_EXPOSURE_PLAN_INVALID_RETURN');
});

test('exposure plan required (fail closed) — no exposurePlan means no call', async () => {
  const discovery = makeDiscovery(AGENTS);
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery, invocation: makeInvocation(), exposurePlan: null, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.content.error_type, 'A2A_EXPOSURE_PLAN_REQUIRED');
});

test('exposure plan target rejection prevents dispatch (sync throw)', async () => {
  const { tools, invocation } = makeTools(AGENTS, {}, { allowedTargets: ['a2a-agent-other'] });
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'A2A_TARGET_NOT_ALLOWED');
  assert.equal(invocation._dispatchCount(), 0, 'no dispatch occurred');
});

// ---- effectStarted correctness ----

test('pre-dispatch failure (resolve) does NOT report executed=true', async () => {
  const failingResolve = {
    resolve: async () => { throw Object.assign(new Error('resolve failed'), { code: 'A2A_RESOLVE_FAILED' }); },
    dispatch: async () => ({ ok: true }),
    _dispatchCount: () => 0,
  };
  const discovery = makeDiscovery(AGENTS);
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery, invocation: failingResolve, exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'A2A_INVOCATION_FAILED');
  assert.equal(r.content.executed, undefined);
});

// ---- Terminal status validation ----

test('call_a2a_agent with completed status + output_refs returns selected reply', async () => {
  const outputRefs = [{ scope_id: 's1', item_id: 'art-1', part_id: null }];
  const snapshots = { 's1:art-1': { p1: 'artifact result' } };
  const itemKinds = { 's1:art-1': 'artifact' };
  const { tools } = makeTools(AGENTS, { outputRefs, snapshots, itemKinds });
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'ok');
  assert.equal(r.content.reply, 'artifact result');
  assert.equal(r.content.state, 'completed');
});

test('call_a2a_agent with working status returns uncertain (not ok)', async () => {
  const { tools } = makeTools(AGENTS, { status: 'working' });
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.error_type, 'A2A_INVOCATION_UNCERTAIN');
});

test('call_a2a_agent with failed status returns error', async () => {
  const { tools } = makeTools(AGENTS, { status: 'failed' });
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.ok, false);
  assert.equal(r.content.state, 'failed');
  assert.equal(r.content.reply, '');
});

test('call_a2a_agent dispatch failure returns uncertain with frozen locator', async () => {
  const { tools } = makeTools(AGENTS, { failDispatch: true });
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.status, 'uncertain');
  assert.equal(r.content.executed, true);
  assert.equal(r.content.operation_locator.scope.agentId, SCOPE.agentId);
  assert.equal(r.content.operation_locator.runId, 'r1');
});

// ---- Other tests ----

test('definitions are sealed with correct risk levels', () => {
  const defs = nativeA2aToolDefinitions();
  assert.deepEqual(defs.map(d => d.name), ['list_a2a_agents', 'get_a2a_agent_card', 'call_a2a_agent']);
  assert.equal(defs[0].readOnly, true);
  assert.equal(defs[2].readOnly, false);
  assert.ok(defs[2].permissions.includes('a2a:call'));
});

test('get_a2a_agent_card matches by id and returns sanitized agent', async () => {
  const { tools } = makeTools(AGENTS);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'get_a2a_agent_card', arguments: { agent: 'a2a-agent-remote-1' } }));
  assert.equal(r.status, 'ok');
  assert.equal(r.content.agent.name, 'research-agent');
  assert.doesNotMatch(r.content.agent.url, /user|pass/);
});

test('get_a2a_agent_card returns bounded hints when not found', async () => {
  const { tools } = makeTools(AGENTS);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'get_a2a_agent_card', arguments: { agent: 'nonexistent' } }));
  assert.equal(r.content.ok, false);
  assert.ok(r.content.available_agents.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(r.content)) <= 64 * 1024);
});

test('call_a2a_agent requires non-empty message', async () => {
  const { tools } = makeTools(AGENTS);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: '' } }));
  assert.equal(r.content.ok, false);
  assert.equal(r.content.error_message, 'message is required');
});

test('call_a2a_agent without invocation context returns context required', async () => {
  const discovery = makeDiscovery(AGENTS);
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery, invocation: null, exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.content.error_type, 'A2A_MANAGED_INVOCATION_CONTEXT_REQUIRED');
});

test('list_a2a_agents without spaceId returns not configured', async () => {
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: '', discovery: makeDiscovery(AGENTS), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} }));
  assert.equal(r.content.error_message, 'A2A Space not configured');
});

test('assertCurrent false prevents discovery', async () => {
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery: makeDiscovery(AGENTS), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: () => false, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} }));
  assert.equal(r.content.code, 'a2a_lease_lost');
});

test('assertCurrent thenable observed and rejected', async () => {
  let observed = false;
  const thenableAssert = () => { const p = Promise.resolve(true); p.then(() => {}, () => {}); observed = true; return p; };
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery: makeDiscovery(AGENTS), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: thenableAssert, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} }));
  assert.equal(r.content.code, 'a2a_lease_lost');
  assert.equal(observed, true);
});

test('context drift after authorize rejects', async () => {
  let resolveAuthorize;
  const slowAuthorize = () => new Promise(r => { resolveAuthorize = r; });
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery: makeDiscovery(AGENTS), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: slowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const req = makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} });
  const promise = tools.execute(req);
  req.runId = 'changed';
  resolveAuthorize('allow');
  const r = await promise;
  assert.equal(r.content.code, 'a2a_context_drift');
});

test('high-risk call requires explicit approval', async () => {
  const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery: makeDiscovery(AGENTS), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: async () => ({ status: 'error' }), assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
  setDefinitions(tools.definitions);
  const r = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'a2a-agent-remote-1', message: 'hello' } }));
  assert.equal(r.content.code, 'policy_denied');
});

test('bindingDigest changes with different plan', () => {
  const { tools } = makeTools(AGENTS);
  const desc2 = { ...BINDING_DESC, planDigest: 'sha256:plan2' };
  const tools2 = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery: makeDiscovery(AGENTS), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: desc2 });
  assert.notEqual(tools.bindingDigest, tools2.bindingDigest);
});

test('bindingDescription required', () => {
  assert.throws(() => createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 's', discovery: makeDiscovery([]), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: assertCurrentTrue }), /a2a_binding_description_required/);
  assert.throws(() => createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 's', discovery: makeDiscovery([]), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: { sourceRef: 'x' } }), /a2a_source_digest_required/);
});

test('definitions deep-copied', () => {
  const { tools } = makeTools(AGENTS);
  tools.definitions[0].readOnly = false;
  assert.equal(nativeA2aToolDefinitions()[0].readOnly, true);
});

test('target-plan identity drift rejects before dispatch without reporting an unknown effect', async () => {
  let request;
  const invocation = makeInvocation();
  const tools = createNativeA2aToolPort({
    scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1',
    discovery: makeDiscovery(AGENTS), invocation,
    exposurePlan: { assertGenericTargetAllowed() { request.runId = 'foreign-run'; } },
    authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC,
  });
  setDefinitions(tools.definitions);
  request = makeRequest({ callId: 'original-call', name: 'call_a2a_agent', arguments: { agent: 'research-agent', message: 'hello' } });
  const result = await tools.execute(request);
  assert.equal(invocation._dispatchCount(), 0);
  assert.equal(result.status, 'error');
  assert.equal(result.content.executed, false);
  assert.equal(result.content.error_type, 'a2a_context_drift');
});

test('abort while interpreting a dispatched result retains original task and complete operation locator', async () => {
  const controller = new AbortController();
  let dispatches = 0;
  const invocation = makeInvocation();
  invocation.dispatch = async () => {
    dispatches++;
    return { task_id: 'original-remote-task', get state() { controller.abort(); return 'completed'; }, output_refs: [] };
  };
  const tools = createNativeA2aToolPort({
    scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1',
    discovery: makeDiscovery(AGENTS), invocation, exposurePlan: makeExposurePlan(),
    authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC,
  });
  setDefinitions(tools.definitions);
  const request = makeRequest({ callId: 'original-call', name: 'call_a2a_agent', arguments: { agent: 'research-agent', message: 'hello' } }, { signal: controller.signal });
  const result = await tools.execute(request);
  assert.equal(dispatches, 1);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.content.executed, true);
  assert.equal(result.content.task_id, 'original-remote-task');
  assert.deepEqual(result.content.operation_locator, {
    scope: SCOPE, sessionId: SESSION_ID, runId: 'r1', turnId: 't1', buildId: 'b1',
    parentRunId: null, taskChainId: 'c1', operationKey: 'o1', executionFence: FENCE, callId: 'original-call',
  });
});

test('discovery output byte limit includes the actual configured space id', async () => {
  const spaceId = '字'.repeat(100_000);
  const tools = createNativeA2aToolPort({
    scope: SCOPE, sessionId: SESSION_ID, spaceId,
    discovery: makeDiscovery([]), invocation: makeInvocation(), exposurePlan: makeExposurePlan(),
    authorize: allowAuthorize, assertCurrent: assertCurrentTrue, bindingDescription: { ...BINDING_DESC, spaceId },
  });
  setDefinitions(tools.definitions);
  const result = await tools.execute(makeRequest({ callId: 'c', name: 'list_a2a_agents', arguments: {} }));
  assert.equal(result.status, 'error');
  assert.equal(result.content.error_type, 'a2a_discovery_result_too_large');
  assert.ok(Buffer.byteLength(JSON.stringify(result.content)) <= 256 * 1024);
});

for (const phase of ['authorize', 'discovery', 'resolve', 'dispatch']) {
  test(`cancellation settles a non-cooperative ${phase} without late dispatch or unhandled rejection`, async () => {
    const controller = new AbortController(), entered = Promise.withResolvers(), pending = Promise.withResolvers();
    const invocation = makeInvocation();
    let dispatches = 0;
    const hang = () => { entered.resolve(); return pending.promise; };
    if (phase === 'resolve') invocation.resolve = hang;
    invocation.dispatch = phase === 'dispatch' ? () => { dispatches++; return hang(); }
      : () => { dispatches++; assert.fail('cancelled pre-dispatch work must not dispatch later'); };
    const tools = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1',
      discovery: phase === 'discovery' ? { list: hang } : makeDiscovery(AGENTS), invocation,
      exposurePlan: makeExposurePlan(), authorize: phase === 'authorize' ? hang : allowAuthorize,
      assertCurrent: assertCurrentTrue, bindingDescription: BINDING_DESC });
    setDefinitions(tools.definitions);
    const name = phase === 'discovery' ? 'list_a2a_agents' : 'call_a2a_agent';
    const request = makeRequest({ callId: 'original', name, arguments: name === 'call_a2a_agent'
      ? { agent: 'research', message: 'hello' } : {} }, { signal: controller.signal });
    const execution = tools.execute(request); await entered.promise;
    const reason = new Error('original cancellation'); controller.abort(reason);
    if (phase === 'dispatch') {
      const result = await execution; assert.equal(result.status, 'uncertain');
      assert.equal(result.content.executed, true); assert.equal(result.content.operation_locator.callId, 'original');
    } else await assert.rejects(execution, error => error === reason);
    // A rejection after the caller has already finished remains observed.
    pending.reject(new Error('late service failure')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, phase === 'dispatch' ? 1 : 0);
  });
}

test('terminal selection never treats inherited object properties as output kinds or parts', async () => {
  const outputRefs = [{ scope_id: 's', item_id: 'bad', part_id: null }, { scope_id: 's', item_id: 'good', part_id: 'toString' }];
  const { tools } = makeTools(AGENTS, { outputRefs, snapshots: { 's:bad': { p1: 'not a supported item' }, 's:good': {} },
    itemKinds: { 's:bad': 'toString', 's:good': 'artifact' } });
  const result = await tools.execute(makeRequest({ callId: 'c', name: 'call_a2a_agent', arguments: { agent: 'research', message: 'hello' } }));
  assert.equal(result.status, 'ok'); assert.equal(result.content.reply, '');
});

test('unknown remote task is JSON-persistable after interruption before receipt', async () => {
  const { canonical } = await import('../../agentkit-harness-core/dist/index.mjs');
  const controller = new AbortController();
  const port = createNativeA2aToolPort({ scope: SCOPE, sessionId: SESSION_ID, spaceId: 'a2a-space-1',
    discovery: makeDiscovery([]), exposurePlan: makeExposurePlan(), authorize: allowAuthorize, assertCurrent: assertCurrentTrue,
    bindingDescription: BINDING_DESC, invocation: { resolve: makeInvocation().resolve,
      dispatch: async () => { controller.abort(new Error('interrupted after send')); throw controller.signal.reason; } } });
  setDefinitions(port.definitions);
  const result = await port.execute(makeRequest({ callId: 'json-unknown', name: 'call_a2a_agent', arguments: { agent: 'remote', message: 'message' } }, { signal: controller.signal }));
  assert.equal(result.status, 'uncertain'); assert.equal(result.content.task_id, null);
  assert.equal(JSON.parse(canonical(result)).content.executed, true);
});
