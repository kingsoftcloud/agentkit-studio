import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeDshA2aTools, NATIVE_A2A_TOOLS_CONTRACT } from '../src/providers/native-dsh-a2a.mjs';

const allowAuthorize = async () => 'allow';
const assertCurrentTrue = () => true;
const SCOPE = { tenantId: 't1', workspaceId: 'w1', userId: 'u1', agentId: 'ar-local-aabbccddee001122' };
const SESSION_ID = 's1';
const BINDING_DESC = { sourceRef: 'a2a-space-1', sourceDigest: 'sha256:abc', spaceId: 'a2a-space-1', planDigest: 'sha256:plan1', transport: 'managed-invocation/v1', version: 'v1' };

function makeDiscovery(agents) { return { list: async () => agents || [] }; }
function makeInvocation() { return { resolve: async () => ({ spec: { target_agent_id: 'a2a-agent-1', binding_id: 'b1', space_id: 's1' }, trigger: {} }), dispatch: async () => ({ state: 'completed', output_refs: [] }) }; }
function makeExposurePlan() { return { assertGenericTargetAllowed: () => {} }; }

test('createNativeDshA2aTools requires authorize, assertCurrent, scope, discovery, exposurePlan, bindingDescription', () => {
  const base = { sessionId: SESSION_ID, spaceId: 's', discovery: makeDiscovery([]), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), bindingDescription: BINDING_DESC };
  assert.throws(() => createNativeDshA2aTools({ config: { ...base, scope: SCOPE, assertCurrent: assertCurrentTrue } }), /authorize callback/);
  assert.throws(() => createNativeDshA2aTools({ config: { ...base, scope: SCOPE, authorize: allowAuthorize } }), /assertCurrent/);
  assert.throws(() => createNativeDshA2aTools({ config: { ...base, authorize: allowAuthorize, assertCurrent: assertCurrentTrue } }), /bound scope/);
  const noDiscovery = { ...base, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, scope: SCOPE, discovery: undefined };
  assert.throws(() => createNativeDshA2aTools({ config: noDiscovery }), /discovery/);
  const noPlan = { ...base, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, scope: SCOPE, exposurePlan: undefined };
  assert.throws(() => createNativeDshA2aTools({ config: noPlan }), /exposure plan/);
  const noBinding = { ...base, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, scope: SCOPE, bindingDescription: undefined };
  assert.throws(() => createNativeDshA2aTools({ config: noBinding }), /binding description/);
});

test('createNativeDshA2aTools returns definitions and execute for Host wiring', () => {
  const tools = createNativeDshA2aTools({ config: { sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery: makeDiscovery([]), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), bindingDescription: BINDING_DESC, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, scope: SCOPE } });
  assert.deepEqual(tools.definitions.map(d => d.name), ['list_a2a_agents', 'get_a2a_agent_card', 'call_a2a_agent']);
  assert.equal(typeof tools.execute, 'function');
  assert.equal(tools.contract, NATIVE_A2A_TOOLS_CONTRACT);
  assert.ok(tools.bindingDigest);
});

test('production adapter does not register with Host ToolRegistry', () => {
  const tools = createNativeDshA2aTools({ config: { sessionId: SESSION_ID, spaceId: 'a2a-space-1', discovery: makeDiscovery([]), invocation: makeInvocation(), exposurePlan: makeExposurePlan(), bindingDescription: BINDING_DESC, authorize: allowAuthorize, assertCurrent: assertCurrentTrue, scope: SCOPE } });
  assert.deepEqual(Object.keys(tools).sort(), ['bindingDigest', 'contract', 'definitions', 'execute'].sort());
});
