/** Durable HTTP presentation, owned by the original public DSH Session log.
 * This derivative record cannot admit, resume, or execute a Native turn. */
import { createHash } from 'node:crypto';

export const FROZEN_RESPONSE_PROJECTION = 'agentkit.runtime-response-projection/v1';
export const FROZEN_RESPONSE_PROJECTION_EVENT = 'studio/runtime-response-projection';
const fail = code => Object.assign(new Error(code), { code, status: 409 });
const fingerprint = request => createHash('sha256').update(JSON.stringify({ version: 1,
  input: request.input, model: request.model ?? null })).digest('hex');
const presentationTypes = new Set(['response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done', 'response.output_text.delta', 'response.output_text.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
  'response.function_call_arguments.done', 'response.resource_check', 'response.tool_result']);

async function live(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const canceled = new Promise((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), canceled]);
    signal.throwIfAborted(); return value;
  } finally { signal.removeEventListener('abort', abort); }
}

export function createFrozenResponseProjection({ getService }) {
  async function sessionFor(request, signal, required) {
    const controller = getService('sessionController');
    if (!await live(() => controller.projections({ sessionId: request.sessionId }, signal), signal)) {
      if (required) throw fail('RESPONSES_PROJECTION_SESSION_UNAVAILABLE');
      return null;
    }
    const resolved = await live(() => controller.resolveAgent(request.sessionId), signal);
    if (resolved.error) throw resolved.error;
    const session = resolved.agent?.session;
    if (session?.id !== request.sessionId || typeof session.snapshotEvents !== 'function'
      || typeof session.append !== 'function') throw fail('RESPONSES_PROJECTION_HOST_UNAVAILABLE');
    return session;
  }
  function validate(data, request) {
    const response = data.response;
    if (data.format !== FROZEN_RESPONSE_PROJECTION || data.agentId !== request.agentId
      || data.buildId !== request.buildId || data.responseId !== request.responseId
      || !response || response.object !== 'response' || response.status !== 'completed'
      || response.id !== request.responseId || response.model !== request.model
      || response.session_id !== (request.publicSessionId || request.conversationId)
      || response.conversation?.id !== request.conversationId
      || response.metadata?.agentkit?.agentId !== request.agentId
      || response.metadata?.agentkit?.buildId !== request.buildId
      || !Number.isSafeInteger(response.created_at) || !Array.isArray(response.output)
      || !Array.isArray(data.events) || data.events.some(event => !event || !presentationTypes.has(event.type)
        || !event.data || typeof event.data !== 'object' || Array.isArray(event.data))) throw fail('RESPONSES_PROJECTION_INVALID');
    if (data.requestFingerprint !== fingerprint(request)) throw fail('RUNTIME_REQUEST_CONFLICT');
    return structuredClone({ response, events: data.events });
  }
  function read(session, request) {
    const rows = session.snapshotEvents().filter(event => event.type === FROZEN_RESPONSE_PROJECTION_EVENT
      && event.data?.requestId === request.runId);
    if (!rows.length) return null;
    if (rows.length !== 1) throw fail('RESPONSES_PROJECTION_INVALID');
    return validate(rows[0].data, request);
  }
  return {
    contract: FROZEN_RESPONSE_PROJECTION,
    async load(request, signal) {
      request = structuredClone(request);
      const session = await sessionFor(request, signal, false);
      return session ? read(session, request) : null;
    },
    async save(request, response, events, signal) {
      request = structuredClone(request); response = structuredClone(response); events = structuredClone(events);
      const session = await sessionFor(request, signal, true);
      const persistence = getService('sessions');
      if (typeof persistence?.flush !== 'function') throw fail('RESPONSES_PROJECTION_PERSISTENCE_UNAVAILABLE');
      const previous = read(session, request);
      const data = { format: FROZEN_RESPONSE_PROJECTION, agentId: request.agentId, buildId: request.buildId,
        requestId: request.runId, responseId: request.responseId, requestFingerprint: fingerprint(request), response, events };
      const value = previous ?? validate(data, request);
      signal.throwIfAborted();
      if (!previous) session.append(FROZEN_RESPONSE_PROJECTION_EVENT, { ...data, ...value }, { ignorable: true });
      const flushed = await live(() => persistence.flush(session), signal);
      if (flushed !== true) throw fail('RESPONSES_PROJECTION_NOT_DURABLE');
      return structuredClone(value);
    },
  };
}
