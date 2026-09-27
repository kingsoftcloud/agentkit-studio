/**
 * Narrow identity-aware Session boundary between AgentEngine canonical events and
 * the official DSH Session wire. DSH owns the durable journal, node assembler,
 * Remote and renderer; this module only validates identity, projects the one
 * proven message shape, and preserves unsupported facts as ignorable events.
 */

const ENVELOPE_KEYS = new Set([
  'schema_version', 'event_id', 'seq', 'timestamp', 'run_id', 'run_seq',
  'scope_id', 'parent_scope_id', 'source', 'event_type',
]);

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`);
  return value;
}

function assertEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('runtime event must be an object');
  nonEmpty(event.event_id, 'event_id');
  nonEmpty(event.event_type, 'event_type');
  nonEmpty(event.run_id, 'run_id');
  nonEmpty(event.scope_id, 'scope_id');
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new TypeError('event seq must be a non-negative integer');
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || event.timestamp < 0) {
    throw new TypeError('event timestamp must be a non-negative number');
  }
  if (event.schema_version !== 2) throw new TypeError('unsupported canonical schema version');
}

function timeMs(timestamp) {
  const result = Math.round(timestamp * 1000);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError('event timestamp is outside DSH time range');
  return result;
}

function coordinate(event) {
  const metadata = event.source?.metadata;
  const turn = Number.isSafeInteger(metadata?.turn) && metadata.turn > 0 ? metadata.turn : 1;
  const step = Number.isSafeInteger(metadata?.step) && metadata.step > 0 ? metadata.step : 1;
  return { turn, step };
}

function contentParts(event) {
  const snapshot = event.snapshot ?? event.initial;
  return Array.isArray(snapshot?.parts) ? snapshot.parts : [];
}

function nativeDataEvent(event) {
  if (event.event_type !== 'item.completed' || event.item_kind !== 'data') return null;
  const part = contentParts(event).find(candidate => candidate?.content_type === 'data');
  const value = part?.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = value.type;
  const data = value.data;
  return typeof type === 'string' && data !== undefined ? { type, data } : null;
}

function presentedData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Number.isSafeInteger(value.turn) || value.turn < 1 || typeof value.callId !== 'string') return null;
  if (!Array.isArray(value.files) || value.files.length === 0) return null;
  if (!value.files.every(file => file && typeof file === 'object' && typeof file.path === 'string' && file.path.length > 0)) return null;
  return value;
}

function dshContent(part) {
  if (part.content_type === 'text') return { type: 'text', text: part.text ?? '' };
  if (part.content_type === 'json') return { type: 'text', text: JSON.stringify(part.value) };
  if (part.content_type === 'tool_call') {
    return {
      type: 'tool-call', id: part.call_id,
      name: part.name, arguments: JSON.stringify(part.arguments),
    };
  }
  if (part.content_type === 'data') return { type: 'text', text: JSON.stringify(part.data) };
  return { type: 'text', text: JSON.stringify(part) };
}

function dshType(event) {
  if (event.event_type === 'interaction.requested' && event.interaction_kind === 'approval') {
    return 'approval/asked';
  }
  if (event.event_type === 'interaction.resolved' && event.interaction_kind === 'approval') {
    return 'approval/decided';
  }
  const native = nativeDataEvent(event);
  if (native?.type === 'goal/change') return 'goal/change';
  if (native?.type === 'approval/asked') return 'approval/asked';
  if (native?.type === 'approval/decided') return 'approval/decided';
  if (native?.type === 'deliverables/presented' && presentedData(native.data) !== null) {
    return 'deliverables/presented';
  }
  if (event.event_type === 'item.completed' && event.item_kind === 'message' && event.source?.metadata?.role === 'user') {
    return 'user/message';
  }
  if (event.event_type === 'run.started') return 'turn/start';
  if (event.event_type === 'run.completed' || event.event_type === 'run.failed'
    || event.event_type === 'run.canceled' || event.event_type === 'run.interrupted') return 'turn/end';
  if (event.event_type === 'item.started'
    && (event.item_kind === 'message' || event.item_kind === 'reasoning' || event.item_kind === 'tool_call')) return 'step/start';
  if (event.event_type === 'item.completed' && (event.item_kind === 'message' || event.item_kind === 'reasoning')) {
    return 'assistant/message';
  }
  if (event.event_type === 'item.completed' && event.item_kind === 'tool_call') return 'tool/call';
  if (event.event_type === 'item.completed' && event.item_kind === 'tool_result') return 'tool/result';
  return `ksadk/${event.event_type}`;
}

const OFFICIAL_EVENT_TYPES = new Set([
  'user/message', 'turn/start', 'turn/end', 'step/start', 'assistant/message',
  'tool/call', 'tool/result', 'goal/change', 'approval/asked',
  'approval/decided', 'deliverables/presented',
]);

function payload(event, mappedType = dshType(event)) {
  if (mappedType === 'goal/change' || mappedType === 'deliverables/presented') {
    const native = nativeDataEvent(event);
    return native?.data;
  }
  if (mappedType === 'approval/asked') {
    if (event.event_type === 'interaction.requested') {
      const detail = event.request?.detail;
      const detailObject = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
      return {
        id: event.interaction_id,
        toolName: typeof detailObject.name === 'string' ? detailObject.name : event.request?.kind,
        ...(event.request?.call_id === undefined ? {} : { callId: event.request.call_id }),
        ...(typeof detailObject.reason === 'string' ? { reason: detailObject.reason } : {}),
      };
    }
    const native = nativeDataEvent(event);
    return native?.data;
  }
  if (mappedType === 'approval/decided') {
    if (event.event_type === 'interaction.resolved') {
      const outcome = event.response?.decision === 'approved'
        ? 'allowed-once'
        : event.response?.decision === 'rejected'
          ? 'rejected'
          : 'cancelled';
      return { id: event.interaction_id, outcome };
    }
    const native = nativeDataEvent(event);
    return native?.data;
  }
  const data = {};
  for (const [key, value] of Object.entries(event)) if (!ENVELOPE_KEYS.has(key)) data[key] = value;
  if (event.event_type === 'item.completed' && event.item_kind === 'message'
    && event.source?.metadata?.role === 'user') {
    const parts = event.snapshot?.parts;
    data.id = event.item_id;
    data.role = 'user';
    data.content = Array.isArray(parts) ? parts.map(part => {
      if (part.content_type === 'text') return { type: 'text', text: part.text ?? '' };
      if (part.content_type === 'image') return { type: 'image', mediaType: part.media_type, data: part.data };
      return { type: part.content_type, ...part };
    }) : [];
    data.source = { kind: 'user' };
    delete data.item_id;
    delete data.item_kind;
    delete data.snapshot;
  }
  const type = mappedType;
  const { turn, step } = coordinate(event);
  if (type === 'turn/start') data.turn = turn;
  if (type === 'turn/end') {
    data.turn = turn;
    data.reason = event.event_type === 'run.completed'
      ? { kind: 'completed' }
      : event.event_type === 'run.failed'
        ? { kind: 'error', error: { message: event.error?.message ?? 'run failed', code: event.error?.code ?? 'RUN_FAILED' } }
        : event.event_type === 'run.interrupted'
          ? { kind: 'interrupted' }
          : { kind: 'aborted', reason: { kind: 'user' } };
  }
  if (type === 'step/start') {
    data.turn = turn;
    data.step = step;
    delete data.item_id;
    delete data.item_kind;
    delete data.phase;
    delete data.initial;
  }
  if (type === 'assistant/message') {
    data.turn = turn;
    data.step = step;
    data.message = {
      id: event.item_id,
      role: 'assistant',
      content: contentParts(event).map(dshContent),
      source: { kind: 'model', provider: 'ksadk', model: 'agentkit-studio' },
    };
    delete data.item_id;
    delete data.item_kind;
    delete data.snapshot;
  }
  if (type === 'tool/call') {
    const part = contentParts(event).find(candidate => candidate.content_type === 'tool_call');
    if (part === undefined) return data;
    data.turn = turn;
    data.step = step;
    data.callId = part.call_id;
    data.name = part.name;
    data.arguments = JSON.stringify(part.arguments);
    delete data.item_id;
    delete data.item_kind;
    delete data.initial;
  }
  if (type === 'tool/result') {
    const part = contentParts(event).find(candidate => candidate.content_type === 'tool_result');
    if (part === undefined) return data;
    data.turn = turn;
    data.step = step;
    data.message = {
      id: event.item_id,
      role: 'tool',
      source: { kind: 'tool', callId: part.call_id },
      toolCallId: part.call_id,
      content: [{ type: 'text', text: JSON.stringify(part.result) }],
      isError: part.is_error === true,
    };
    delete data.item_id;
    delete data.item_kind;
    delete data.snapshot;
  }
  data._ksadk = {
    schema_version: event.schema_version,
    event_id: event.event_id,
    event_type: event.event_type,
    run_id: event.run_id,
    scope_id: event.scope_id,
    source: event.source,
  };
  return data;
}

export class CanonicalDshSessionAdapter {
  projectSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot must be an object');
    nonEmpty(snapshot.session_id, 'session_id');
    if (!Number.isSafeInteger(snapshot.watermark) || snapshot.watermark < 0) throw new TypeError('watermark must be non-negative');
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    for (const item of events) {
      const event = item?.event ?? item;
      if (event && Number.isSafeInteger(event.seq) && event.seq > snapshot.watermark) {
        throw new Error('snapshot watermark must cover every event sequence');
      }
    }
    return {
      session_id: snapshot.session_id,
      watermark: snapshot.watermark,
      events: this.projectEvents(snapshot.session_id, events),
    };
  }

  projectEvents(sessionId, events) {
    nonEmpty(sessionId, 'session_id');
    if (!Array.isArray(events)) throw new TypeError('events must be an array');
    const byId = new Map();
    const bySeq = new Map();
    for (const item of events) {
      const event = item?.event ?? item;
      const itemSessionId = item?.session_id;
      if (itemSessionId !== undefined && itemSessionId !== sessionId) throw new Error('event belongs to another session');
      assertEvent(event);
      const prior = byId.get(event.event_id);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(event)) throw new Error(`event ID ${event.event_id} changed during replay`);
        continue;
      }
      const sameSeq = bySeq.get(event.seq);
      if (sameSeq && sameSeq.event_id !== event.event_id) throw new Error('two event IDs share one session sequence');
      byId.set(event.event_id, event);
      bySeq.set(event.seq, event);
    }
    // History pages and a reconnect tail can arrive in a different order from
    // the durable session sequence. Terminal-run filtering must use that
    // sequence too, otherwise a late item supplied before its cancel event
    // would be projected into the official chat node store.
    const projected = [];
    const terminalRuns = new Set();
    for (const event of [...bySeq.values()].sort((left, right) => left.seq - right.seq)) {
      const lateAfterTerminal = terminalRuns.has(event.run_id)
        && !['run.completed', 'run.failed', 'run.canceled', 'run.interrupted'].includes(event.event_type);
      const type = lateAfterTerminal ? `ksadk/${event.event_type}` : dshType(event);
      projected.push({
        type,
        seq: event.seq,
        time: timeMs(event.timestamp),
        data: payload(event, type),
        source_event_id: event.event_id,
        source_run_id: event.run_id,
        source_scope_id: event.scope_id,
        source_item_id: typeof event.item_id === 'string' ? event.item_id : null,
        ignorable: !OFFICIAL_EVENT_TYPES.has(type),
      });
      if (['run.completed', 'run.failed', 'run.canceled', 'run.interrupted'].includes(event.event_type)) {
        terminalRuns.add(event.run_id);
      }
    }
    return projected;
  }

  wireEvent(event) {
    const wire = {
      type: event.type,
      seq: event.seq,
      time: event.time,
      data: event.data,
    };
    if (event.ignorable) wire.ignorable = true;
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      wire.surfaceOp = 'append';
    }
    return wire;
  }

  wireSnapshot(snapshot) {
    return this.projectSnapshot(snapshot).events.map(event => this.wireEvent(event));
  }
}

export function validateInteractionAnswer(answer) {
  nonEmpty(answer?.interaction_id, 'interaction_id');
  if (!Number.isSafeInteger(answer.expected_revision) || answer.expected_revision < 1) {
    throw new TypeError('expected_revision must be positive');
  }
  if (!['approve', 'reject', 'submit', 'cancel'].includes(answer.action)) throw new TypeError('unsupported interaction action');
  return answer;
}

export const STUDIO_SESSION_CONTRACT = 'p1-session-contract-v0.1';
export const DSH_VERSION = '0.1.7-rc.2';
export const DSH_COMMIT = '477b4f420553e8a52c2fbccc464d7561b239c443';
