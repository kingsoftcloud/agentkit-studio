/** Compose the MCP identity for one Native tool dispatch. */
import { currentBusinessInvocation } from './business-invocation-context.mjs';

export function nativeMcpInvocation({ scope, agent, agentId, runId, callId } = {}) {
  const business = currentBusinessInvocation();
  const nativeSessionId = String(agent?.session?.id || ''), nativeUserId = String(scope?.userId || '');
  if (!business) return { source: 'dsh-native', sessionId: nativeSessionId, userId: nativeUserId,
    tenantId: scope?.tenantId, workspaceId: scope?.workspaceId, agentId, runId, callId };
  // Correlation ids are unconditional; business attribution is not.
  return { source: 'run-agent', sessionId: nativeSessionId, userId: nativeUserId,
    ...(business.userId ? { businessUserId: business.userId } : {}),
    ...(business.sessionId ? { businessSessionId: business.sessionId } : {}),
    nativeSessionId: business.nativeSessionId || nativeSessionId, invocationId: business.requestId,
    businessInvocationId: business.requestId, tenantId: scope?.tenantId, workspaceId: scope?.workspaceId,
    agentId, runId, callId };
}
