// @kingsoftcloud/agentkit-harness-ui — state reducer
//
// Pure reducer over the versioned event protocol. It owns:
//  - streaming assistant text (append-on-delta, finalize-on-done)
//  - provider-supplied thinking (placeholder created only on the first
//    non-empty delta, never on `thinking.start` alone — no invented reasoning)
//  - single keyed tool calls, updated in place through
//    scheduled/started/progress/result/error for the same callId
//  - task-state interruption/failure/recovery via a validated transition table
//  - ordered items preserving the provider stream order, with deduplication by
//    event id for safe replay and a fallback tool part for out-of-order results
//
// No invented thinking or success: the reducer never synthesizes reasoning
// text, never marks a task completed without a host `task.finished` event, and
// never attributes aggregate usage to an individual segment.

import {
  EventType, TaskState, TaskOutcome, ToolStatus, canTransition, normalizeEvent,
} from "./protocol.mjs";

/** @returns {object} a fresh empty harness state. */
export function initialState() {
  return {
    protocolVersion: 1,
    taskId: null,
    taskTitle: null,
    runId: null,
    taskState: TaskState.Idle,
    taskReason: null,
    taskMessage: null,
    taskOutcome: null,
    taskSummary: null, // host-supplied only; never synthesized
    taskError: null,
    taskStartedAt: null, taskEndedAt: null, finalAnswerId: null,
    verificationRequired: null,
    contextMarkers: [],
    subagents: new Map(),
    items: [], // ordered TimelineItem[]
    seen: new Set(), // event ids already applied (dedup/replay)
    pendingThinking: new Set(), // itemIds that had thinking.start but no delta yet
    plan: null, // PlanItem[] | null
    lastSeq: null,
  };
}

/**
 * Apply one (raw or normalized) event. Replay-safe: an event id that was already
 * applied is a no-op. Returns the previous state for malformed envelopes the
 * reducer cannot normalize, so a bad event never corrupts the timeline.
 * @param {object} state
 * @param {object} event
 * @returns {object}
 */
export function reduce(state, event) {
  if (!state) state = initialState();
  let normalized;
  try {
    normalized = normalizeEvent(event);
  } catch {
    return state;
  }
  if (state.seen.has(normalized.id)) return state; // idempotent replay
  const next = shallowClone(state);
  next.seen = new Set(state.seen);
  next.seen.add(normalized.id);
  next.items = state.items.slice();
  next.pendingThinking = new Set(state.pendingThinking);
  if (normalized.seq != null && (next.lastSeq == null || normalized.seq > next.lastSeq)) {
    next.lastSeq = normalized.seq;
  }
  apply(next, normalized);
  return next;
}

/** Apply a batch in arrival order. @param {object[]} events */
export function reduceAll(state, events) {
  let current = state || initialState();
  for (const event of Array.isArray(events) ? events : []) current = reduce(current, event);
  return current;
}

function apply(state, e) {
  switch (e.type) {
    case EventType.TaskStarted: return applyTaskStarted(state, e);
    case EventType.TaskState: return applyTaskState(state, e);
    case EventType.TaskFinished: return applyTaskFinished(state, e);
    case EventType.TextDelta: return applyTextDelta(state, e);
    case EventType.TextDone: return applyTextDone(state, e);
    case EventType.ThinkingStart: return applyThinkingStart(state, e);
    case EventType.ThinkingDelta: return applyThinkingDelta(state, e);
    case EventType.ThinkingDone: return applyThinkingDone(state, e);
    case EventType.SubagentBound: {
      if (!e.callId) return;
      state.subagents = new Map(state.subagents ?? []); state.subagents.set(e.callId, e.child);
      const index = findToolIndex(state, e.callId);
      if (index >= 0) itemAt(state, index).child = e.child;
      return;
    }
    case EventType.ToolPreview: {
      if (!e.previewId) return;
      settlePriorReasoning(state, e);
      const previous = state.items.findIndex(item => item.kind === 'tool-preview' && item.id === e.previewId);
      const preview = { kind: 'tool-preview', id: e.previewId, name: e.name, input: e.input,
        receivedChars: e.receivedChars, streaming: true, ...(e.responseId ? { responseId: e.responseId } : {}) };
      if (previous >= 0) state.items[previous] = preview; else state.items.push(preview);
      return;
    }
    case EventType.ToolScheduled: return applyTool(state, e, ToolStatus.Scheduled);
    case EventType.ToolStarted: return applyTool(state, e, ToolStatus.Running);
    case EventType.ToolState: return applyTool(state, e, e.status, e);
    case EventType.ToolProgress: return applyTool(state, e, ToolStatus.Running, e);
    case EventType.ToolResult: return applyTool(state, e, ToolStatus.Completed, e);
    case EventType.ToolError: return applyTool(state, e, ToolStatus.Failed, e);
    case EventType.ContextMarker: {
      const markers = [...state.contextMarkers ?? []];
      const index = markers.findIndex(marker => marker.id === e.marker.id);
      if (index < 0) markers.push(e.marker); else markers[index] = e.marker;
      state.contextMarkers = markers; return;
    }
    case EventType.PlanUpdated: return applyPlan(state, e);
    default: return state;
  }
}

function applyTaskStarted(state, e) {
  state.taskId = e.taskId || state.taskId;
  state.taskTitle = e.title || state.taskTitle;
  state.runId = e.runId || state.runId;
  // started always (re)enters running from idle or a non-terminal state.
  if (canTransition(state.taskState, TaskState.Running) || state.taskState === TaskState.Idle) {
    state.taskState = TaskState.Running;
  } else {
    return; // A delayed start cannot reopen a terminal task.
  }
  state.taskOutcome = null;
  state.taskSummary = null;
  state.taskError = null;
  state.taskReason = null;
  state.taskMessage = null;
  if (e.startedAt !== undefined) state.taskStartedAt = e.startedAt;
  state.taskEndedAt = null; state.finalAnswerId = null;
}

function applyTaskState(state, e) {
  if (!canTransition(state.taskState, e.state)) return; // ignore invalid transitions
  state.taskState = e.state;
  state.taskReason = e.reason;
  state.taskMessage = e.message;
  if (e.state === TaskState.Running || e.state === TaskState.Recovered) {
    state.taskOutcome = null;
    state.taskError = null;
  }
}

function applyTaskFinished(state, e) {
  state.verificationRequired = e.verificationRequired;
  state.taskOutcome = e.outcome;
  state.taskSummary = e.summary; // host-supplied; may be null — never invented
  state.taskError = e.error || null;
  state.taskReason = e.reason || null;
  state.taskEndedAt = e.endedAt ?? null;
  state.finalAnswerId = ['completed', 'unverified'].includes(e.outcome) && !e.error && e.executionState !== 'interrupted'
    ? e.finalAnswerId ?? null : null;
  if (e.outcome === TaskOutcome.Completed) state.taskState = TaskState.Completed;
  else if (e.outcome === TaskOutcome.Cancelled) state.taskState = TaskState.Cancelled;
  else if (e.outcome === TaskOutcome.Failed) state.taskState = TaskState.Failed;
  else if (e.outcome === TaskOutcome.Blocked) state.taskState = TaskState.Blocked;
  else if (e.outcome === TaskOutcome.Unverified) state.taskState = TaskState.Unverified;
  if (e.executionState === TaskState.Interrupted) state.taskState = TaskState.Interrupted;
  // finalize any still-streaming items: a finished task has no live streams.
  // Clone each affected item so prior state snapshots are not mutated.
  for (let i = 0; i < state.items.length; i += 1) {
    const item = state.items[i];
    const liveText = item.streaming;
    const liveTool = item.kind === "tool" && (item.status === ToolStatus.Scheduled || item.status === ToolStatus.Running);
    if (liveText || liveTool) state.items[i] = { ...item, streaming: false, ...(liveTool ? { status: ToolStatus.Interrupted } : {}) };
  }
  state.pendingThinking = new Set();
}

function applyTextDelta(state, e) {
  if (!e.itemId) return;
  if (e.delta) settlePriorReasoning(state, e);
  const index = findItemIndex(state, e.itemId);
  if (index >= 0) {
    const item = itemAt(state, index);
    item.text = (item.text || "") + e.delta;
    item.streaming = true;
    if (e.responseId) item.responseId = e.responseId;
    return;
  }
  state.items.push({ kind: "text", id: e.itemId, text: e.delta, streaming: true, ...(e.responseId ? { responseId: e.responseId } : {}) });
}

function applyTextDone(state, e) {
  if (e.text) settlePriorReasoning(state, e);
  const index = findItemIndex(state, e.itemId);
  if (index >= 0 && state.items[index].kind === "text") {
    const item = itemAt(state, index);
    if (e.text !== undefined) item.text = e.text;
    item.streaming = false;
    if (e.sourceMessageId) item.sourceMessageId = e.sourceMessageId;
    if (e.responseId) item.responseId = e.responseId;
  } else if (e.itemId && e.text) state.items.push({ kind: "text", id: e.itemId, text: e.text, role: e.role ?? "assistant", streaming: false,
    ...(e.responseId ? { responseId: e.responseId } : {}), ...(e.sourceMessageId ? { sourceMessageId: e.sourceMessageId } : {}) });
}

function applyThinkingStart(state, e) {
  // reasoning_start alone must not create visible transcript noise: record the
  // pending id without emitting an item.
  if (e.itemId) state.pendingThinking.add(e.itemId);
}

function applyThinkingDelta(state, e) {
  if (!e.itemId) return;
  if (!e.delta) {
    // An empty delta with a prior start keeps the pending marker; no item yet.
    if (state.pendingThinking.has(e.itemId)) return;
  }
  const index = findItemIndex(state, e.itemId);
  if (index >= 0) {
    const item = itemAt(state, index);
    item.text = (item.text || "") + e.delta;
    item.streaming = true;
    if (e.responseId) item.responseId = e.responseId;
    return;
  }
  // First non-empty delta creates the placeholder. A provider that emits a delta
  // without a matching start still gets a placeholder (spec fallback).
  if (!e.delta) return;
  state.pendingThinking.delete(e.itemId);
  state.items.push({ kind: "thought", id: e.itemId, text: e.delta, streaming: true, provider: true,
    ...(e.responseId ? { responseId: e.responseId } : {}) });
}

function applyThinkingDone(state, e) {
  state.pendingThinking.delete(e.itemId);
  const index = findItemIndex(state, e.itemId);
  if (index >= 0 && state.items[index].kind === "thought") {
    const item = itemAt(state, index);
    if (e.text !== undefined) item.text = e.text;
    item.streaming = false;
    if (e.sourceMessageId) item.sourceMessageId = e.sourceMessageId;
    if (e.responseId) item.responseId = e.responseId;
    // Host-supplied real duration (seconds); never invented by the reducer.
    if (e.duration != null) item.duration = e.duration;
  } else if (e.itemId && e.text) state.items.push({ kind: "thought", id: e.itemId, text: e.text, streaming: false, provider: true,
    ...(e.responseId ? { responseId: e.responseId } : {}), ...(e.sourceMessageId ? { sourceMessageId: e.sourceMessageId } : {}), ...(e.duration != null ? { duration: e.duration } : {}) });
  // If only a start arrived, no item was ever created — nothing to finalize.
}

function applyTool(state, e, status, payload) {
  if (!e.callId) return;
  if (status === ToolStatus.Scheduled) settlePriorReasoning(state, e);
  const index = findToolIndex(state, e.callId);
  if (index >= 0) {
    const item = itemAt(state, index);
    // Late schedule/progress frames can supply missing metadata but cannot
    // reopen a settled call. A conflicting terminal is retained as received.
    const settled = [ToolStatus.Completed, ToolStatus.Failed, ToolStatus.NotDispatched].includes(item.status);
    if (settled && ![ToolStatus.Completed, ToolStatus.Failed, ToolStatus.NotDispatched].includes(status)) {
      if (e.type === EventType.ToolScheduled) { item.name = e.name || item.name; item.input = e.input;
        if (e.responseId) item.responseId = e.responseId; }
      return;
    }
    // Update the existing part in place: stable position, same callId.
    if (e.type === EventType.ToolScheduled) {
      item.name = e.name || item.name;
      item.input = e.input;
      if (e.responseId) item.responseId = e.responseId;
    }
    if (state.subagents?.has(e.callId)) item.child = state.subagents.get(e.callId);
    if (payload && e.type === EventType.ToolProgress) {
      item.progress = payload.progress || payload.message || null;
      // A running execute may stream its partial output via tool.progress with
      // a command_preview display; keep it on the item so the renderer shows
      // live output without a result. The reducer never invents output: an
      // empty display leaves the previous value untouched.
      if (payload.display && payload.display.kind) item.display = payload.display;
    }
    if (payload && e.type === EventType.ToolResult) {
      item.result = payload.result;
      item.display = payload.display;
    }
    if (payload && e.type === EventType.ToolError) {
      item.error = payload.error;
    }
    if (e.type === EventType.ToolState) item.progress = e.message;
    item.status = status;
    return;
  }
  // Out-of-order terminal event: append a minimal fallback tool part. Missing
  // input details are acceptable; missing transcript rendering is not.
  const fallback = { kind: "tool", callId: e.callId,
    ...(e.responseId ? { responseId: e.responseId } : {}),
    ...(state.subagents?.has(e.callId) ? { child: state.subagents.get(e.callId) } : {}), name: e.name || "tool", input: e.input || {}, status };
  if (payload && e.type === EventType.ToolResult) { fallback.result = payload.result; fallback.display = payload.display; }
  if (payload && e.type === EventType.ToolError) { fallback.error = payload.error; }
  if (payload && e.type === EventType.ToolProgress) {
    fallback.progress = payload.progress || payload.message || null;
    if (payload.display && payload.display.kind) fallback.display = payload.display;
  }
  state.items.push(fallback);
}

/** The active channel is scoped to a model response, not the whole task. A
 * public content/tool delta ends the preceding reasoning presentation; a later
 * real reasoning delta can reopen it. This supplies no synthetic content or
 * duration, and cannot settle another response or a child stream. */
function settlePriorReasoning(state, event) {
  if (!event.responseId) return;
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    if (item.kind === 'thought' && item.streaming && item.responseId === event.responseId)
      itemAt(state, i).streaming = false;
  }
}

function applyPlan(state, e) {
  state.plan = Array.isArray(e.items) && e.items.length ? e.items : null;
}

function findItemIndex(state, id) {
  for (let i = 0; i < state.items.length; i += 1) if (state.items[i].id === id) return i;
  return -1;
}

function findToolIndex(state, callId) {
  for (let i = 0; i < state.items.length; i += 1) {
    const item = state.items[i];
    if (item.kind === "tool" && item.callId === callId) return i;
  }
  return -1;
}

/**
 * Return a shallow-cloned item at `index` and store the clone back into the
 * (already shallow-copied) items array. Callers then mutate the clone, so the
 * previous state's item objects stay intact and snapshots a host holds are
 * not corrupted by later events.
 */
function itemAt(state, index) {
  const clone = { ...state.items[index] };
  state.items[index] = clone;
  return clone;
}

function shallowClone(state) {
  return Object.assign({}, state, {
    items: state.items,
    seen: state.seen,
    pendingThinking: state.pendingThinking,
    plan: state.plan,
  });
}
