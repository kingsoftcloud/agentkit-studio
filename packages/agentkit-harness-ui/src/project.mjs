import { contextTimelineItems } from './context-markers.mjs';
// @kingsoftcloud/agentkit-harness-ui — projection selectors
//
// Pure read-only selectors over reducer state. They derive the concise facts the
// timeline renders (ordered items, streaming/waiting flags, plan progress,
// active tool, errors) without mutating state. Kept separate from the view so
// the same projections can be tested and reused by hosts and screens readers.

import { TaskState, ToolStatus } from "./protocol.mjs";
import { toolConversationVisible } from './tool-identity.mjs';

/**
 * Ordered timeline items in stream order. The reducer already maintains order;
 * this selector is the stable seam for hosts that build their own view.
 * @param {object} state
 * @returns {object[]}
 */
export function visibleItems(state, { includeInternal = false } = {}) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const timeline = contextTimelineItems(items, state?.contextMarkers);
  if (includeInternal) return timeline;
  const visible = [];
  for (const item of timeline) {
    if (['tool', 'tool-preview'].includes(item.kind) && !toolConversationVisible(item)) continue;
    if (item.kind === 'thought' && !String(item.text ?? '').trim()) continue;
    const previous = visible.at(-1);
    if (item.kind === 'thought' && previous?.kind === 'thought') {
      const parts = [...previous.parts ?? [previous], item];
      visible[visible.length - 1] = { ...previous, parts, memberIds: parts.map(part => part.id),
        ...(parts.some(part => part.responseId) ? { responseId: parts.every(part => part.responseId === parts[0].responseId) ? parts[0].responseId : undefined } : {}),
        text: parts.map(part => part.text).join('\n\n'), streaming: parts.some(part => part.streaming),
        duration: parts.every(part => Number.isFinite(part.duration)) ? parts.reduce((sum, part) => sum + part.duration, 0) : undefined };
    } else visible.push(item);
  }
  return visible;
}

/** True when any text or thought is still streaming. */
export function isStreaming(state) {
  return visibleItems(state).some(item => item.streaming);
}

/**
 * True when the task is running but no visible transcript item has arrived yet.
 * The timeline shows a neutral "Thinking…" status placeholder in this
 * window. This is a status indicator, not a transcript item — it is never
 * invented reasoning content, and `thinking.start` alone (which creates no
 * item) still leaves the window open until the first delta lands.
 * @param {object} state
 */
export function isWaitingForFirstToken(state) {
  if (!state) return false;
  if (state.taskState !== TaskState.Running) return false;
  return visibleItems(state).length === 0;
}

/** A finished interrupted driver can still have an unverified outcome. */
export function isTerminal(state) {
  return state?.taskState === TaskState.Interrupted && state.taskOutcome != null
    || state?.taskState === TaskState.Completed
    || state?.taskState === TaskState.Failed
    || state?.taskState === TaskState.Cancelled
    || state?.taskState === TaskState.Blocked
    || state?.taskState === TaskState.Unverified;
}

/** Concise plan progress: completed count, total, and the in-progress label. */
export function planProgress(state) {
  const plan = state?.plan;
  if (!Array.isArray(plan) || !plan.length) return null;
  const total = plan.length;
  const completed = plan.filter(item => item.status === "completed").length;
  const inProgress = plan.find(item => item.status === "in_progress");
  return {
    total,
    completed,
    inProgress: inProgress ? { id: inProgress.id, content: inProgress.content } : null,
    ratio: total ? completed / total : 0,
  };
}

/** The most recent tool that is still scheduled/running, if any. */
export function activeTool(state) {
  const items = visibleItems(state);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "tool" && (item.status === ToolStatus.Running || item.status === ToolStatus.Scheduled)) {
      return item;
    }
  }
  return null;
}

/** Failed tool items, newest first, for concise error surfacing. */
export function failedTools(state) {
  return visibleItems(state).filter(item => item.kind === "tool" && item.status === ToolStatus.Failed);
}

/** A one-line concise status string for the task, host-declared only. */
export function taskStatusLabel(state, labels = DEFAULT_LABELS) {
  const s = state?.taskState;
  if (s === TaskState.Running) {
    const tool = activeTool(state);
    if (tool) return tool.name;
    if (state.pendingThinking?.size || visibleItems(state).some(i => i.kind === "thought" && i.streaming)) {
      return labels.thinking;
    }
    return labels.running;
  }
  if (s === TaskState.Interrupted) return labels.interrupted;
  if (s === TaskState.Recovered) return labels.recovered;
  if (s === TaskState.Failed) return labels.failed;
  if (s === TaskState.Completed) return labels.completed;
  if (s === TaskState.Cancelled) return labels.cancelled;
  if (s === TaskState.Blocked) return labels.blocked || "Blocked";
  if (s === TaskState.Unverified) return state.verificationRequired === true
    ? labels.unverified || "Unverified" : labels.ended || "Finished";
  if (s === TaskState.Waiting) return labels.waiting || "Waiting for input";
  if (s === TaskState.Paused) return labels.paused || "Paused";
  return labels.idle;
}

export const DEFAULT_LABELS = Object.freeze({
  idle: "",
  running: "Running",
  thinking: "Thinking…",
  interrupted: "Interrupted",
  recovered: "Recovering",
  failed: "Failed",
  completed: "Completed",
  cancelled: "Cancelled",
});
