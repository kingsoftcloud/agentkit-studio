/** Bounded public history projection over native persistence slices.
 * Public seq = native seq + 1: 0 remains an empty history watermark.
 */
import { runtimeError } from './runtime-responses-contract.mjs';
import { CODEX_TOOL_EVENT } from './providers/codex-tool-events.mjs';

const text = parts => (parts || []).filter(part => part.type === 'text').map(part => part.text || '').join('');
const content = value => Array.isArray(value) ? value : [];
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const publicEventTypes = new Set(['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result', CODEX_TOOL_EVENT]);

function groupEvents(events, kind, after = -1) {
  const groups = []; let group;
  for (const event of events) {
    if (event.type === 'turn/start') { group = { start: event.seq + 1, events: [], messages: 0, closed: false }; groups.push(group); }
    if (!group) continue;
    group.events.push(event);
    if (event.type === 'turn/end') group.closed = true;
    if (kind === 'events' ? publicEventTypes.has(event.type) && event.seq + 1 > after : event.type === 'assistant/message' || (event.type === 'user/message' && event.data?.source?.rpcId)) group.messages++;
  }
  return groups;
}

function selectGroups(groups, limit, forward) {
  const chosen = []; let count = 0;
  for (const group of forward ? groups : groups.toReversed()) {
    if (!group.messages) continue;
    if (chosen.length && count + group.messages > limit) break;
    chosen.push(group); count += group.messages;
    if (count >= limit) break;
  }
  return forward ? chosen : chosen.toReversed();
}

async function projectGroup(group, session, invocationId, options) {
  const request = group.events.find(event => event.type === 'user/message' && event.data?.source?.rpcId)?.data.source.rpcId;
  // An event page may cut immediately after turn/start. Resolve its identity
  // from the caller's same native observation, without emitting later events.
  const invocation = await invocationId(session.nativeSessionId, request, group.start);
  if (!invocation) return [];
  if (options.kind === 'events') return group.events.filter(event => publicEventTypes.has(event.type)).map(event => {
    const data = event.data || {}, message = event.type === 'user/message' ? data : data.message;
    const value = text(content(message?.content));
    const base = { EventId: `${session.sessionId}:${event.seq + 1}`, SessionId: session.sessionId, SeqId: event.seq + 1,
      InvocationId: invocation, Timestamp: new Date(event.time).toISOString(), Author: event.type === 'user/message' ? 'user' : 'assistant',
      Content: { text: value, parts: value ? [{ text: value }] : [] }, Metadata: {} };
    if (event.type === 'user/message' || event.type === 'assistant/message') return { ...base, EventType: event.type.replace('/', '_') };
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      const reason = data.reason?.kind;
      return { ...base, EventType: 'run_status', Metadata: { run_id: invocation, status: event.type === 'turn/start' ? 'in_progress'
        : reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled' : 'failed', ...(data.reason?.error?.code ? { error_code: data.reason.error.code } : {}) } };
    }
    const codex = event.type === CODEX_TOOL_EVENT;
    const result = event.type === 'tool/result' || (codex && data.phase !== 'started');
    return { ...base, EventType: result ? 'tool_result' : 'tool_call', Metadata: { call_id: codex || !result ? data.callId : data.message?.source?.callId,
      tool_name: data.name || 'tool', ...(result ? { tool_output: codex ? text(content(data.content)) : value, is_error: codex ? data.phase === 'failed' : data.message?.isError === true }
        : { tool_args: data.arguments }) } };
  }).filter(event => !options.EventTypes?.length || options.EventTypes.includes(event.EventType));
  const tools = new Map();
  const lastAssistant = group.events.findLast(event => event.type === 'assistant/message');
  const call = (event, data, callId) => {
    if (!tools.has(callId)) tools.set(callId, { Type: 'tool_call', SeqId: event.seq + 1, ToolCallId: callId,
      Name: data.name || 'tool', Args: data.arguments, Status: 'running' });
    return tools.get(callId);
  };
  for (const event of group.events) {
    const data = event.data || {};
    if (event.type === 'tool/call') call(event, data, data.callId);
    if (event.type === 'tool/result') Object.assign(call(event, data, data.message?.source?.callId), {
      Result: text(content(data.message?.content)), Status: data.message?.isError ? 'failed' : 'completed', ResultSeqId: event.seq + 1 });
    if (event.type === CODEX_TOOL_EVENT) {
      const tool = call(event, data, data.callId);
      if (data.phase !== 'started') Object.assign(tool, { Result: text(content(data.content)), Status: data.phase === 'failed' ? 'failed' : 'completed', ResultSeqId: event.seq + 1 });
    }
  }
  return group.events.flatMap(event => {
    const role = event.type === 'user/message' && event.data?.source?.rpcId ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
    if (!role) return [];
    const message = role === 'user' ? event.data : event.data?.message;
    const parts = content(message?.content);
    const result = { MessageId: `${session.sessionId}:${event.seq + 1}`, SessionId: session.sessionId, Role: role,
      Content: { text: text(parts) }, SeqId: event.seq + 1, StartSeqId: group.start, InvocationId: invocation,
      Timestamp: new Date(event.time).toISOString() };
    if (role === 'assistant') {
      if (options.IncludeReasoning) result.Reasoning = parts.filter(part => part.type === 'reasoning').map(part => ({ text: part.text || '', SeqId: event.seq + 1 }));
      if (options.IncludeToolEvents && event === lastAssistant) result.ToolEvents = [...tools.values()];
    }
    return [result];
  });
}

async function readFrozenHistoryPage({ handle, session, latestSeq, request, invocationId, signal, kind = 'messages' }) {
  const limit = request.Limit ?? 50, before = request.BeforeSeqId;
  const ordered = kind === 'events' && request.EventOrder === 'session_seq';
  const after = request.AfterSeqId ?? (ordered ? 0 : undefined);
  if (!integer(limit, 1) || limit > (kind === 'events' ? 1000 : 200) || (before !== undefined && !integer(before, 1))
    || (after !== undefined && !integer(after)) || (before !== undefined && after !== undefined && !ordered)
    || (request.Offset !== undefined && !integer(request.Offset))
    || ((request.Offset ?? 0) > 0 && (before !== undefined || after !== undefined))) throw runtimeError('RUNTIME_HISTORY_CURSOR_INVALID');
  for (const key of ['IncludeReasoning', 'IncludeToolEvents', 'IncludeAttachments']) {
    if (request[key] !== undefined && typeof request[key] !== 'boolean') throw runtimeError('RUNTIME_HISTORY_INPUT_INVALID');
  }
  if ((request.HistoryEpoch !== undefined && request.HistoryEpoch !== session.epoch) || (request.CursorSource && request.CursorSource !== 'runtime')) throw runtimeError('HISTORY_RELOAD_REQUIRED', 409);
  const snapshot = request.SnapshotSeqId ?? latestSeq;
  if (!integer(snapshot) || snapshot > latestSeq) throw runtimeError('HISTORY_RELOAD_REQUIRED', 409);
  // Stable cursors from this producer are invocation boundaries. Do not mix
  // another snapshot or source with a continuation page.
  if ((before !== undefined || (after ?? 0) > 0 || (request.Offset ?? 0) > 0) && (!request.HistoryEpoch || request.SnapshotSeqId === undefined)) throw runtimeError('HISTORY_RELOAD_REQUIRED', 409);
  const metadata = { DataSource: 'runtime', CursorSource: 'runtime', HistoryEpoch: session.epoch, SnapshotSeqId: snapshot,
    PersistenceDegraded: false, Degraded: false, CursorCompatibleWithRuntime: true, SessionContractVersion: 2 };
  if (kind === 'events' && request.Offset !== undefined && before === undefined && after === undefined) {
    // Hosted UI's legacy contract pages backwards by a public-event offset.
    // Count and page the same fixed native observation, never a second store.
    const native = []; let bytes = 0;
    for (let offset = 0; offset < snapshot; offset += 256) {
      signal.throwIfAborted();
      const length = Math.min(256, snapshot - offset);
      const batch = (await handle.read(offset, length, { signal })).events;
      if (batch.length !== length || batch.some((event, index) => event.seq !== offset + index)) throw runtimeError('RUNTIME_HISTORY_PREFIX_UNAVAILABLE', 503);
      bytes += Buffer.byteLength(JSON.stringify(batch));
      if (offset + length > 8192 || bytes > 16 * 1024 * 1024) throw runtimeError('HISTORY_PROJECTION_BUDGET_EXCEEDED', 429);
      native.push(...batch);
    }
    const projected = (await Promise.all(groupEvents(native, kind).map(group => projectGroup(group, session, invocationId, { ...request, kind })))).flat();
    const end = Math.max(0, projected.length - request.Offset);
    const start = Math.max(0, end - limit);
    const page = projected.slice(start, end);
    return { SessionId: session.sessionId, Events: page, Total: projected.length, Offset: request.Offset, Limit: limit,
      LatestSeqId: page.at(-1)?.SeqId ?? 0, HasMore: start > 0, NextCursor: start > 0 ? page[0].SeqId : null, ...metadata };
  }
  const forward = after !== undefined;
  const upper = forward && before !== undefined ? Math.min(snapshot, before - 1) : snapshot;
  let position = forward ? Math.min(after, upper) : Math.min(snapshot, before === undefined ? snapshot : before - 1);
  let events = [], bytes = 0, count = 0, groups = [], selected = [];
  if (kind === 'events' && forward && position > 0) {
    // Event pages can end inside a turn. Reconstruct only that turn's prefix
    // to recover its public invocation identity, without exposing it twice.
    let cut = position;
    while (cut > 0) {
      const offset = Math.max(0, cut - 256);
      const batch = (await handle.read(offset, cut - offset, { signal })).events;
      count += batch.length; bytes += Buffer.byteLength(JSON.stringify(batch));
      if (count > 8192 || bytes > 16 * 1024 * 1024) throw runtimeError('HISTORY_PROJECTION_BUDGET_EXCEEDED', 429);
      const start = batch.findLast(event => event.type === 'turn/start');
      if (start) { position = start.seq; break; }
      cut = offset; position = cut;
    }
  }
  while (forward ? position < upper : position > 0) {
    signal.throwIfAborted();
    const offset = forward ? position : Math.max(0, position - 256);
    const length = forward ? Math.min(256, upper - position) : position - offset;
    const batch = (await handle.read(offset, length, { signal })).events;
    if (batch.length !== length || batch.some((event, index) => event.seq !== offset + index)) throw runtimeError('RUNTIME_HISTORY_PREFIX_UNAVAILABLE', 503);
    count += batch.length; bytes += Buffer.byteLength(JSON.stringify(batch));
    if (count > 8192 || bytes > 16 * 1024 * 1024) throw runtimeError('HISTORY_PROJECTION_BUDGET_EXCEEDED', 429);
    events = forward ? [...events, ...batch] : [...batch, ...events];
    position = forward ? offset + length : offset;
    groups = groupEvents(events, kind, after);
    // A backward page may start inside an earlier invocation; its unknown
    // prefix cannot be projected until another bounded slice reaches its start.
    const candidates = forward && position < upper ? groups.filter(group => group.closed) : groups;
    selected = selectGroups(candidates, limit, forward);
    const messages = selected.reduce((sum, group) => sum + group.messages, 0);
    const hasAdditionalGroup = candidates.some(group => group.messages && !selected.includes(group));
    if (messages >= limit || hasAdditionalGroup) break;
  }
  const projected = (await Promise.all(selected.map(group => projectGroup(group, session, invocationId, { ...request, kind })))).flat()
    .filter(item => kind !== 'events' || after === undefined || item.SeqId > after);
  const messages = kind === 'events' ? forward ? projected.slice(0, limit) : projected.slice(-limit) : projected;
  const hasUnselected = groups.some(group => group.messages && !selected.includes(group));
  const hasMore = projected.length > messages.length || hasUnselected || (forward ? position < upper : position > 0);
  const latest = kind === 'events' && messages.length ? messages.at(-1).SeqId
    : selected.length ? selected.at(-1).events.at(-1).seq + 1 : forward ? Math.max(after, position) : Math.min(snapshot, after || 0);
  return { SessionId: session.sessionId, [kind === 'events' ? 'Events' : 'Messages']: messages, LatestSeqId: latest,
    HasMore: hasMore, ...(ordered ? { EventOrder: 'session_seq' } : {}), NextCursor: forward ? latest : hasMore && selected.length ? kind === 'events' ? messages[0]?.SeqId ?? selected[0].start : selected[0].start : null,
    ...metadata };
}

export const readFrozenSessionMessages = options => readFrozenHistoryPage(options);
export const readFrozenSessionEvents = options => readFrozenHistoryPage({ ...options, kind: 'events' });
