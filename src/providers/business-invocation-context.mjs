/** Business caller context for a managed RunAgent invocation.
 *
 * This is deliberately separate from the platform principal. The platform
 * principal authenticates the caller allowed to reach the deployed Agent;
 * `userId` and `sessionId` identify the caller's business subject/session and
 * are supplied by that caller in RunAgent. The context never enters DSH prompt
 * content or transcript. It exists only while the current Runtime request is
 * executing and is consumed at the MCP boundary.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const storage = new AsyncLocalStorage();
const SAFE_ID = /^[\x21-\x7e]{1,200}$/;

/** Business identifiers must be transport-safe because the same value is sent
 * in both JSON-RPC metadata and HTTP headers. This permits opaque printable
 * ASCII IDs (UUIDs, emails, tenant-prefixed IDs, etc.) without accepting
 * control characters or unbounded input. */
export function businessInvocationId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return SAFE_ID.test(text) ? text : '';
}

export function normalizeBusinessInvocation(input) {
  if (!input || typeof input !== 'object') return null;
  const requestId = businessInvocationId(input.requestId);
  // `SessionId` and `InvocationId` are platform correlation ids: every managed
  // RunAgent turn has them whether or not the caller names them. They are not
  // user identity, so they are always forwarded. Only `userId`/`sessionId` are
  // business attribution, and each is present only when the caller supplied it.
  if (!requestId) return null;
  const userId = businessInvocationId(input.userId);
  const sessionId = businessInvocationId(input.sessionId);
  const context = { contract: 'agentkit.business-invocation/v1', requestId,
    ...(userId ? { userId } : {}), ...(sessionId ? { sessionId } : {}),
    ...(userId || sessionId
      ? { businessDigest: createHash('sha256').update(JSON.stringify([userId, sessionId])).digest('hex') }
      : {}) };
  for (const field of ['agentId', 'nativeSessionId']) {
    const value = businessInvocationId(input[field]);
    if (value) context[field] = value;
  }
  return Object.freeze(context);
}

export function runWithBusinessInvocation(context, invoke) {
  return context ? storage.run(context, invoke) : invoke();
}

export function currentBusinessInvocation() {
  return storage.getStore() || null;
}
