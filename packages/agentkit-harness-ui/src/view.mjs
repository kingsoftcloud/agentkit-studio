import { latestSummaryLine } from './summary-playback.mjs';
// @kingsoftcloud/agentkit-harness-ui — pure view model
//
// Produces a serializable element tree (React-element-shaped plain objects)
// from reducer state, with stable `data-testid` selectors and accessibility
// attributes. Carries the "no invented thinking or success" invariants:
//  - a thought block exists only when the reducer created one from a non-empty
//    provider delta; `thinking.start` alone never produces a visible item.
//  - no token/character counts are ever rendered for thinking.
//  - a completed task shows only a host-supplied summary; the UI never
//    synthesizes a success message.
//  - errors are redacted and bounded; tool detail blocks are bounded and
//    redacted and never dump large content verbatim.
//
// The tree holds no functions, so it is fully testable with node:test. The
// React binding in components.mjs maps this tree to React.createElement and
// attaches delegated event handlers on the root.

import { TaskState } from "./protocol.mjs";
import { visibleItems, isWaitingForFirstToken, isTerminal, planProgress, taskStatusLabel, DEFAULT_LABELS } from "./project.mjs";
import { latestNonEmptyLine, truncateText } from "./summary.mjs";
import { redactError } from "./tool-detail.mjs";
import { renderTool } from "./renderers.mjs";
import { toolPreviewBlock } from './tool-preview.mjs';

export const ELEMENT = Symbol.for("agentkit.harness-ui.element");

/** @returns {boolean} */
export function isElement(node) {
  return node != null && typeof node === "object" && node.$$typeof === ELEMENT;
}

/**
 * Create a plain element node. Null/false children and empty arrays are
 * flattened out, matching JSX semantics, so conditional rendering stays terse.
 */
export function h(type, props, ...children) {
  const kids = [];
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c == null || c === false) continue;
        kids.push(c);
      }
    } else kids.push(child);
  }
  return { $$typeof: ELEMENT, type, props: props == null ? {} : props, children: kids };
}

// ── inline SVG icons ───────────────────────────────────────────────────────
// Reimplemented from the Lucide icon set (ISC; see NOTICE) as plain `h` nodes so
// the function-free view tree carries real vector glyphs instead of emoji. No
// source is copied from the Lucide package; the path data is the published
// geometric description of each icon. Each svg is sized by CSS (`.harness-icon`).
const SVG_ATTRS = {
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2,
  strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false",
};

/** Build an icon element from a list of shape nodes. */
function icon(shapes, className) {
  return h("svg", { ...SVG_ATTRS, className: `harness-icon${className ? ` ${className}` : ""}` }, ...shapes);
}

/** Brain icon — the reasoning/thought kind marker (lucide `brain`). */
export function brainIcon(className) {
  return icon([
    h("path", { d: "M12 18V5" }),
    h("path", { d: "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" }),
    h("path", { d: "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" }),
    h("path", { d: "M17.997 5.125a4 4 0 0 1 2.526 5.77" }),
    h("path", { d: "M18 18a4 4 0 0 0 2-7.464" }),
    h("path", { d: "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" }),
    h("path", { d: "M6 18a4 4 0 0 1-2-7.464" }),
    h("path", { d: "M6.003 5.125a4 4 0 0 0-2.526 5.77" }),
  ], className);
}

/** Disclosure chevron (lucide `chevron-right`); rotated to point down when open. */
export function chevronIcon(className) {
  return icon([h("path", { d: "m9 18 6-6-6-6" })], className);
}

/** Terminal/execute kind icon (lucide `square-terminal`). */
export function terminalIcon(className) {
  return icon([
    h("path", { d: "m7 11 2-2-2-2" }),
    h("path", { d: "M11 13h4" }),
    h("rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }),
  ], className);
}

/** File-read kind icon (lucide `file-text`). */
export function fileTextIcon(className) {
  return icon([
    h("path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }),
    h("path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }),
    h("path", { d: "M10 9H8" }),
    h("path", { d: "M16 13H8" }),
    h("path", { d: "M16 17H8" }),
  ], className);
}

/** Search/list kind icon (lucide `search`). */
export function searchIcon(className) {
  return icon([
    h("path", { d: "m21 21-4.34-4.34" }),
    h("circle", { cx: 11, cy: 11, r: 8 }),
  ], className);
}

/** Edit/write kind icon (lucide `pencil-line`). */
export function pencilIcon(className) {
  return icon([
    h("path", { d: "M13 21h8" }),
    h("path", { d: "m15 5 4 4" }),
    h("path", { d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" }),
  ], className);
}

/** Default/unknown tool kind icon (lucide `wrench`). */
export function wrenchIcon(className) {
  return icon([
    h("path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" }),
  ], className);
}

export const DEFAULT_VIEW_OPTIONS = Object.freeze({
  thoughtOpen: null, // Map<itemId, boolean> overrides (default: collapsed)
  toolOpen: null, // Map<callId, boolean> overrides (default: open while running)
  labels: DEFAULT_LABELS,
  workspaceRoot: null,
  following: true, // when false, a "jump to latest" button is rendered
  ariaLabel: "Task timeline",
  emptyState: null, // plain element to render when there is no content at all
  summaryMaxChars: 160,
  diffMaxLines: 200,
});

/**
 * Build the timeline view model.
 * @param {object} state reducer state
 * @param {Partial<typeof DEFAULT_VIEW_OPTIONS> & { rootProps?: object }} [options]
 */
export function buildViewModel(state, options = {}) {
  const opts = { ...DEFAULT_VIEW_OPTIONS, ...options };
  // Merge labels with defaults so a host passing a partial labels object (or
  // none) still gets the stable fallbacks; an explicit undefined from a
  // destructure must not clobber the defaults.
  opts.labels = { ...DEFAULT_LABELS, ...(options.labels || {}) };
  const items = visibleItems(state);
  const plan = planProgress(state);
  const rootChildren = [];
  if (plan) rootChildren.push(planDock(plan, opts));
  rootChildren.push(timelineList(state, items, opts));
  return h("section", {
    className: "harness-timeline-shell",
    "data-testid": "harness-timeline",
    role: "log",
    "aria-label": opts.ariaLabel,
    "aria-busy": isWaitingForFirstToken(state) ? "true" : "false",
    ...(opts.rootProps || {}),
  }, ...rootChildren);
}

function timelineList(state, items, opts) {
  const kids = [];
  if (isWaitingForFirstToken(state)) kids.push(waitingPlaceholder(opts));
  for (const item of items) {
    if (item.kind === "text") kids.push(textBlock(item, opts));
    else if (item.kind === "thought") kids.push(thoughtBlock(item, opts));
    else if (item.kind === "tool") kids.push(toolBlock(item, opts));
    else if (item.kind === 'context-marker') kids.push(contextMarker(item, opts));
    else if (item.kind === 'tool-preview') kids.push(toolPreviewBlock(item, opts));
  }
  if (!kids.length && opts.emptyState) kids.push(opts.emptyState);
  const status = statusLine(state, opts);
  if (status) kids.push(status);
  if (opts.following === false) kids.push(jumpToLatest(opts));
  return h("div", { className: "harness-timeline", "data-testid": "harness-timeline-list" }, ...kids);
}

function contextMarker(item, opts) {
  const fallback = { running: 'Compacting context', completed: item.origin === 'auto' ? 'Context automatically compressed' : 'Context compressed',
    failed: 'Context compaction failed', interrupted: 'Context compaction interrupted', noop: 'Context is already up to date' };
  const label = opts.labels['context' + item.status[0].toUpperCase() + item.status.slice(1)] || fallback[item.status];
  return h('div', { className: 'harness-context-marker', 'data-testid': 'context-marker', 'data-item-id': item.id,
    'data-status': item.status, role: 'status' },
    h('span', { className: 'harness-context-rule', 'aria-hidden': true }),
    item.status === 'running' ? null : h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('rect', { x: 2, y: 3, width: 20, height: 5, rx: 1 }),
      h('path', { d: 'M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8' }), h('path', { d: 'M10 12h4' })),
    h('span', { className: item.status === 'running' ? 'harness-thought-label-streaming' : undefined }, label),
    h('span', { className: 'harness-context-rule', 'aria-hidden': true }));
}

function waitingPlaceholder(opts) {
  return h("div", {
    className: "harness-thinking-placeholder",
    role: "status",
    "data-testid": "task-waiting",
    "aria-live": "polite",
  }, h("span", { className: "harness-shimmer" }, opts.labels.thinking));
}

function textBlock(item, opts) {
  const streaming = Boolean(item.streaming);
  const text = item.text || "";
  return h("div", {
    className: item.role === "user" ? "harness-user-message" : "harness-text",
    "data-role": item.role || "assistant",
    "data-testid": "text-block",
    "data-item-id": item.id,
    "data-streaming": streaming ? "true" : "false",
  }, h("span", { className: "harness-text-content" }, text));
}

function thoughtBlock(item, opts) {
  const streaming = Boolean(item.streaming);
  const userOpen = opts.thoughtOpen ? Boolean(opts.thoughtOpen.get(item.id)) : null;
  // Desktop thought semantics (reasoning.tsx, defaultOpen=false): a thought is
  // collapsed by default, even while streaming. While streaming and collapsed
  // it shows a live latest-line summary; the user opens it to read the full
  // reasoning. When streaming ends the binding auto-collapses it again UNLESS
  // the user opened it themselves — see data-auto-collapse-key below.
  const open = userOpen != null ? userOpen : false;
  const text = item.text || "";
  const hasText = text.trim().length > 0;
  const label = thoughtLabel(item, opts);
  const summaryKids = [
    brainIcon("harness-thought-icon"),
    h("span", {
      className: streaming ? "harness-thought-label harness-thought-label-streaming" : "harness-thought-label",
      role: streaming ? "status" : undefined,
      "data-testid": "thought-label",
    }, label),
  ];
  // Collapsed streaming thought shows the latest non-empty line as a live,
  // horizontally-scrolling summary (matches the desktop reasoning trigger). The
  // binding pins the trailing edge and applies a fade mask when it overflows.
  if (!open && streaming && hasText) {
    summaryKids.push(h("span", {
      className: "harness-thought-preview",
      "data-testid": "thought-preview",
      "data-reasoning-streaming-line": "true",
      "data-line-key": latestSummaryLine(text).key,
      "data-line-text": latestSummaryLine(text).text,
      "data-reasoning-streaming-mask": "none",
      "aria-live": "polite",
    }, h("span", {
      className: "harness-thought-preview-text",
      "data-reasoning-streaming-text": "true",
    }, latestSummaryLine(text).text)));
  }
  // Disclosure chevron (hidden until hover when collapsed, rotated when open).
  summaryKids.push(chevronIcon("harness-thought-chevron"));
  const body = (open && hasText)
    ? [h("div", {
        className: "harness-thought-body",
        "data-testid": "thought-body",
        "data-streaming": streaming ? "true" : "false",
        "data-following": "true",
        "data-reasoning-scroll-mask": "none",
      }, text)]
    : [];
  return h("section", {
    className: "harness-thought",
    "data-testid": "thought-block",
    "data-item-id": item.id,
    "data-streaming": streaming ? "true" : "false",
    "data-auto-collapse-key": streaming ? `streaming:${item.id}` : `done:${item.id}`,
  }, h("details", {
    open,
    className: "harness-thought-details",
    "data-testid": "thought-details",
    "data-item-id": item.id,
    "aria-expanded": open,
  }, h("summary", { className: "harness-thought-summary", "data-testid": "thought-toggle" }, ...summaryKids), ...body));
}

function thoughtLabel(item, opts) {
  const l = opts.labels || {};
  if (item.streaming) return l.thinking || "Thinking…";
  // Host-supplied real duration only; never invented. No duration ⇒ bare label.
  if (item.duration != null) return `${l.thought || "Thought"} · ${item.duration}s`;
  return l.thought || "Thought";
}

function toolBlock(item, opts) {
  // Dispatch to the renderer registry (execute / read / edit / default). Each
  // renderer owns its summary, body, and host-action data attributes; this
  // function is now a thin seam so the view stays a single projection.
  return renderTool(item, opts);
}

function planDock(plan, opts) {
  const kids = [
    h("span", { className: "harness-plan-count", "data-testid": "plan-count" }, `${plan.completed}/${plan.total}`),
    h("span", { className: "harness-plan-label", "data-testid": "plan-label" }, opts.labels.plan || "Plan"),
  ];
  if (plan.inProgress) kids.push(h("span", {
    className: "harness-plan-current",
    "data-testid": "plan-current",
  }, truncateText(plan.inProgress.content || "", { maxLines: 1, maxChars: opts.summaryMaxChars })));
  return h("section", {
    className: "harness-plan-dock",
    "data-testid": "plan-dock",
    "aria-label": "Task plan",
  }, ...kids);
}

function statusLine(state, opts) {
  // A normal response ends at its content. Lifecycle and verification facts
  // remain available to the host without inserting a redundant transcript row.
  if (state.taskState === TaskState.Running || state.taskState === TaskState.Completed || state.taskState === TaskState.Unverified && state.verificationRequired !== true)
    return null;
  const label = taskStatusLabel(state, opts.labels);
  if (!label) return null;
  const terminal = isTerminal(state);
  const failed = state.taskState === TaskState.Failed;
  const role = failed ? "alert" : "status";
  const kids = [h("span", {
    className: "harness-status-label",
    "data-testid": "task-state",
    "data-state": state.taskState,
  }, label)];
  if (terminal && state.taskSummary) {
    kids.push(h("span", {
      className: "harness-status-summary",
      "data-testid": "task-summary",
    }, truncateText(state.taskSummary, { maxLines: 2, maxChars: opts.summaryMaxChars })));
  } else if (terminal && state.taskError) {
    kids.push(h("span", {
      className: "harness-status-error",
      role: "alert",
      "data-testid": "task-error",
    }, redactError(state.taskError)));
  }
  return h("div", {
    className: "harness-status-line",
    role,
    "data-testid": "status-line",
    "data-state": state.taskState,
  }, ...kids);
}

function jumpToLatest(opts) {
  return h("button", {
    type: "button",
    className: "harness-jump-latest",
    "data-testid": "jump-latest",
    "data-action": "jump-latest",
  }, opts.labels.jumpLatest || "Jump to latest");
}
