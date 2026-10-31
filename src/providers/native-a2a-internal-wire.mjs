/** Permit/credential preparation for one original managed A2A wire operation.
 * The injected commit updates the ORIGINAL private call under its state lock.
 * Grants and credential values stay in memory; only intent/fact digests persist.
 * A prepared initial call already bound to a remote Task becomes a read. */
import { createHash, randomUUID } from 'node:crypto';
import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { a2aMessageDigest } from './native-a2a-message.mjs';
import { createA2AProjection } from './native-a2a-protocol.mjs';
export const A2A_INTERNAL_WIRE = 'agentkit.a2a-internal-wire/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const deniedHeaders = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'proxy-authorization', 'proxy-connection',
  'upgrade', 'trailer', 'te', 'content-type', 'accept', 'x-agentengine-a2a-permit']);
// Python SimpleCookie quotes spaces/separators and octal-escapes control and
// Latin-1 bytes. Keep those accepted credential values rather than silently
// narrowing the broker's cookie contract to unquoted cookie-octets.
function cookieValue(value) {
  if (/^[\w!#$%&'*+\-.^`|~:]*$/u.test(value)) return value;
  return '"' + [...value].map(char => {
    const code = char.codePointAt(0);
    return char === '"' || char === '\\' ? '\\' + char : code < 32 || code >= 127 && code <= 255 || char === ',' || char === ';'
      ? '\\' + code.toString(8).padStart(3, '0') : char;
  }).join('') + '"';
}
function credentials(route, injection) {
  const url = new URL(route.url), headers = {}, seen = new Set();
  for (const [key, value] of Object.entries(injection.headers)) {
    const lower = key.toLowerCase();
    invariant(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) && !/[\r\n]/u.test(value)
      && !deniedHeaders.has(lower) && !seen.has(lower), 'A2A_CREDENTIAL_INJECTION_CONFLICT');
    seen.add(lower); headers[key] = value;
  }
  for (const [key, value] of Object.entries(injection.query)) {
    invariant(!url.searchParams.has(key), 'A2A_CREDENTIAL_INJECTION_CONFLICT'); url.searchParams.append(key, value);
  }
  const cookies = Object.entries(injection.cookies);
  if (cookies.length) {
    invariant(!seen.has('cookie'), 'A2A_CREDENTIAL_INJECTION_CONFLICT');
    const reserved = new Set(['expires', 'path', 'comment', 'domain', 'max-age', 'secure', 'httponly', 'version', 'samesite', 'partitioned']);
    headers.Cookie = cookies.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => {
      invariant(/^[!#$%&'*+.^_`|~0-9A-Za-z:-]+$/u.test(key) && !reserved.has(key.toLowerCase()),
        'A2A_CREDENTIAL_INJECTION_CONFLICT'); return `${key}=${cookieValue(value)}`;
    }).join('; ');
  }
  return { url, headers };
}
export function createInternalA2AWire({ controlPlane, readRecord, commit, validateRoute, publicEgressEnabled = false, observe }) {
  return Object.freeze({
    async prepare(request, method, params, signal, assertCurrent, commandId) {
      invariant(assertCurrent() === true, 'A2A_CONTROL_PLANE_AUTHORITY_LOST'); signal.throwIfAborted();
      const sending = method === 'SendMessage' || method === 'SendStreamingMessage', cancel = method === 'CancelTask';
      const subscribing = method === 'SubscribeToTask';
      invariant(sending || cancel || subscribing || method === 'GetTask', 'A2A_INTERNAL_METHOD_UNSUPPORTED');
      const original = readRecord(request), initial = sending && !params.message.taskId;
      invariant(original?.phase !== 'prepared', 'A2A_INTERNAL_SEND_NOT_ADMITTED');
      invariant(!cancel || commandId, 'A2A_INTERNAL_COMMAND_REQUIRED');
      const message = sending ? a2aMessageDigest(params.message) : null;
      const observationContext = !initial && sending && commandId ? { continuationCommandId: commandId } : {};
      const operationId = initial ? `initial:${params.message.messageId}`
        : `${method}:${!sending && !cancel ? randomUUID() : commandId ?? randomUUID()}:${message?.sha256 ?? ''}`;
      const idempotencyToken = sending || cancel ? `idem-${hash({ identity: request.identity, operationId })}` : undefined;
      const fields = initial ? { spaceId: request.spec.space_id, agentId: request.spec.target_agent_id,
        versionId: request.spec.expected_version_id, messageId: message.message.messageId, messageSha256: message.sha256, idempotencyToken }
        : { taskId: original.managed?.taskId, operation: sending ? 'send_message' : cancel ? 'cancel_task' : subscribing ? 'subscribe_to_task' : 'get_task',
          ...(message ? { messageId: message.message.messageId, messageSha256: message.sha256 } : {}),
          ...(idempotencyToken ? { idempotencyToken } : {}) };
      invariant(initial || fields.taskId, 'A2A_INTERNAL_TASK_NOT_BOUND');
      // Prepare/credential requests can allocate grants. Their intent is
      // durable before HTTP, even though no remote message has begun yet.
      commit(request, state => {
        state.operations ??= {}; invariant(!Object.hasOwn(state.operations, operationId), 'A2A_INTERNAL_OPERATION_ALREADY_ENTERED');
        invariant(Object.keys(state.operations).length < 10000, 'A2A_INTERNAL_OPERATION_LIMIT');
        state.operations[operationId] = { phase: 'preparing', method, digest: hash(fields), createdAt: Date.now() };
      });
      const context = fields => ({ ...fields, signal, assertCurrent });
      const prepared = await (initial ? controlPlane.prepareCall(context(fields)) : controlPlane.prepareTaskOperation(context(fields)));
      assertCurrent();
      invariant(prepared.target.agentId === request.spec.target_agent_id && prepared.target.versionId === request.spec.expected_version_id
        && (!request.cardSha256 || prepared.target.cardSha256 === request.cardSha256), 'A2A_INTERNAL_TARGET_CONFLICT');
      invariant(initial || prepared.taskId === original.managed.taskId, 'A2A_INTERNAL_TASK_CONFLICT');
      if (!initial) invariant(prepared.remoteTask && (!original.projection.taskId || prepared.remoteTask.id === original.projection.taskId
        && prepared.remoteTask.contextId === original.projection.contextId), 'A2A_REMOTE_BINDING_CONFLICT');
      if (original.managed?.remote) invariant(prepared.remoteTask && prepared.remoteTask.id === original.managed.remote.id
        && prepared.remoteTask.contextId === original.managed.remote.contextId, 'A2A_REMOTE_BINDING_CONFLICT');
      invariant(Number.isFinite(Date.parse(prepared.expiresAt)) && Date.parse(prepared.expiresAt) > Date.now(), 'A2A_INTERNAL_PERMIT_EXPIRED');
      validateRoute(prepared.route.url);
      if (prepared.route.kind === 'external_public') invariant(publicEgressEnabled, 'A2A_PUBLIC_EGRESS_DISABLED');
      commit(request, state => {
        invariant(!state.taskId || state.taskId === prepared.taskId, 'A2A_INTERNAL_TASK_CONFLICT');
        state.taskId = prepared.taskId; state.target = copy(prepared.target);
        state.operations[operationId] = { ...state.operations[operationId], phase: 'prepared', permitDigest: hash(prepared.permit),
          routeDigest: hash(prepared.route), expiresAt: prepared.expiresAt };
        if (prepared.remoteTask) {
          invariant(!state.remote || state.remote.id === prepared.remoteTask.id && state.remote.contextId === prepared.remoteTask.contextId,
            'A2A_REMOTE_BINDING_CONFLICT'); state.remote = { ...copy(prepared.remoteTask), phase: 'bound' };
        }
      });
      let route = new URL(prepared.route.url), headers, credentialExpiresAt = null;
      if (prepared.route.kind === 'hosted_gateway') headers = { 'X-AgentEngine-A2A-Permit': prepared.permit,
        Authorization: `Bearer ${controlPlane.gatewayToken(context({}))}` };
      else {
        commit(request, state => { state.operations[operationId].credentialPhase = 'resolving'; });
        const injection = await controlPlane.resolveCredential(context({ taskId: prepared.taskId, credentialHandle: prepared.credentialHandle, permit: prepared.permit }));
        assertCurrent(); invariant(injection.expiresAt === null || Number.isFinite(Date.parse(injection.expiresAt))
          && Date.parse(injection.expiresAt) > Date.now(), 'A2A_INTERNAL_CREDENTIAL_EXPIRED');
        credentialExpiresAt = injection.expiresAt;
        ({ url: route, headers } = credentials(prepared.route, injection));
        commit(request, state => { state.operations[operationId].credentialPhase = 'resolved'; });
      }
      assertCurrent();
      // Existing idempotency resolution is an original-task read, never another
      // initial SendMessage. A streaming caller receives a one-event iterator.
      const observedExisting = initial && prepared.remoteTask;
      const actualMethod = observedExisting ? 'GetTask' : method;
      const actualParams = observedExisting || method === 'GetTask' ? { id: prepared.remoteTask.id }
        : message ? { ...params, message: message.message } : params;
      return {
        observationId: operationId,
        route: { ...prepared.route, url: route.href }, headers, method: actualMethod, params: actualParams,
        existingInitialTask: Boolean(observedExisting),
        admit() { assertCurrent(); invariant(Date.parse(prepared.expiresAt) > Date.now(), 'A2A_INTERNAL_PERMIT_EXPIRED');
          invariant(credentialExpiresAt === null || Date.parse(credentialExpiresAt) > Date.now(), 'A2A_INTERNAL_CREDENTIAL_EXPIRED');
          commit(request, state => { state.operations[operationId].phase = 'transport'; }); assertCurrent(); },
        async observe(payload, sourceEventId = '') {
          assertCurrent(); const current = readRecord(request), validation = createA2AProjection(request.scopeId, current.projection, { deferTerminal: true });
          if (actualMethod === 'GetTask' || actualMethod === 'CancelTask') validation.task(payload); else validation.apply(payload);
          const candidate = actualMethod === 'GetTask' || actualMethod === 'CancelTask' ? payload
            : payload.task ?? payload.statusUpdate ?? payload.artifactUpdate;
          if (!candidate) { observe?.(request, { payload, method: actualMethod, observationId: operationId, sourceEventId, ...observationContext }); return; }
          const remote = { id: candidate.id ?? candidate.taskId, contextId: candidate.contextId || null };
          invariant(typeof remote.id === 'string' && remote.id && remote.id.length <= 4096
            && (remote.contextId === null || typeof remote.contextId === 'string' && remote.contextId.length <= 4096), 'A2A_REMOTE_BINDING_CONFLICT');
          if (current.managed.remote) {
            invariant(current.managed.remote.id === remote.id && current.managed.remote.contextId === remote.contextId, 'A2A_REMOTE_BINDING_CONFLICT');
            invariant(current.managed.remote.phase === 'bound', 'A2A_INTERNAL_BIND_OUTCOME_UNKNOWN');
            observe?.(request, { payload, method: actualMethod, observationId: operationId, sourceEventId, ...observationContext }); return;
          }
          const observedAt = new Date().toISOString();
          commit(request, state => { invariant(!state.remote, 'A2A_REMOTE_BINDING_CONFLICT');
            state.remote = { ...remote, phase: 'binding', observedAt }; });
          await controlPlane.bindRemoteTask(context({ taskId: prepared.taskId, remoteTaskId: remote.id, remoteContextId: remote.contextId, observedAt }));
          assertCurrent(); commit(request, state => {
            invariant(state.remote?.id === remote.id && state.remote.contextId === remote.contextId, 'A2A_REMOTE_BINDING_CONFLICT'); state.remote.phase = 'bound';
          });
          observe?.(request, { payload, method: actualMethod, observationId: operationId, sourceEventId, ...observationContext });
        },
      };
    },
  });
}
