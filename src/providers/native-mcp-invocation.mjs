/** Compose the MCP identity for one tool dispatch.
 *
 * Native DSH and Codex share this single composition so the two runtimes cannot
 * drift apart: correlation ids are unconditional, business attribution is not.
 */
import { currentBusinessInvocation } from './business-invocation-context.mjs';

/** @param {object} input
 * @param {string} [input.source] runtime label used when no RunAgent bound a
 *   business identity (`dsh-native` for Native, `codex` for Codex).
 */
export function nativeMcpInvocation({ scope, agent, agentId, runId, callId, source = 'dsh-native' } = {}) {
  const business = currentBusinessInvocation();
  const nativeSessionId = String(agent?.session?.id || ''), nativeUserId = String(scope?.userId || '');
  if (!business) return { source, sessionId: nativeSessionId, userId: nativeUserId,
    tenantId: scope?.tenantId, workspaceId: scope?.workspaceId, agentId, runId, callId };
  return { source: 'run-agent', sessionId: nativeSessionId, userId: nativeUserId,
    ...(business.userId ? { businessUserId: business.userId } : {}),
    ...(business.sessionId ? { businessSessionId: business.sessionId } : {}),
    nativeSessionId: business.nativeSessionId || nativeSessionId, invocationId: business.requestId,
    businessInvocationId: business.requestId, tenantId: scope?.tenantId, workspaceId: scope?.workspaceId,
    agentId, runId, callId };
}
