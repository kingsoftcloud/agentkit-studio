// @kingsoftcloud/agentkit-harness-ui — event protocol
//
// Explicitly versioned stable event protocol that a host (the AgentKit Native
// runtime, a Studio adapter, or a test harness) emits against. The UI consumes
// only these events; it never calls runtime, provider, or session-store
// internals. The reducer and the timeline are pure projections of this stream.
//
// Versioning: every event carries `v`. Bump PROTOCOL_VERSION when the event
// shapes change in a way the reducer cannot normalize. Unknown future fields
// are ignored, not rejected, so additive changes remain backward compatible.
// The reducer accepts `v` up to its known ceiling and normalizes missing
// optional fields. See README for host integration.

export const PROTOCOL_VERSION = 1;

/**
 * Event type constants. Use the string form on the wire; the constants exist
 * for readable host code and stable comparisons in tests.
 */
export const EventType = Object.freeze({
  TaskStarted: "task.started",
  TaskState: "task.state",
  TaskFinished: "task.finished",
  TextDelta: "text.delta",
  TextDone: "text.done",
  ThinkingStart: "thinking.start",
  ThinkingDelta: "thinking.delta",
  ThinkingDone: "thinking.done",
  ToolPreview: "tool.preview",
  SubagentBound: "subagent.bound",
  ToolScheduled: "tool.scheduled",
  ToolStarted: "tool.started",
  ToolState: "tool.state",
  ToolProgress: "tool.progress",
  ToolResult: "tool.result",
  ToolError: "tool.error",
  PlanUpdated: "plan.updated",
  ContextMarker: "context.marker",
});

/** Task lifecycle states the host may declare. */
export const TaskState = Object.freeze({
  Idle: "idle",
  Running: "running",
  Interrupted: "interrupted",
  Failed: "failed",
  Recovered: "recovered",
  Completed: "completed",
  Cancelled: "cancelled",
  Blocked: "blocked",
  Unverified: "unverified",
  Waiting: "waiting",
  Paused: "paused",
});

/** Host-declared terminal outcomes. */
export const TaskOutcome = Object.freeze({
  Blocked: "blocked",
  Unverified: "unverified",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
});

/**
 * Allowed task-state transitions. `cancelled` is reachable from any state
 * (the host may cancel mid-flight). Terminal states (`completed`, `cancelled`)
 * accept no further transitions. The reducer ignores `task.state` events that
 * are not in this table from the current state; it never synthesizes a state.
 */
export const TASK_TRANSITIONS = Object.freeze({
  [TaskState.Idle]: [TaskState.Running],
  [TaskState.Running]: [TaskState.Interrupted, TaskState.Failed, TaskState.Completed, TaskState.Cancelled, TaskState.Waiting, TaskState.Paused, TaskState.Blocked, TaskState.Unverified],
  [TaskState.Waiting]: [TaskState.Running, TaskState.Interrupted, TaskState.Cancelled, TaskState.Failed],
  [TaskState.Paused]: [TaskState.Running, TaskState.Interrupted, TaskState.Cancelled, TaskState.Failed],
  [TaskState.Blocked]: [],
  [TaskState.Unverified]: [],
  [TaskState.Interrupted]: [TaskState.Running, TaskState.Recovered, TaskState.Failed, TaskState.Cancelled],
  [TaskState.Failed]: [TaskState.Running, TaskState.Recovered, TaskState.Cancelled],
  [TaskState.Recovered]: [TaskState.Running, TaskState.Cancelled],
  [TaskState.Completed]: [],
  [TaskState.Cancelled]: [],
});

/** Tool lifecycle statuses, keyed by callId. */
export const ToolStatus = Object.freeze({
  Uncertain: "uncertain",
  Interrupted: "interrupted",
  Waiting: "waiting",
  Scheduled: "scheduled",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
});

/**
 * Explicit presentation payload kinds a host may attach to `tool.result`
 * `display`. The UI renders a purpose-built block for each known kind; an
 * unknown kind falls back to the generic bounded object preview. Every kind
 * is optional — a host that only emits a raw `result` still renders fine.
 */
export const DisplayKind = Object.freeze({
  CommandOutput: "command_output",
  CommandPreview: "command_preview",
  FileDiff: "file_diff",
  FileRead: "file_read",
  FileEdit: "file_edit",
  Generic: "generic",
});
const DISPLAY_KINDS = new Set(Object.values(DisplayKind));

const EVENT_TYPES = new Set(Object.values(EventType));
const TASK_STATES = new Set(Object.values(TaskState));
const TASK_OUTCOMES = new Set(Object.values(TaskOutcome));
const TOOL_STATUSES = new Set(Object.values(ToolStatus));

/**
 * @typedef {Object} HarnessEvent envelope shared by every event.
 * @property {1} v protocol version; must equal PROTOCOL_VERSION.
 * @property {string} type one of EventType.
 * @property {string} id stable event id; replaying the same id is a no-op.
 * @property {"interrupted"} [executionState] closed driver state, separate from an unverified outcome.
 * @property {number} [ts] client-observed timestamp (ms); for diagnostics only.
 * @property {number} [seq] optional host monotonic sequence; for replay audit.
 */

/**
 * Validate an event envelope and its type-specific payload. Returns a normalized
 * copy with missing optional fields filled. Throws on an unrecoverable shape
 * (unknown event type, wrong protocol version, missing required id/type).
 * Malformed payloads the UI can survive (e.g. a tool input that is not an
 * object) are coerced to a safe default rather than thrown, matching the
 * tool-detail-block failure contract: skip invalid fields, never break render.
 *
 * @param {HarnessEvent & Record<string, unknown>} event
 * @returns {HarnessEvent & Record<string, unknown>}
 */
export function normalizeEvent(event) {
  if (!event || typeof event !== "object") throw new TypeError("event must be an object");
  const v = event.v;
  if (v !== PROTOCOL_VERSION) {
    throw new RangeError(`event.v is ${String(v)}; expected protocol version ${PROTOCOL_VERSION}`);
  }
  const type = String(event.type || "");
  if (!EVENT_TYPES.has(type)) throw new RangeError(`unknown event type: ${String(event.type)}`);
  const id = event.id == null ? "" : String(event.id);
  if (!id) throw new RangeError(`event.id is required for ${type}`);
  const base = { v, type, id, ts: typeof event.ts === "number" ? event.ts : null, seq: typeof event.seq === "number" ? event.seq : null };
  return Object.assign(base, normalizePayload(type, event));
}

function normalizePayload(type, event) {
  switch (type) {
    case EventType.TaskStarted:
      return { taskId: str(event.taskId), title: str(event.title) || null, runId: str(event.runId) || null };
    case EventType.TaskState:
      return { state: requiredChoice(event.state, TASK_STATES, "task state"), reason: str(event.reason) || null, message: str(event.message) || null };
    case EventType.TaskFinished: {
      const outcome = requiredChoice(event.outcome, TASK_OUTCOMES, "task outcome");
      if (event.executionState !== undefined && (event.executionState !== TaskState.Interrupted || outcome !== TaskOutcome.Unverified))
        throw new RangeError('interrupted execution requires an unverified outcome');
      return { outcome, summary: str(event.summary) || null, error: str(event.error) || null, reason: str(event.reason) || null,
        ...(event.executionState === TaskState.Interrupted ? { executionState: TaskState.Interrupted } : {}),
        verificationRequired: typeof event.verificationRequired === 'boolean' ? event.verificationRequired : null };
    }
    case EventType.TextDelta:
      return { itemId: str(event.itemId), delta: str(event.delta) };
    case EventType.TextDone:
      return { itemId: str(event.itemId), ...(typeof event.sourceMessageId === "string" ? { sourceMessageId: event.sourceMessageId } : {}), ...(typeof event.text === "string" ? { text: event.text } : {}),
        ...(event.role === "user" ? { role: "user" } : {}) };
    case EventType.ThinkingStart:
      return { itemId: str(event.itemId), provider: true };
    case EventType.ThinkingDelta:
      return { itemId: str(event.itemId), delta: str(event.delta), provider: true };
    case EventType.ThinkingDone:
      return { itemId: str(event.itemId), provider: true,
        ...(typeof event.sourceMessageId === "string" ? { sourceMessageId: event.sourceMessageId } : {}),
        ...(typeof event.text === "string" ? { text: event.text } : {}),
        ...(event.duration != null ? { duration: numberOrNull(event.duration) } : {}) };
    case EventType.SubagentBound: {
      const child = event.child;
      if (!child || !['runId', 'sessionId', 'parentRunId', 'role', 'title'].every(key => typeof child[key] === 'string')
        || !child.runId || !child.sessionId || !child.parentRunId || child.title.length > 512) throw Error('Invalid subagent identity');
      return { callId: str(event.callId), child: { runId: child.runId, sessionId: child.sessionId,
        parentRunId: child.parentRunId, role: child.role, title: child.title, phase: str(child.phase),
        activity: child.activity && typeof child.activity.name === 'string' && TOOL_STATUSES.has(child.activity.status)
          ? { name: child.activity.name, input: asObject(child.activity.input), status: child.activity.status } : null } };
    }
    case EventType.ToolState:
      return { callId: str(event.callId), status: requiredChoice(event.status, TOOL_STATUSES, "tool state"), message: str(event.message) || null };
    case EventType.ToolPreview:
      return { previewId: str(event.previewId), name: str(event.name) || 'tool', input: asObject(event.input),
        receivedChars: Number.isSafeInteger(event.receivedChars) && event.receivedChars >= 0 ? event.receivedChars : 0 };
    case EventType.ToolScheduled:
      return { callId: str(event.callId), name: str(event.name) || "tool", input: asObject(event.input) };
    case EventType.ToolStarted:
      return { callId: str(event.callId) };
    case EventType.ToolProgress:
      return { callId: str(event.callId), progress: str(event.progress) || null, message: str(event.message) || null,
        display: normalizeDisplay(event.display) };
    case EventType.ToolResult:
      return { callId: str(event.callId), result: event.result === undefined ? null : event.result, display: normalizeDisplay(event.display) };
    case EventType.ToolError:
      return { callId: str(event.callId), error: str(event.error) || "tool failed" };
    case EventType.ContextMarker: {
      const marker = event.marker;
      if (!marker || typeof marker.id !== 'string' || !marker.id || marker.id.length > 256
        || !['running', 'completed', 'failed', 'interrupted', 'noop'].includes(marker.status)
        || !['auto', 'manual'].includes(marker.origin) || !marker.after
        || !['start', 'tool', 'message'].includes(marker.after.kind)
        || marker.after.kind !== 'start' && (typeof marker.after.id !== 'string' || !marker.after.id || marker.after.id.length > 256))
        throw Error('Invalid context marker');
      return { marker: { id: marker.id, status: marker.status, origin: marker.origin,
        after: { kind: marker.after.kind, ...(marker.after.id ? { id: marker.after.id } : {}) } } };
    }
    case EventType.PlanUpdated:
      return { items: Array.isArray(event.items) ? event.items.map(normalizePlanItem).filter(Boolean) : [] };
    default:
      return {};
  }
}

function normalizePlanItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: str(item.id),
    content: str(item.content),
    status: pick(item.status, new Set(["pending", "in_progress", "completed"]), "pending"),
    priority: str(item.priority) || null,
  };
}

function str(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value }; }
    catch { return { value }; }
  }
  return value == null ? {} : { value: str(value) };
}

/**
 * Normalize a `tool.result`/`tool.progress` display payload. A known `kind`
 * yields a purpose-built shape; an unknown or missing kind falls back to a
 * generic object so the generic renderer still renders something safe. The
 * normalizer never reads files or infers a write succeeded — it only carries
 * the host-supplied fields through, coerced to safe primitives.
 * @param {unknown} display
 * @returns {Record<string, unknown>}
 */
function normalizeDisplay(display) {
  const obj = asObject(display);
  if (!obj || typeof obj !== "object") return {};
  const kind = pick(obj.kind, DISPLAY_KINDS, DisplayKind.Generic);
  switch (kind) {
    case DisplayKind.CommandOutput:
      return {
        kind, stdout: str(obj.stdout), stderr: str(obj.stderr),
        exit: numberOrNull(obj.exit ?? obj.exitCode ?? obj.code ?? obj.returncode),
        cwd: str(obj.cwd),
      };
    case DisplayKind.CommandPreview:
      return { kind, fullText: str(obj.fullText ?? obj.stdout ?? obj.text),
        ...(typeof obj.stderr === 'string' ? { stderr: obj.stderr } : {}) };
    case DisplayKind.FileDiff:
      return {
        kind, path: str(obj.path), patch: str(obj.patch),
        changeStat: normalizeChangeStat(obj.changeStat),
        operationKind: str(obj.operationKind) || null,
      };
    case DisplayKind.FileRead:
      return { kind, path: str(obj.path), entryType: pick(obj.entryType, new Set(["file", "directory"]), "file") };
    case DisplayKind.FileEdit:
      return { kind, omittedFiles: Number.isSafeInteger(obj.omittedFiles) && obj.omittedFiles > 0 ? obj.omittedFiles : 0,
        files: Array.isArray(obj.files) ? obj.files.map(normalizeFileEdit).filter(Boolean) : [] };
    default:
      return { ...obj, kind };
  }
}

function normalizeFileEdit(file) {
  if (!file || typeof file !== "object") return null;
  return {
    path: str(file.path),
    patch: str(file.patch),
    truncated: file.truncated === true,
    changeStat: normalizeChangeStat(file.changeStat),
    operationKind: str(file.operationKind) || null,
  };
}

function normalizeChangeStat(stat) {
  if (!stat || typeof stat !== "object") return null;
  const added = numberOrNull(stat.added);
  const removed = numberOrNull(stat.removed);
  if (added == null && removed == null) return null;
  return { added: Math.max(0, added ?? 0), removed: Math.max(0, removed ?? 0) };
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @returns {boolean} */
export function isDisplayKind(value) {
  return DISPLAY_KINDS.has(String(value));
}

function pick(value, allowed, fallback) {
  const s = str(value);
  return allowed.has(s) ? s : fallback;
}

/**
 * @param {unknown} state
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (to === TaskState.Cancelled) return from !== TaskState.Completed && from !== TaskState.Cancelled;
  const allowed = TASK_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

/** @returns {boolean} */
export function isTaskState(value) {
  return TASK_STATES.has(String(value));
}

/** @returns {boolean} */
export function isToolStatus(value) {
  return TOOL_STATUSES.has(String(value));
}

/** @returns {boolean} */
export function isEventType(value) {
  return EVENT_TYPES.has(String(value));
}

function requiredChoice(value, allowed, label) {
  if (!allowed.has(value)) throw new TypeError(`Missing or unsupported ${label}`);
  return value;
}
