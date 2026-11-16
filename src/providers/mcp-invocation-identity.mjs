/** Trusted MCP invocation identity.
 *
 * MCP itself has no "current user" field on `tools/call`: the JSON-RPC request
 * is the model's tool call and nothing else. The Host therefore resolves the
 * caller once per turn (live DSH Session + trusted principal) and forwards it
 * on every MCP request through two channels:
 *
 * - `_meta['io.agentkit.studio/invocation']` on the JSON-RPC message, which
 *   works for every transport, including stdio;
 * - `x-agentkit-*` HTTP headers, for gateways that authorize or audit before
 *   the MCP application layer runs.
 *
 * The model controls `arguments`; it never controls this identity. The Host
 * binds `sessionId`/`userId` from the live Session and trusted principal, and
 * adds `businessUserId`/`businessSessionId` only for a validated RunAgent
 * caller. A tool argument named `userId` or `_meta` cannot select another
 * user. Absent trusted identity degrades to "no identity" instead of failing
 * the turn, because existing MCP servers must keep working when the Host has
 * no principal to forward.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Reverse-DNS key for MCP `_meta`; unknown keys are legal per the MCP spec. */
export const MCP_INVOCATION_META_KEY = 'io.agentkit.studio/invocation';
export const MCP_INVOCATION_CONTRACT = 'agentkit.studio-mcp-invocation/v1';

const SOURCES = new Set(['dsh-native', 'codex', 'harness', 'run-agent']);
// Header values are restricted to printable ASCII: a principal that is not
// transport-safe must not reach the wire through an unvalidated channel.
const WIRE_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/;
const FIELD_HEADERS = Object.freeze({
  source: 'x-agentkit-invocation-source',
  sessionId: 'x-agentkit-session-id',
  userId: 'x-agentkit-user-id',
  tenantId: 'x-agentkit-tenant-id',
  workspaceId: 'x-agentkit-workspace-id',
  agentId: 'x-agentkit-agent-id',
  runId: 'x-agentkit-run-id',
  callId: 'x-agentkit-call-id',
  nativeSessionId: 'x-agentkit-native-session-id',
  invocationId: 'x-agentkit-invocation-id',
  businessUserId: 'x-agentkit-business-user-id',
  businessSessionId: 'x-agentkit-business-session-id',
  businessInvocationId: 'x-agentkit-business-invocation-id',
});

const wire = value => typeof value === 'string' && WIRE_VALUE.test(value) ? value : '';

/** Build the forwarded identity from Host-owned turn state.
 *
 * `sessionId` and `userId` are the minimum: a server cannot attribute a call
 * without both. Any other field is optional and dropped when it is not a
 * transport-safe string. The returned object is frozen so a caller cannot widen
 * the identity after the Host admitted the turn.
 */
export function normalizeMcpInvocationIdentity(input) {
  if (!input || typeof input !== 'object') return null;
  const source = wire(input.source);
  const sessionId = wire(input.sessionId);
  const userId = wire(input.userId);
  if (!SOURCES.has(source) || !sessionId || !userId) return null;
  const identity = { v: 1, source, sessionId, userId };
  for (const field of ['tenantId', 'workspaceId', 'agentId', 'runId', 'callId', 'nativeSessionId', 'invocationId',
    'businessUserId', 'businessSessionId', 'businessInvocationId']) {
    const value = wire(input[field]);
    if (value) identity[field] = value;
  }
  return Object.freeze(identity);
}

/** JSON-RPC `_meta` bag for one request. */
export function mcpInvocationMeta(identity) {
  return { [MCP_INVOCATION_META_KEY]: identity };
}

/** Per-request HTTP headers; an existing caller header with the same name is
 * replaced, because identity headers are Host authority, not resource config. */
export function applyMcpInvocationHeaders(headers, identity) {
  const next = new Headers(headers instanceof Headers ? headers : headers || undefined);
  for (const [field, header] of Object.entries(FIELD_HEADERS)) {
    if (identity[field]) next.set(header, identity[field]);
  }
  return next;
}

/** The MCP connection is shared per resource, the caller is per turn. Keep the
 * identity in async context so concurrent Sessions never observe each other. */
export function createMcpInvocationScope() {
  const storage = new AsyncLocalStorage();
  return Object.freeze({
    run(identity, invoke) { return identity ? storage.run(identity, invoke) : invoke(); },
    current() { return storage.getStore() || null; },
  });
}
