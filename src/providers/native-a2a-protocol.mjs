/** A2A 1.0 wire projection. Wire source: the reference environment's installed
 * a2a-sdk transports/jsonrpc.py and rest.py (not pinned by the Git reference).
 * KsADK event behavior: ksadk/events/adapters/a2a.py at the recorded revision.
 * No transport, credentials, Host session, or effect admission lives here.
 */
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const NATIVE_A2A_PROTOCOL = 'agentkit.native-a2a-wire/v1';
export const a2aTerminal = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const states = new Set(['submitted', 'working', 'completed', 'failed', 'cancelled', 'input_required', 'rejected', 'auth_required']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
export function a2aState(value) {
  const state = String(value ?? '').replace(/^TASK_STATE_/u, '').toLowerCase().replace(/^canceled$/u, 'cancelled');
  invariant(states.has(state), 'A2A_INVALID_TASK_STATE');
  return state;
}
function textParts(parts) {
  invariant(Array.isArray(parts) && parts.length <= 4096, 'A2A_INVALID_PARTS');
  // Retain the wire order, including positions occupied by non-text parts.
  return parts.map(part => own(part, 'text') && typeof part.text === 'string' ? part.text : null);
}
export function createA2AProjection(scopeId, checkpoint = null) {
  const state = checkpoint ? copy(checkpoint) : { scopeId, taskId: null, contextId: null, state: 'submitted',
    output_refs: [], snapshots: {}, item_kinds: {}, artifacts: {}, seen: {}, directMessage: false };
  invariant(state.scopeId === scopeId, 'A2A_CHECKPOINT_SCOPE_CONFLICT');
  function bind(taskId, contextId) {
    invariant(typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 4096, 'A2A_REMOTE_TASK_REQUIRED');
    const context = contextId || null;
    invariant(context === null || typeof context === 'string' && context.length <= 4096, 'A2A_REMOTE_CONTEXT_INVALID');
    invariant(state.taskId === null || state.taskId === taskId && state.contextId === context, 'A2A_REMOTE_BINDING_CONFLICT');
    state.taskId = taskId; state.contextId = context;
  }
  function item(kind, id, parts, append = false, close = false) {
    invariant(typeof id === 'string' && id && id.length <= 4096, 'A2A_ITEM_ID_REQUIRED');
    const itemId = canonical([kind, id]), key = `${scopeId}:${itemId}`;
    const previous = state.artifacts[key];
    if (kind === 'artifact') {
      invariant(!append || previous, 'A2A_ARTIFACT_BASE_REQUIRED');
      invariant(!previous?.closed, 'A2A_ARTIFACT_ALREADY_CLOSED');
    }
    const converted = textParts(parts), offset = append ? previous.partCount : 0;
    const snapshot = append ? { ...state.snapshots[key] } : {};
    for (let i = 0; i < converted.length; i++) if (converted[i] !== null) snapshot[`p${offset + i}`] = converted[i];
    state.snapshots[key] = snapshot; state.item_kinds[key] = kind;
    if (!state.output_refs.some(ref => ref.item_id === itemId)) state.output_refs.push({ scope_id: scopeId, item_id: itemId, part_id: null });
    if (kind === 'artifact') state.artifacts[key] = { partCount: offset + converted.length, closed: close };
  }
  function message(value) {
    invariant(object(value), 'A2A_MESSAGE_INVALID');
    if (value.role !== undefined && value.role !== 'ROLE_AGENT') return;
    item('message', value.messageId, value.parts);
  }
  function status(value) {
    invariant(object(value), 'A2A_STATUS_REQUIRED');
    const next = a2aState(value.state);
    invariant(!a2aTerminal.has(state.state) || state.state === next, 'A2A_TERMINAL_STATE_CONFLICT');
    state.state = next;
    if (value.message) message(value.message);
  }
  function task(value) {
    bind(value.id, value.contextId);
    const present = new Set((value.artifacts ?? []).map(artifact => `${scopeId}:${canonical(['artifact', artifact.artifactId])}`));
    for (const key of Object.keys(state.artifacts)) if (!present.has(key)) {
      delete state.artifacts[key]; delete state.snapshots[key]; delete state.item_kinds[key];
      state.output_refs = state.output_refs.filter(ref => `${ref.scope_id}:${ref.item_id}` !== key);
    }
    // A GetTask snapshot authoritatively replaces every artifact's parts.
    for (const artifact of value.artifacts ?? []) {
      const key = `${scopeId}:${canonical(['artifact', artifact.artifactId])}`;
      delete state.artifacts[key];
      item('artifact', artifact.artifactId, artifact.parts);
    }
    for (const entry of value.history ?? []) message(entry);
    status(value.status);
  }
  function apply(payload, eventId = '') {
    invariant(object(payload), 'A2A_WIRE_PAYLOAD_INVALID');
    if (eventId) {
      invariant(eventId.length <= 1024, 'A2A_EVENT_ID_INVALID');
      const key = canonical(eventId), digest = canonical(payload);
      if (Object.hasOwn(state.seen, key)) { invariant(state.seen[key] === digest, 'A2A_EVENT_ID_CONFLICT'); return; }
      invariant(Object.keys(state.seen).length < 10000, 'A2A_EVENT_LIMIT');
      state.seen[key] = digest;
    }
    const fields = ['task', 'message', 'statusUpdate', 'artifactUpdate'].filter(key => own(payload, key));
    invariant(fields.length === 1, 'A2A_WIRE_PAYLOAD_AMBIGUOUS');
    if (fields[0] === 'task') task(payload.task);
    else if (fields[0] === 'message') {
      invariant(!a2aTerminal.has(state.state) || state.state === 'completed', 'A2A_TERMINAL_STATE_CONFLICT');
      message(payload.message); state.directMessage = true; state.state = 'completed';
    }
    else if (fields[0] === 'statusUpdate') { const update = payload.statusUpdate; bind(update.taskId, update.contextId); status(update.status); }
    else {
      const update = payload.artifactUpdate; bind(update.taskId, update.contextId);
      invariant(object(update.artifact), 'A2A_ARTIFACT_REQUIRED');
      item('artifact', update.artifact.artifactId, update.artifact.parts, update.append === true, update.lastChunk === true);
    }
    invariant(Buffer.byteLength(canonical(state)) <= 8 * 1024 * 1024, 'A2A_CHECKPOINT_LIMIT');
  }
  return { apply, task, snapshot: () => copy(state) };
}

/** Bounded SSE decoder, including CRLF, split UTF-8, multiline data and IDs.
 * No implicit retry or reconnect: a broken stream belongs to its original task.
 */
export async function* a2aSse(body, signal) {
  signal.throwIfAborted();
  invariant(body?.getReader, 'A2A_STREAM_REQUIRED');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data = [], id = '', bytes = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read(); signal.throwIfAborted();
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      if (!next.done) bytes += next.value.byteLength;
      invariant(bytes <= 16 * 1024 * 1024 && Buffer.byteLength(buffer) <= 1024 * 1024, 'A2A_STREAM_LIMIT');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, ''); buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) yield { payload: JSON.parse(data.join('\n')), id };
          data = []; id = '';
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
        else if (line.startsWith('id:')) id = line.slice(3).replace(/^ /u, '');
      }
      if (next.done) { invariant(!buffer.trim() && !data.length, 'A2A_STREAM_TRUNCATED'); break; }
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
