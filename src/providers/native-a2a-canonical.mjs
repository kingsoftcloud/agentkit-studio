/** Stateful remote content projection. The caller commits this shadow, product
 * observation, canonical log and outbox in one original-call publication.
 * Only a real GetTask observation closes provisional artifacts. */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { a2aIdentity, a2aEventJournal, enqueueA2AEvents } from './native-a2a-events.mjs';
import { a2aState, a2aTerminal } from './native-a2a-protocol.mjs';
import { convertA2AContent, a2aMetadataString } from './native-a2a-content.mjs';
import { normalizeA2AObservation } from './native-a2a-wire-value.mjs';
import { parseA2AApproval } from './native-a2a-approval.mjs';
import { mapA2AToolActivity } from './native-a2a-tool-activity.mjs';

export const A2A_CANONICAL_ADAPTER = 'agentkit.a2a-canonical-adapter/v1';
const key = value => canonical(value);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = value => {
  invariant(typeof value === 'string' && value.length <= 4096, 'A2A_CANONICAL_ID_INVALID');
  const text = a2aMetadataString({ id: value }, 'id'); invariant(text, 'A2A_CANONICAL_ID_INVALID'); return text;
};
const optional = (metadata, ...names) => a2aMetadataString(metadata, ...names);
export function projectA2ACanonical(record, { payload, method, observationId, sourceEventId = '' }) {
  invariant(record.managed?.taskId && typeof observationId === 'string' && observationId, 'A2A_CANONICAL_OBSERVATION_INVALID');
  const journal = a2aEventJournal(record), state = copy(journal.adapter ?? { contract: A2A_CANONICAL_ADAPTER,
    artifacts: {}, messages: {}, occurrences: [], provisional: {}, observations: [], refs: [] });
  invariant(state.contract === A2A_CANONICAL_ADAPTER, 'A2A_CANONICAL_CHECKPOINT_INVALID');
  const wire = normalizeA2AObservation(payload, method), request = record.request, scope = request.scopeId;
  const original = request.native ?? request.dsh, parent = request.native ? original.runId : a2aIdentity('scope', 'dsh', original.agentId, original.sessionId);
  const remote = record.managed.remote, timestamp = Date.now() / 1000, events = [];
  const observed = `${observationId}:${sourceEventId}`, fingerprint = hash(wire);
  if (sourceEventId) {
    const previous = state.observations.find(([id]) => id === observed);
    if (previous) { invariant(previous[1] === fingerprint, 'A2A_CANONICAL_OBSERVATION_CONFLICT'); return false; }
    state.observations.push([observed, fingerprint]); if (state.observations.length > 1024) state.observations.shift();
  }
  function identity(taskId, contextId) {
    invariant(remote && taskId === remote.id && (contextId || null) === remote.contextId, 'A2A_REMOTE_BINDING_CONFLICT');
  }
  function occurrence(metadata, name, body) {
    metadata ??= {}; invariant(object(metadata), 'A2A_CANONICAL_METADATA_INVALID');
    const id = optional(metadata, 'event_id', 'ksadk_event_id'), cursor = optional(metadata, 'seq', 'ksadk_seq');
    if (id) {
      const digest = hash(body), index = state.occurrences.findIndex(([value]) => value === id);
      if (index >= 0) {
        invariant(state.occurrences[index][1] === digest, 'A2A_PRODUCER_EVENT_ID_CONFLICT');
        const entry = state.occurrences.splice(index, 1)[0]; state.occurrences.push(entry); return null;
      }
      state.occurrences.push([id, digest]); if (state.occurrences.length > 1024) state.occurrences.shift();
      return { id, cursor, identity: id, provisional: false };
    }
    const ordinal = state.provisional[key(name)] ?? 0; state.provisional[key(name)] = ordinal + 1;
    return { id: null, cursor, identity: `provisional:${name}:${ordinal}`, provisional: true };
  }
  function source(nativeItem, occ, metadata) {
    return { framework: 'a2a', protocol: null, native_event_id: occ?.id ?? null, native_cursor: occ?.cursor ?? null,
      native_run_id: remote?.id ?? state.directMessageId ?? null, native_item_id: nativeItem, metadata };
  }
  function emit(type, itemId, kind, fields, src, occurrenceId = observationId) {
    const seq = journal.nextSeq + events.length;
    events.push({ schema_version: 2, event_id: a2aIdentity('event', 'a2a', scope, itemId, type,
      fields.update?.part_id ?? 'snapshot', occurrenceId, seq), seq, timestamp, run_id: parent, run_seq: null,
      scope_id: scope, parent_scope_id: parent, source: src, event_type: type,
      ...(type.startsWith('item.') ? { item_id: itemId, item_kind: kind } : {}), ...fields });
  }
  function ref(itemId, parts) {
    for (const part of parts.filter(part => part.content_type === 'text')) {
      const value = { scope_id: scope, item_id: itemId, part_id: part.part_id };
      if (!state.refs.some(old => canonical(old) === canonical(value))) state.refs.push(value);
    }
  }
  function message(raw, consistent, direct = false) {
    invariant(object(raw) && Array.isArray(raw.parts ?? []), 'A2A_CANONICAL_MESSAGE_INVALID');
    const message = { ...raw, contextId: raw.contextId || remote?.contextId || scope };
    invariant(message.contextId === (remote?.contextId || scope) && (!message.taskId || message.taskId === remote?.id), 'A2A_REMOTE_BINDING_CONFLICT');
    if (!direct && message.role !== 'ROLE_AGENT') return;
    invariant(message.role === 'ROLE_AGENT', 'A2A_CANONICAL_MESSAGE_ROLE_INVALID');
    const id = string(message.messageId), digest = hash(message), previous = state.messages[key(id)];
    if (previous) { invariant(previous === digest, 'A2A_MESSAGE_IDENTITY_CONFLICT'); return; }
    const metadata = message.metadata ?? {}, producer = optional(metadata, 'event_id', 'ksadk_event_id');
    const occ = producer ? occurrence(metadata, `message:${id}`, message) : { id, cursor: optional(metadata, 'seq', 'ksadk_seq'), identity: id };
    if (!occ) return;
    if (direct) { invariant(!state.directMessageId || state.directMessageId === id, 'A2A_DIRECT_MESSAGE_CONFLICT'); state.directMessageId = id; }
    const itemId = a2aIdentity('item', 'a2a', scope, 'message', id), parts = convertA2AContent({ ...message, parts: message.parts ?? [] }, itemId);
    invariant(parts.length > 0, 'A2A_CANONICAL_MESSAGE_EMPTY');
    const src = source(id, occ, { provisional: false, consistent, role: message.role });
    emit('item.started', itemId, 'message', { phase: 'final_answer', initial: null }, src, occ.identity);
    for (const part of parts) emit('item.updated', itemId, 'message', { op: 'replace', update: part }, src, occ.identity);
    emit('item.completed', itemId, 'message', { snapshot: { parts } }, src, occ.identity);
    state.messages[key(id)] = digest; ref(itemId, parts);
  }
  function artifact(raw, { append = false, closed = false, snapshot = false, terminal = false, occ, src }) {
    invariant(object(raw), 'A2A_CANONICAL_ARTIFACT_INVALID'); const id = string(raw.artifactId);
    const itemId = a2aIdentity('item', 'a2a', scope, 'artifact', id), previous = state.artifacts[key(id)];
    invariant(snapshot || !append || previous?.present, 'A2A_ARTIFACT_BASE_REQUIRED');
    invariant(snapshot || !previous?.closed, 'A2A_ARTIFACT_ALREADY_CLOSED');
    const parts = convertA2AContent({ ...raw, parts: raw.parts ?? [] }, itemId, { startIndex: append ? previous.parts.length : 0 });
    invariant(parts.length > 0, 'A2A_CANONICAL_ARTIFACT_EMPTY');
    if (previous?.closed) {
      invariant(canonical(previous.parts) === canonical(parts), 'A2A_TRUSTED_SNAPSHOT_CONFLICT');
      if (terminal) ref(itemId, parts); return;
    }
    const seen = new Map((previous?.parts ?? []).map(part => [part.part_id, part.content_type]));
    for (const part of parts) invariant(!seen.has(part.part_id) || !append && seen.get(part.part_id) === part.content_type, 'A2A_PART_IDENTITY_CONFLICT');
    const current = { parts: append ? [...previous.parts, ...parts] : parts, present: true, closed: snapshot && terminal };
    if (!previous) emit('item.started', itemId, 'artifact', { phase: 'final_answer', initial: null }, src, occ.identity);
    if (snapshot && terminal) { emit('item.completed', itemId, 'artifact', { snapshot: { parts: current.parts } }, src, occ.identity); ref(itemId, current.parts); }
    else if (append) for (const part of parts) emit('item.updated', itemId, 'artifact', { op: 'append', update: part }, src, occ.identity);
    else emit('item.snapshot_replaced', itemId, 'artifact', { snapshot: { parts: current.parts } }, src, occ.identity);
    // lastChunk is an observation hint, not canonical completion authority.
    current.sourceClosed = closed; state.artifacts[key(id)] = current;
  }
  function resolveInteraction(taskState, src, occ, resume = false) {
    const active = state.activeInteraction;
    if (!active) return;
    if (active.kind === 'structured_input') emit('interaction.resolved', active.id, null,
      { interaction_id: active.id, interaction_kind: active.kind, response: { response_type: active.kind, data: { state: taskState } } }, src, occ.identity);
    // Remote progress never supplies an approval decision. The Host's durable
    // decision ledger is the sole authority for approval resolution.
    if (resume) emit('continuation.resumed', active.continuation, null,
      { continuation_id: active.continuation, continuation_kind: 'task_resume',
        resume_attempt_id: a2aIdentity('item', 'a2a', scope, active.continuation, occ.identity) }, src, occ.identity);
    delete state.activeInteraction;
  }
  function status(raw, occ, src) {
    const current = a2aState(raw.state);
    if (['working', 'submitted'].includes(current)) { resolveInteraction(raw.state, src, occ, true); return; }
    if (!['input_required', 'auth_required'].includes(current)) return;
    invariant(object(raw.message), 'A2A_INTERACTION_MESSAGE_REQUIRED');
    const message = { ...raw.message, contextId: raw.message.contextId || remote?.contextId || scope };
    invariant(message.contextId === (remote?.contextId || scope) && (!message.taskId || message.taskId === remote?.id), 'A2A_REMOTE_BINDING_CONFLICT');
    const id = string(message.messageId), lifecycle = key([raw.state, id]), digest = hash(message);
    state.interactions ??= {};
    if (state.interactions[lifecycle]) { invariant(state.interactions[lifecycle] === digest, 'A2A_INTERACTION_PAYLOAD_CONFLICT'); return; }
    const interaction = a2aIdentity('item', 'a2a', scope, 'interaction', raw.state, id);
    const continuation = a2aIdentity('item', 'a2a', scope, 'continuation', remote.id, id);
    const metadata = message.metadata ?? {}, approval = parseA2AApproval(metadata, interaction);
    invariant(!approval || current === 'input_required', 'A2A_INTERACTION_DECLARATION_INVALID');
    resolveInteraction('SUPERSEDED_BY_NEW_A2A_INTERACTION', src, occ);
    const kind = approval ? 'approval' : 'structured_input';
    const prompt = (message.parts ?? []).map(part => part.text ?? '').join('') || null;
    const schema = object(metadata.input_schema) ? metadata.input_schema : { type: current === 'auth_required' ? 'object' : 'string' };
    emit('interaction.requested', interaction, null, { interaction_id: interaction, interaction_kind: kind,
      request: approval ?? { request_type: kind, prompt, schema } }, src, occ.identity);
    emit('continuation.created', continuation, null, { continuation_id: continuation, continuation_kind: 'task_resume',
      resumable: true, ref: { context_id: remote.contextId || scope, task_id: remote.id } }, src, occ.identity);
    state.interactions[lifecycle] = digest; state.activeInteraction = { id: interaction, kind, continuation };
  }
  function snapshot(task) {
    identity(task.id, task.contextId); invariant(object(task.status), 'A2A_STATUS_REQUIRED');
    const terminal = a2aTerminal.has(a2aState(task.status.state)), digest = hash(task);
    if (state.terminalFingerprint) { invariant(state.terminalFingerprint === digest, 'A2A_TERMINAL_SNAPSHOT_CONFLICT'); return; }
    const occ = { identity: `get-task:${observationId}:${digest}` }, present = new Set();
    for (const raw of task.artifacts ?? []) {
      if (mapA2AToolActivity({artifact:raw,state,scope,remoteId:remote.id,emit})) continue;
      present.add(key(raw.artifactId));
      artifact(raw, { snapshot: true, terminal, occ, src: source(raw.artifactId, occ,
        { provisional: false, consistent: true, reconciliation_reason: 'terminal', reconciliation_attempt_id: observationId, terminal }) });
    }
    for (const [id, current] of Object.entries(state.artifacts)) if (!present.has(id) && !current.closed) {
      const nativeId = JSON.parse(id), itemId = a2aIdentity('item', 'a2a', scope, 'artifact', nativeId);
      const src = source(nativeId, occ, { provisional: false, consistent: true, reconciliation_reason: 'terminal', terminal });
      if (terminal) emit('item.failed', itemId, 'artifact', { error: { code: 'a2a_artifact_removed_by_snapshot',
        message: 'provisional artifact absent from authoritative GetTask snapshot', source: 'a2a', scope_id: scope, item_id: itemId, source_ref: src } }, src, occ.identity);
      else emit('item.snapshot_replaced', itemId, 'artifact', { snapshot: { parts: [] } }, src, occ.identity);
      current.parts = []; current.present = false; current.closed = terminal;
    }
    const paused = ['input_required', 'auth_required'].includes(a2aState(task.status.state)), statusMessage = task.status.message;
    const messages = [...(task.history ?? [])];
    if (!paused && statusMessage && !messages.some(value => value.messageId === statusMessage.messageId)) messages.push(statusMessage);
    for (const raw of messages) if (!paused || raw.messageId !== statusMessage?.messageId) message(raw, true);
    const src = source(task.id, occ, { provisional: false, consistent: true, reconciliation_reason: 'terminal', terminal });
    if (paused) status(task.status, occ, src);
    if (terminal) resolveInteraction(task.status.state, src, occ);
    if (terminal) state.terminalFingerprint = digest;
  }
  if (method === 'GetTask') snapshot(wire);
  else {
    const fields = ['task', 'message', 'artifactUpdate', 'statusUpdate'].filter(name => Object.hasOwn(wire, name));
    const wrapped = method === 'CancelTask' ? { task: wire } : wire;
    invariant(method === 'CancelTask' || fields.length === 1, 'A2A_WIRE_PAYLOAD_AMBIGUOUS');
    if (wrapped.message) message(wrapped.message, true, true);
    else if (wrapped.artifactUpdate) {
      const update = wrapped.artifactUpdate; identity(update.taskId, update.contextId);
      const publicActivity=mapA2AToolActivity({artifact:update.artifact,state,scope,remoteId:remote.id,emit});
      const occ = publicActivity ? null : occurrence(update.metadata, `artifact:${string(update.artifact?.artifactId)}`, update);
      if (occ) artifact(update.artifact, { append: update.append === true, closed: update.lastChunk === true, occ,
        src: source(update.artifact.artifactId, occ, { provisional: occ.provisional, consistent: false,
          artifact_closed: update.lastChunk === true, artifact_name: update.artifact.name ?? '',
          artifact_description: update.artifact.description ?? '', artifact_extensions: update.artifact.extensions ?? [] }) });
    } else {
      const raw = wrapped.task ?? wrapped.statusUpdate; identity(raw.id ?? raw.taskId, raw.contextId);
      const occ = occurrence(raw.metadata, 'status', raw);
      if (occ) status(raw.status, occ, source(raw.id ?? raw.taskId, occ, { provisional: occ.provisional, consistent: false }));
    }
  }
  for (let offset = 0; offset < events.length; offset += 100) enqueueA2AEvents(record, events.slice(offset, offset + 100));
  journal.adapter = state; return events.length > 0;
}
