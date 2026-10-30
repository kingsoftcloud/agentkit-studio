/**
 * Production adapter for the Native A2A tools (list_a2a_agents /
 * get_a2a_agent_card / call_a2a_agent).
 *
 * Wires the pure adapter to the Host's A2A discovery, invocation service, and
 * exposure plan. The Host integrator injects:
 *   - discovery: { list({spaceId, signal}) -> agent[] } — A2A Space discovery
 *   - invocation: { resolve, dispatch } — managed A2A invocation lifecycle
 *   - exposurePlan: { assertGenericTargetAllowed } — target validation (sync)
 *   - bindingDescription: { sourceRef, sourceDigest, spaceId, planDigest,
 *     transport, version } — serializable binding contract for bindingDigest
 *   - authorize: trusted authorize callback (required; never self-approved)
 *   - assertCurrent: sync guard (required; assertCurrent(request)===true)
 *   - scope: trusted RunScope
 *
 * This module does NOT register with the DSH ToolRegistry. It returns the
 * sealed definitions and execute entry for the Host to wire. It does not
 * claim the tools are already wired.
 */
import { createNativeA2aToolPort, NATIVE_A2A_TOOLS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/a2a-tools';

export function createNativeDshA2aTools({ config = {} } = {}) {
  const sessionId = String(config.sessionId || '');
  const spaceId = String(config.spaceId || '');
  const discovery = config.discovery;
  const invocation = config.invocation;
  const exposurePlan = config.exposurePlan;
  const bindingDescription = config.bindingDescription;
  const authorize = config.authorize;
  const assertCurrent = config.assertCurrent;
  const scope = config.scope;
  if (typeof authorize !== 'function') {
    throw Object.assign(new Error('native-dsh-a2a requires a trusted authorize callback'), { code: 'NATIVE_A2A_AUTHORIZE_REQUIRED' });
  }
  if (typeof assertCurrent !== 'function') {
    throw Object.assign(new Error('native-dsh-a2a requires an assertCurrent guard'), { code: 'NATIVE_A2A_ASSERT_CURRENT_REQUIRED' });
  }
  if (!scope || !scope.tenantId || !scope.workspaceId || !scope.userId || !scope.agentId) {
    throw Object.assign(new Error('native-dsh-a2a requires a bound scope'), { code: 'NATIVE_A2A_SCOPE_REQUIRED' });
  }
  if (!discovery || typeof discovery.list !== 'function') {
    throw Object.assign(new Error('native-dsh-a2a requires a discovery service'), { code: 'NATIVE_A2A_DISCOVERY_REQUIRED' });
  }
  if (!exposurePlan || typeof exposurePlan.assertGenericTargetAllowed !== 'function') {
    throw Object.assign(new Error('native-dsh-a2a requires an exposure plan'), { code: 'NATIVE_A2A_EXPOSURE_PLAN_REQUIRED' });
  }
  if (!bindingDescription || typeof bindingDescription !== 'object') {
    throw Object.assign(new Error('native-dsh-a2a requires a binding description'), { code: 'NATIVE_A2A_BINDING_DESCRIPTION_REQUIRED' });
  }
  return createNativeA2aToolPort({ scope, sessionId, spaceId, discovery, invocation, exposurePlan, authorize, assertCurrent, bindingDescription,
    receiptObservation: config.receiptObservation === true });
}

export { NATIVE_A2A_TOOLS_CONTRACT };
