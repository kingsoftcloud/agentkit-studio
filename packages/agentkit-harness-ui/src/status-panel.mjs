/** A row is "ended" only when its status is an explicit terminal value; an
 *  absent or unknown value is kept current (never fabricated as ended). */
const ENDED_STATES = new Set([
  "done", "ended", "finished", "completed", "succeeded", "success",
  "cancelled", "canceled", "error", "failed", "stopped", "exited",
  "aborted", "terminated", "timed_out", "output_limit",
]);

export function isEndedStatus(value) {
  if (value == null) return false;
  return ENDED_STATES.has(String(value).trim().toLowerCase());
}

/** Split rows into current (running) and ended by the given status key. */
export function classifyRowsByStatus(rows, statusKey) {
  const current = [];
  const ended = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && isEndedStatus(row[statusKey])) ended.push(row);
    else current.push(row);
  }
  return { current, ended };
}

function isRunningRow(row, statusKey) {
  if (typeof row.isRunning === "boolean") return row.isRunning;
  return ["running", "active", "preparing_context", "requesting_model", "executing_tools", "compacting", "reviewing_delivery"].includes(row[statusKey]);
}

/** Normalise a plan item status to one of pending | in_progress | completed.
 *  Accepts both the source's camelCase ("inProgress") and the host contract's
 *  snake_case ("in_progress"); anything unknown falls back to pending, which
 *  is the source's behaviour for non-completed, non-in-progress items. */
export function planStatusKind(status) {
  if (status === "completed" || status === "complete") return "completed";
  if (status === "in_progress" || status === "inProgress" || status === "running")
    return "in_progress";
  return "pending";
}

function getCurrentPlanItem(plan) {
  const items = (plan && plan.items) || [];
  return (
    items.find((i) => planStatusKind(i && i.status) === "in_progress") ||
    items.find((i) => planStatusKind(i && i.status) === "pending") ||
    null
  );
}

function getCompletedPlanItem(plan) {
  const items = (plan && plan.items) || [];
  for (let i = items.length - 1; i >= 0; i--) {
    if (planStatusKind(items[i] && items[i].status) === "completed") return items[i];
  }
  return null;
}

function formatCount(singular, plural, count) {
  const tmpl = count === 1 ? singular : plural;
  return String(tmpl).replace("{count}", String(count));
}

/** Duration formatter, verbatim units logic from the source. */
export function formatDurationUnits(totalSeconds, labels) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}${labels.durationHours}`);
  if (minutes > 0) parts.push(`${minutes}${labels.durationMinutes}`);
  if (restSeconds > 0 || parts.length === 0) parts.push(`${restSeconds}${labels.durationSeconds}`);
  return parts.join(" ");
}

const COMPACT_TODO_THRESHOLD = 6;
const TODO_FOCUS_WINDOW_SIZE = 3;

/**
 * Plan focus window, verbatim from the source: lists of 6 or fewer render in
 * full; longer lists centre a 3-item focus window on the running (else first
 * unfinished, else last) item, with earlier/later rows folded into
 * keyboard-accessible hover/focus previews. Snapshot order is preserved.
 */
export function getStatusPanelTodoFocusWindow(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= COMPACT_TODO_THRESHOLD) {
    return { compact: false, precedingItems: [], focusItems: list, followingItems: [] };
  }
  const runningIndex = list.findIndex((i) => planStatusKind(i && i.status) === "in_progress");
  const firstUnfinishedIndex = list.findIndex((i) => planStatusKind(i && i.status) !== "completed");
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, list.length - TODO_FOCUS_WINDOW_SIZE);
  // Backfill from the front so the window keeps three rows near the list end.
  const focusStartIndex = Math.max(0, Math.min(focusIndex, list.length - TODO_FOCUS_WINDOW_SIZE));
  const focusEndIndex = Math.min(list.length, focusStartIndex + TODO_FOCUS_WINDOW_SIZE);
  return {
    compact: true,
    precedingItems: list.slice(0, focusStartIndex),
    focusItems: list.slice(focusStartIndex, focusEndIndex),
    followingItems: list.slice(focusEndIndex),
  };
}

/** Longest running elapsed across rows that carry a startedAt, in seconds
 *  floored to at least 1 (matches the source's collapsed trailing label). */
function longestElapsedSeconds(rows, now) {
  let max = 0;
  let has = false;
  for (const r of rows) {
    if (r && r.startedAt != null) {
      has = true;
      max = Math.max(max, Math.max(0, now - r.startedAt));
    }
  }
  return has ? Math.max(1, Math.floor(max / 1000)) : null;
}

/**
 * Mini-summary priority, reusing the source's branch order with the model
 * trimmed to what the host injects (no goal / session plans / workflows):
 *   current plan item → Git changes → completed plan item → running
 *   terminals/agents count → finished-child directory → isRunning fallback.
 * Returns a plain descriptor (icon is a name string) or null.
 */
export function resolveStatusPanelMiniSummary(model, labels) {
  const m = model || {};
  const currentPlanItem = getCurrentPlanItem(m.plan);
  if (currentPlanItem) {
    return { key: "currentPlan", icon: "arrowRight", text: currentPlanItem.content || "" };
  }
  const git = m.git;
  if (git && (git.added || 0) + (git.removed || 0) > 0) {
    return { key: "git", icon: "fileDiff", text: labels.changes, added: git.added || 0, removed: git.removed || 0 };
  }
  const completedPlanItem = getCompletedPlanItem(m.plan);
  if (completedPlanItem) {
    return { key: "completedPlan", icon: "checkCircle", text: completedPlanItem.content || "" };
  }
  const { current: runningTerminals } = classifyRowsByStatus(m.terminals, "state");
  const { current: runningAgents } = classifyRowsByStatus(m.agents, "phase");
  const runningCount = runningTerminals.filter(row => isRunningRow(row, "state")).length + runningAgents.filter(row => isRunningRow(row, "phase")).length;
  if (runningCount > 0) {
    const hasTerminals = runningTerminals.length > 0;
    const hasAgents = runningAgents.length > 0;
    const icon = hasTerminals && hasAgents ? "activity" : hasTerminals ? "squareTerminal" : "bot";
    const text = hasAgents
      ? formatCount(labels.agentsMiniValue, labels.agentsMiniValuePlural, runningCount)
      : formatCount(labels.terminalsMiniValue, labels.terminalsMiniValuePlural, runningCount);
    return { key: "runningCount", icon, text, count: runningCount };
  }
  if (runningTerminals.length + runningAgents.length > 0) return { key: "unconfirmed", icon: "activity", text: labels.unconfirmed };
  const { ended: endedTerminals } = classifyRowsByStatus(m.terminals, "state");
  const { ended: endedAgents } = classifyRowsByStatus(m.agents, "phase");
  const endedCount = endedTerminals.length + endedAgents.length;
  if (endedCount > 0) {
    return { key: "endedDirectory", icon: "checkCircle", text: labels.ended, count: endedCount };
  }
  if (m.isRunning) {
    return { key: "running", icon: null, runningDot: true, text: labels.running };
  }
  return null;
}

// ── Default labels (zh-CN, the authoritative locale) ──────────────────────

export const DEFAULT_LABELS = {
  title: "状态",
  environment: "Git 工具",
  changes: "更改",
  branch: "分支",
  commitPush: "提交 / 推送",
  clean: "干净",
  todo: "进程",
  terminals: "终端",
  agents: "智能体",
  ended: "已结束",
  endedAgents: "已结束的智能体",
  endedTerminals: "已结束的终端",
  running: "运行中",
  unconfirmed: "状态待确认",
  runningStop: "停止",
  showMini: "收起为胶囊",
  showPanel: "展开状态",
  displayMode: "状态面板展开策略",
  displayModeAuto: "自动展开",
  stopRunning: "停止运行中的后台任务",
  openSubagent: "打开子智能体会话",
  openTerminal: "查看 {title} 的输出",
  todoCompletedFold: "已完成 {count} 项",
  todoEarlierFold: "前面 {count} 项",
  todoLaterFold: "后面 {count} 项",
  todoWaitingFold: "待处理 {count} 项",
  terminalsOpenValue: "{count} 个后台运行",
  terminalsOpenValuePlural: "{count} 个后台运行",
  terminalsMiniValue: "{count} 后台",
  terminalsMiniValuePlural: "{count} 后台",
  agentsOpenValue: "{count} 运行",
  agentsOpenValuePlural: "{count} 运行",
  agentsMiniValue: "{count} 运行",
  agentsMiniValuePlural: "{count} 运行",
  durationHours: "小时",
  durationMinutes: "分",
  durationSeconds: "秒",
};

// ── Inline Lucide icon geometry (viewBox 0 0 24 24, stroke currentColor) ──

const ICONS = {
  arrowRight: [["path", { d: "M5 12h14" }], ["path", { d: "m12 5 7 7-7 7" }]],
  bot: [
    ["path", { d: "M12 8V4H8" }],
    ["rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }],
  ],
  checkCircle: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "m9 12 2 2 4-4" }]],
  chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
  chevronLeft: [["path", { d: "m15 18-6-6 6-6" }]],
  chevronRight: [["path", { d: "m9 18 6-6-6-6" }]],
  circle: [["circle", { cx: 12, cy: 12, r: 10 }]],
  ellipsis: [
    ["circle", { cx: 5, cy: 12, r: 1 }],
    ["circle", { cx: 12, cy: 12, r: 1 }],
    ["circle", { cx: 19, cy: 12, r: 1 }],
  ],
  fileDiff: [
    ["path", { d: "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" }],
    ["path", { d: "M12 13H8" }],
    ["path", { d: "M8 17h4" }],
    ["path", { d: "M16 11h-4" }],
    ["path", { d: "M16 15h-4" }],
  ],
  gitBranch: [
    ["line", { x1: 6, x2: 6, y1: 3, y2: 15 }],
    ["circle", { cx: 18, cy: 6, r: 3 }],
    ["circle", { cx: 6, cy: 18, r: 3 }],
    ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
  ],
  gitCommit: [
    ["circle", { cx: 12, cy: 12, r: 3 }],
    ["line", { x1: 3, x2: 9, y1: 12, y2: 12 }],
    ["line", { x1: 15, x2: 21, y1: 12, y2: 12 }],
  ],
  listChecks: [
    ["path", { d: "m3 17 2 2 4-4" }],
    ["path", { d: "m3 7 2 2 4-4" }],
    ["path", { d: "M13 6h8" }],
    ["path", { d: "M13 12h8" }],
    ["path", { d: "M13 18h8" }],
  ],
  maximize2: [
    ["path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }],
    ["path", { d: "M21 8V5a2 2 0 0 0-2-2h-3" }],
    ["path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }],
    ["path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" }],
  ],
  minimize2: [
    ["path", { d: "M8 3v3a2 2 0 0 1-2 2H3" }],
    ["path", { d: "M21 8h-3a2 2 0 0 1-2-2V3" }],
    ["path", { d: "M3 16h3a2 2 0 0 1 2 2v3" }],
    ["path", { d: "M16 21v-3a2 2 0 0 1 2-2h3" }],
  ],
  square: [["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }]],
  squareTerminal: [
    ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }],
    ["path", { d: "m7 11 2-2-2-2" }],
    ["path", { d: "M11 13h4" }],
  ],
  activity: [["path", { d: "M22 12h-4l-3 9L9 3l-3 9H2" }]],
};

// ── Scoped CSS ─────────────────────────────────────────────────────────────

export const statusPanelStyles = `
.harness-status-panel-root{
  position:absolute; top:0; left:0; right:0; z-index:20;
  display:flex; justify-content:flex-end;
  padding:1rem 1rem 0 0;
  pointer-events:none;
  container-type:inline-size; container-name:harness-status-panel;
  --sp-fg: var(--harness-fg, currentColor);
  --sp-fg-subtle: color-mix(in srgb, var(--sp-fg) 60%, transparent);
  --sp-fg-subtlest: color-mix(in srgb, var(--sp-fg) 40%, transparent);
  --sp-bg: var(--harness-bg, var(--color-popover, #ffffff));
  --sp-border: color-mix(in srgb, var(--sp-fg) 16%, transparent);
  --sp-hover: color-mix(in srgb, var(--sp-fg) 8%, transparent);
  --sp-focus: var(--sp-fg);
  --sp-added: var(--harness-added, #1a7f37);
  --sp-removed: var(--harness-removed, #cf222e);
  --sp-success: var(--harness-added, #1a7f37);
  --sp-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--sp-fg);
}
@media (prefers-color-scheme: dark){
  .harness-status-panel-root{
    --sp-bg: var(--harness-bg, var(--color-popover, #1c1c1e));
    --sp-added: var(--harness-added, #4ac26b);
    --sp-removed: var(--harness-removed, #ff7b72);
    --sp-success: var(--harness-added, #4ac26b);
  }
}
.harness-status-panel-root[data-theme="light"]{
  --sp-bg: var(--harness-bg, var(--color-popover, #ffffff));
  --sp-added:#1a7f37; --sp-removed:#cf222e; --sp-success:#1a7f37;
}
.harness-status-panel-root[data-theme="dark"]{
  --sp-bg: var(--harness-bg, var(--color-popover, #1c1c1e));
  --sp-added: var(--harness-added, #4ac26b);
  --sp-removed: var(--harness-removed, #ff7b72);
  --sp-success: var(--harness-added, #4ac26b);
}
.harness-status-panel{
  position:relative; pointer-events:auto;
  border-radius:1rem; border:1px solid var(--sp-border);
  background:var(--sp-bg); color:var(--sp-fg);
  box-shadow:0 4px 12px rgba(0,0,0,.08);
  font-family:inherit; font-size:inherit; line-height:1.4;
  overflow:visible;
  transition:border-radius .3s ease, padding .3s ease, background-color .3s ease, box-shadow .3s ease;
}
.harness-status-panel-root svg{ width:1em; height:1em; flex:none; stroke:currentColor; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.harness-status-panel[data-display-mode="auto"],
.harness-status-panel[data-display-mode="mini"]{
  display:inline-flex; flex-direction:column;
  max-height:2.125rem; width:max-content; max-width:min(20rem, calc(100cqw - 2rem));
}
.harness-status-panel[data-display-mode="panel"]{
  display:flex; flex-direction:column;
  max-height:min(64dvh, 32rem); width:20rem; max-width:calc(100cqw - 2rem);
}
@container harness-status-panel (min-width: 1280px){
  .harness-status-panel[data-display-mode="auto"]{
    display:flex; flex-direction:column;
    max-height:min(64dvh, 32rem); width:20rem; max-width:calc(100cqw - 2rem);
  }
  .harness-status-panel[data-display-mode="auto"] .harness-status-panel__sections{ display:flex; }
  .harness-status-panel[data-display-mode="auto"] .harness-status-panel__controls{ display:flex; }
  .harness-status-panel[data-display-mode="auto"] .harness-status-panel__mini{ display:none; }
}
.harness-status-panel__controls{
  display:none; position:absolute; right:0.75rem; top:0.75rem; z-index:10;
  align-items:center; gap:0.25rem;
}
.harness-status-panel[data-display-mode="panel"] .harness-status-panel__controls{ display:flex; }
.harness-status-panel__ctrl{
  display:inline-flex; align-items:center; justify-content:center;
  width:1.5rem; height:1.5rem; padding:0; border:0; border-radius:0.375rem;
  background:transparent; color:var(--sp-fg-subtle); cursor:pointer; font:inherit;
}
.harness-status-panel__ctrl:hover{ background:var(--sp-hover); color:var(--sp-fg); }
.harness-status-panel__ctrl:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:1px; }
.harness-status-panel__sections{
  display:none; flex-direction:column; gap:0.5rem;
  min-height:0; flex:1 1 auto; overflow-x:hidden; overflow-y:auto; padding:0.5rem;
}
.harness-status-panel[data-display-mode="panel"] .harness-status-panel__sections{ display:flex; }
.harness-status-panel__mini{ display:block; }
.harness-status-panel[data-display-mode="panel"] .harness-status-panel__mini{ display:none; }
.harness-status-panel__section{ min-width:0; flex:none; }
.harness-status-panel__section--separated{ border-top:1px solid var(--sp-border); padding-top:0.5rem; }
.harness-status-panel__section-header{ display:flex; align-items:center; gap:0.375rem; min-height:2rem; padding:0 0.5rem 0 0.5rem; padding-right:2rem; }
.harness-status-panel__section-trigger{
  display:flex; align-items:center; gap:0.25rem; min-width:0; flex:none;
  background:transparent; border:0; padding:0; text-align:left; cursor:pointer;
  color:var(--sp-fg-subtle); font:inherit;
}
.harness-status-panel__section-trigger:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:1px; border-radius:0.25rem; }
.harness-status-panel__section-title{ font-size:0.875em; color:var(--sp-fg-subtle); }
.harness-status-panel__chevron{ width:0.875em; height:0.875em; color:var(--sp-fg-subtle); opacity:0; transition:opacity .15s; }
.harness-status-panel__section-header:hover .harness-status-panel__chevron,
.harness-status-panel__section-trigger:focus-visible .harness-status-panel__chevron{ opacity:1; }
.harness-status-panel__section-trailing{ display:inline-flex; align-items:center; gap:0.375rem; min-width:0; max-width:100%; font-size:0.75em; color:var(--sp-fg-subtlest); }
.harness-status-panel__section-content{ min-width:0; }
.harness-status-panel__section[data-status-section="plan"] .harness-status-panel__section-content{ max-height:20rem; overflow-y:auto; }
.harness-status-panel__section[data-status-section="terminals"] .harness-status-panel__section-content,
.harness-status-panel__section[data-status-section="agents"] .harness-status-panel__section-content{ max-height:12rem; overflow-y:auto; }
.harness-status-panel__row,.harness-status-panel__ended-row{
  position:relative; display:flex; align-items:flex-start; gap:0.5rem;
  padding:0.5rem; border-radius:0.5rem; min-height:2rem;
}
.harness-status-panel__row:hover,.harness-status-panel__ended-row:hover{ background:var(--sp-hover); }
.harness-status-panel__row-open{ position:absolute; inset:0; border:0; background:transparent; border-radius:0.5rem; cursor:pointer; z-index:0; }
.harness-status-panel__row-open:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:-1px; }
.harness-status-panel__row-icon{ width:1em; height:1em; color:var(--sp-fg-subtle); position:relative; z-index:1; pointer-events:none; margin-top:0.125em; }
.harness-status-panel__row-body{ position:relative; z-index:1; pointer-events:none; flex:1; min-width:0; display:flex; flex-direction:column; gap:0.25rem; }
.harness-status-panel__row-title{ margin:0; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; line-height:1.25; }
.harness-status-panel__row-meta{ display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem; font-size:0.85em; }
.harness-status-panel__elapsed{ color:var(--sp-fg-subtle); font-variant-numeric:tabular-nums; font-family:var(--sp-mono); }
.harness-status-panel__row-role{ color:var(--sp-fg-subtlest); font-size:0.85em; }
.harness-status-panel__stop{
  position:relative; z-index:2; pointer-events:auto;
  display:inline-flex; align-items:center; gap:0.25rem;
  height:1.5rem; padding:0 0.375rem; margin-left:auto;
  border:0; border-radius:0.25rem; background:transparent; color:var(--sp-fg); font:inherit; font-size:0.85em; cursor:pointer;
}
.harness-status-panel__stop:hover{ background:var(--sp-hover); }
.harness-status-panel__stop:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:1px; }
.harness-status-panel__stop-icon{ width:0.75em; height:0.75em; fill:currentColor; stroke:none; }
.harness-status-panel__action{
  display:flex; align-items:center; gap:0.5rem; width:100%; min-width:0;
  height:2rem; padding:0 0.5rem; border:0; border-radius:0.5rem;
  background:transparent; color:var(--sp-fg); text-align:left; font:inherit; cursor:pointer;
}
.harness-status-panel__action:hover{ background:var(--sp-hover); }
.harness-status-panel__action:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:-1px; }
.harness-status-panel__action-static{ display:flex; align-items:center; gap:0.5rem; height:2rem; padding:0 0.5rem; opacity:.85; }
.harness-status-panel__action-label{ flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.harness-status-panel__git-delta{ display:inline-flex; gap:0.25rem; font-family:var(--sp-mono); font-variant-numeric:tabular-nums; font-size:0.85em; }
.harness-status-panel__added{ color:var(--sp-added); }
.harness-status-panel__removed{ color:var(--sp-removed); }
.harness-status-panel__git-dirty{ color:var(--sp-fg-subtle); font-size:0.85em; }
.harness-status-panel__action-icon{ width:1em; height:1em; color:var(--sp-fg); flex:none; }
.harness-status-panel__plan-list{ list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
.harness-status-panel__plan-item{ display:flex; align-items:flex-start; gap:0.5rem; padding:0.375rem 0.5rem; border-radius:0.5rem; min-height:2rem; }
.harness-status-panel__plan-item:hover{ background:var(--sp-hover); }
.harness-status-panel__plan-icon{ width:0.875em; height:0.875em; margin-top:0.125em; flex:none; }
.harness-status-panel__plan-icon--done{ color:var(--sp-success); }
.harness-status-panel__plan-icon--active{ color:var(--sp-fg); }
.harness-status-panel__plan-icon--pending{ color:var(--sp-fg-subtlest); }
.harness-status-panel__plan-content{ flex:1; min-width:0; line-height:1.25; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.harness-status-panel__plan-content--done{ color:var(--sp-fg-subtlest); text-decoration:line-through; }
.harness-status-panel__plan-count{ font-variant-numeric:tabular-nums; }
.harness-status-panel__plan-count--done{ color:var(--sp-success); }
.harness-status-panel__fold{ position:relative; }
.harness-status-panel__fold-trigger{
  display:flex; align-items:center; gap:0.5rem; width:100%; min-height:2rem; padding:0 0.5rem;
  border:0; border-radius:0.5rem; background:transparent; color:var(--sp-fg-subtle); text-align:left; font:inherit; cursor:pointer;
}
.harness-status-panel__fold-trigger:hover,.harness-status-panel__fold-trigger:focus-visible{ background:var(--sp-hover); }
.harness-status-panel__fold-trigger:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:-1px; }
.harness-status-panel__fold-trigger .harness-status-panel__fold-chevron{ width:0.875em; height:0.875em; }
.harness-status-panel__fold-preview{
  display:none; position:absolute; left:0; bottom:100%; z-index:20;
  width:20rem; max-width:min(20rem, calc(100cqw - 2rem));
  border:1px solid var(--sp-border); border-radius:0.75rem; background:var(--sp-bg);
  box-shadow:0 4px 12px rgba(0,0,0,.12); padding:0.75rem;
}
.harness-status-panel__fold:hover .harness-status-panel__fold-preview,
.harness-status-panel__fold:focus-within .harness-status-panel__fold-preview{ display:block; }
.harness-status-panel__fold-preview-header{ display:flex; align-items:center; min-height:2rem; padding:0 0.5rem; color:var(--sp-fg-subtle); font-size:0.875em; }
.harness-status-panel__ended--separated{ border-top:1px solid var(--sp-border); margin-top:0.5rem; padding-top:0.5rem; }
.harness-status-panel__ended-header{ display:flex; align-items:center; gap:0.5rem; min-height:2rem; padding:0 0.5rem; color:var(--sp-fg); }
.harness-status-panel__ended-icon{ width:1em; height:1em; color:var(--sp-fg-subtle); }
.harness-status-panel__ended-count{ margin-left:auto; color:var(--sp-fg-subtle); }
.harness-status-panel__ended-row > span,.harness-status-panel__ended-row > svg{ pointer-events:none; }
.harness-status-panel__ended-chevron{ width:0.875em; height:0.875em; color:var(--sp-fg-subtle); }
.harness-status-panel__mini-trigger{
  display:inline-flex; flex-direction:column; align-items:stretch; width:max-content; max-width:100%;
  background:transparent; border:0; padding:0; text-align:left; cursor:pointer; color:var(--sp-fg); font:inherit;
}
.harness-status-panel__mini-trigger:hover{ background:var(--sp-hover); border-radius:1rem; }
.harness-status-panel__mini-trigger:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:1px; border-radius:1rem; }
.harness-status-panel__mini-metric{ display:flex; align-items:center; gap:0.375rem; min-width:0; max-width:100%; height:2rem; padding:0 0.75rem 0 0.5rem; font-size:0.875em; }
.harness-status-panel__mini-icon{ position:relative; width:1em; height:1em; flex:none; }
.harness-status-panel__mini-icon svg{ position:absolute; inset:0; transition:opacity .15s; }
.harness-status-panel__mini-icon-hover{ opacity:0; }
.harness-status-panel__mini-trigger:hover .harness-status-panel__mini-icon-base,
.harness-status-panel__mini-trigger:focus-visible .harness-status-panel__mini-icon-base{ opacity:0; }
.harness-status-panel__mini-trigger:hover .harness-status-panel__mini-icon-hover,
.harness-status-panel__mini-trigger:focus-visible .harness-status-panel__mini-icon-hover{ opacity:1; }
.harness-status-panel__mini-text{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.harness-status-panel__mini-count{ color:var(--sp-fg-subtlest); flex:none; }
.harness-status-panel__running-dot{ width:0.375em; height:0.375em; border-radius:9999px; background:var(--sp-success); flex:none; animation:harness-status-panel-pulse 1.5s ease-in-out infinite; }
@keyframes harness-status-panel-pulse{ 50%{ opacity:.4; } }
@media (prefers-reduced-motion: reduce){ .harness-status-panel__running-dot{ animation:none; } }
.harness-status-panel__menu{ position:relative; }
.harness-status-panel__menu-popover{
  position:absolute; right:0; top:calc(100% + 4px); z-index:30;
  min-width:11rem; border:1px solid var(--sp-border); border-radius:0.75rem; background:var(--sp-bg);
  box-shadow:0 4px 12px rgba(0,0,0,.12); padding:0.25rem;
}
.harness-status-panel__menu-item{
  display:flex; align-items:center; width:100%; min-height:2rem; padding:0 0.5rem;
  border:0; border-radius:0.375rem; background:transparent; color:var(--sp-fg); text-align:left; font:inherit; cursor:pointer;
}
.harness-status-panel__menu-item:hover{ background:var(--sp-hover); }
.harness-status-panel__menu-item:focus-visible{ outline:2px solid var(--sp-focus); outline-offset:-1px; }
`;

// ── Factory ────────────────────────────────────────────────────────────────

export function createStatusPanelComponents(React, ReactDOM = {}) {
  const h = React.createElement;
  const { useState, useEffect, useCallback, useRef, memo } = React;

  function Icon(name, extraProps) {
    const paths = ICONS[name];
    if (!paths) return null;
    const props = {
      viewBox: "0 0 24 24",
      "aria-hidden": true,
      ...(extraProps || {}),
    };
    return h("svg", props, paths.map(([t, p], i) => h(t, { key: i, ...p })));
  }

  function StopButton({ workId, onCancel, labels }) {
    return h(
      "button",
      {
        type: "button",
        className: "harness-status-panel__stop",
        "data-row-cancel": workId,
        "aria-label": labels.stopRunning,
        onClick: (event) => {
          event.stopPropagation();
          onCancel(workId);
        },
      },
      Icon("square", { className: "harness-status-panel__stop-icon" }),
      h("span", null, labels.runningStop),
    );
  }

  function Row({ row, kind, now, openCallback, onCancel, labels }) {
    const title = row.title || row.id || row.runId || "";
    const elapsed =
      row.startedAt != null
        ? formatDurationUnits(Math.floor((now - row.startedAt) / 1000), labels)
        : null;
    const canCancel = row.canCancel === true && typeof onCancel === "function";
    const openable = typeof openCallback === "function";
    const iconName = kind === "terminal" ? "squareTerminal" : "bot";
    const statusKey = kind === "terminal" ? "state" : "phase";
    return h(
      "li",
      {
        className: "harness-status-panel__row",
        "data-row-kind": kind,
        "data-row-state": row[statusKey],
        "data-row-id": row.id || row.runId,
        "data-can-cancel": canCancel ? "true" : "false",
      },
      openable
        ? h("button", {
            type: "button",
            className: "harness-status-panel__row-open",
            "data-row-open": kind,
            "aria-label": (kind === "terminal" ? labels.openTerminal : labels.openSubagent + "：{title}").replace(
              "{title}",
              title,
            ),
            onClick: (event) => {
              event.stopPropagation();
              openCallback(row);
            },
          })
        : null,
      Icon(iconName, { className: "harness-status-panel__row-icon" }),
      h(
        "div",
        { className: "harness-status-panel__row-body" },
        h("p", { className: "harness-status-panel__row-title" }, title),
        h(
          "div",
          { className: "harness-status-panel__row-meta" },
          kind === "agent" && row.role
            ? h("span", { className: "harness-status-panel__row-role" }, row.role)
            : null,
          elapsed ? h("span", { className: "harness-status-panel__elapsed" }, elapsed) : null,
          canCancel ? h(StopButton, { workId: row.id || row.runId, onCancel, labels }) : null,
        ),
      ),
    );
  }

  function EndedDirectory({ ended, kind, openCallback, openDirectory, labels }) {
    if (ended.length === 0) return null;
    const iconName = kind === "terminal" ? "squareTerminal" : "bot";
    const statusKey = kind === "terminal" ? "state" : "phase";
    if (typeof openDirectory === "function") return h("div", { className: "harness-status-panel__ended harness-status-panel__ended--separated" },
      h("button", { type: "button", className: "harness-status-panel__action", onClick: () => openDirectory(), "data-ended-directory": kind },
        Icon("checkCircle"), h("span", { className: "harness-status-panel__action-label" }, kind === "agent" ? labels.endedAgents : labels.endedTerminals),
        h("span", null, String(ended.length)), Icon("chevronRight")));
    return h(
      "div",
      {
        className: "harness-status-panel__ended harness-status-panel__ended--separated",
        "data-ended-kind": kind,
      },
      h(
        "div",
        { className: "harness-status-panel__ended-header" },
        Icon("checkCircle", { className: "harness-status-panel__ended-icon" }),
        h("span", null, labels.ended),
        h("span", { className: "harness-status-panel__ended-count" }, String(ended.length)),
      ),
      h(
        "ul",
        { style: { listStyle: "none", margin: 0, padding: 0 } },
        ended.map((row) =>
          h(
            "li",
            {
              key: row.id || row.runId,
              className: "harness-status-panel__ended-row",
              "data-row-kind": kind,
              "data-row-state": row[statusKey],
              "data-row-ended": "true",
            },
            typeof openCallback === "function"
              ? h("button", {
                  type: "button",
                  className: "harness-status-panel__row-open",
                  "data-row-open": kind,
                  "aria-label": (kind === "terminal" ? labels.openTerminal : labels.openSubagent + "：{title}").replace(
                    "{title}",
                    row.title || row.id || row.runId || "",
                  ),
                  onClick: (event) => {
                    event.stopPropagation();
                    openCallback(row);
                  },
                })
              : null,
            Icon(iconName, { className: "harness-status-panel__row-icon" }),
            h("span", { className: "harness-status-panel__row-title" }, row.title || row.id || row.runId || ""),
            Icon("chevronRight", { className: "harness-status-panel__ended-chevron" }),
          ),
        ),
      ),
    );
  }

  function Section({ section, title, separated, open, defaultOpen = true, onOpenChange, trailing, children, footer }) {
    const [uncontrolled, setUncontrolled] = useState(defaultOpen);
    const isControlled = open !== undefined && open !== null;
    const isOpen = isControlled ? open : uncontrolled;
    const toggle = () => {
      const next = !isOpen;
      if (!isControlled) setUncontrolled(next);
      if (typeof onOpenChange === "function") onOpenChange(next);
    };
    return h(
      "div",
      {
        className: `harness-status-panel__section${separated ? " harness-status-panel__section--separated" : ""}`,
        "data-status-section": section,
        "data-state": isOpen ? "open" : "closed",
      },
      h(
        "div",
        { className: "harness-status-panel__section-header" },
        h(
          "button",
          {
            type: "button",
            className: "harness-status-panel__section-trigger",
            "aria-expanded": isOpen,
            "data-status-section-trigger": section,
            onClick: toggle,
          },
          h("span", { className: "harness-status-panel__section-title" }, title),
          Icon(isOpen ? "chevronDown" : "chevronRight", { className: "harness-status-panel__chevron" }),
        ),
        trailing ? h("div", { className: "harness-status-panel__section-trailing" }, trailing(isOpen)) : null,
      ),
      isOpen ? h("div", { className: "harness-status-panel__section-content" }, children, footer) : null,
    );
  }

  function gitDeltaSpan(git) {
    return h(
      "span",
      { className: "harness-status-panel__git-delta" },
      h("span", { className: "harness-status-panel__added" }, `+${git.added || 0}`),
      " ",
      h("span", { className: "harness-status-panel__removed" }, `-${git.removed || 0}`),
    );
  }

  function GitSection({ git, onOpenGitReview, onGitBranch, onGitCommitPush, labels, separated }) {
    const hasChanges = (git.added || 0) + (git.removed || 0) > 0;
    const reviewRow = onOpenGitReview
      ? h(
          "button",
          {
            type: "button",
            className: "harness-status-panel__action",
            "data-git-action": "review",
            onClick: () => onOpenGitReview(),
          },
          Icon("fileDiff", { className: "harness-status-panel__action-icon" }),
          h("span", { className: "harness-status-panel__action-label" }, labels.changes),
          gitDeltaSpan(git),
        )
      : h(
          "div",
          { className: "harness-status-panel__action-static", "data-git-action": "review" },
          Icon("fileDiff", { className: "harness-status-panel__action-icon" }),
          h("span", { className: "harness-status-panel__action-label" }, labels.changes),
          gitDeltaSpan(git),
        );
    const branchRow = (git.branchName || onGitBranch) &&
      (onGitBranch
        ? h(
            "button",
            {
              type: "button",
              className: "harness-status-panel__action",
              "data-git-action": "branch",
              onClick: () => onGitBranch(),
            },
            Icon("gitBranch", { className: "harness-status-panel__action-icon" }),
            h("span", { className: "harness-status-panel__action-label" }, git.branchName || labels.branch),
            git.dirtyFileCount ? h("span", { className: "harness-status-panel__git-dirty" }, `· ${git.dirtyFileCount}`) : null,
          )
        : h(
            "div",
            { className: "harness-status-panel__action-static", "data-git-action": "branch" },
            Icon("gitBranch", { className: "harness-status-panel__action-icon" }),
            h("span", { className: "harness-status-panel__action-label" }, git.branchName || labels.branch),
            git.dirtyFileCount ? h("span", { className: "harness-status-panel__git-dirty" }, `· ${git.dirtyFileCount}`) : null,
          ));
    const commitRow = onGitCommitPush
      ? h(
          "button",
          {
            type: "button",
            className: "harness-status-panel__action",
            "data-git-action": "commit-push",
            onClick: () => onGitCommitPush(),
          },
          Icon("gitCommit", { className: "harness-status-panel__action-icon" }),
          h("span", { className: "harness-status-panel__action-label" }, labels.commitPush),
        )
      : null;
    return h(
      Section,
      {
        section: "environment",
        title: labels.environment,
        separated,
        trailing: (isOpen) =>
          isOpen
            ? null
            : h(
                "span",
                { className: "harness-status-panel__git-delta" },
                h("span", { className: "harness-status-panel__added", style: !hasChanges ? { opacity: 0.5 } : null }, `+${git.added || 0}`),
                " ",
                h("span", { className: "harness-status-panel__removed", style: !hasChanges ? { opacity: 0.5 } : null }, `-${git.removed || 0}`),
              ),
      },
      h("div", null, reviewRow, branchRow, commitRow),
    );
  }

  function PlanRow({ item }) {
    const kind = planStatusKind(item.status);
    const iconName = kind === "completed" ? "checkCircle" : kind === "in_progress" ? "arrowRight" : "circle";
    const iconClass = `harness-status-panel__plan-icon harness-status-panel__plan-icon--${kind === "completed" ? "done" : kind === "in_progress" ? "active" : "pending"}`;
    return h(
      "li",
      {
        className: "harness-status-panel__plan-item",
        "data-plan-status": kind,
        "data-plan-id": item.id,
      },
      Icon(iconName, { className: iconClass }),
      h(
        "span",
        {
          title: item.content || "",
          className: `harness-status-panel__plan-content${kind === "completed" ? " harness-status-panel__plan-content--done" : ""}`,
        },
        item.content || "",
      ),
    );
  }

  function FoldPreview({ group, items, labels }) {
    const allCompleted = items.every(i => planStatusKind(i?.status) === "completed");
    const allPending = items.every(i => planStatusKind(i?.status) === "pending");
    const template = group === "preceding" ? allCompleted ? labels.todoCompletedFold : labels.todoEarlierFold
      : allPending ? labels.todoWaitingFold : labels.todoLaterFold;
    const text = String(template).replace("{count}", String(items.length));
    const ref = useRef(null), previewRef = useRef(null), closeTimer = useRef(null);
    const [position, setPosition] = useState(null);
    const close = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setPosition(null), 120); };
    const show = () => {
      clearTimeout(closeTimer.current);
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect(), doc = node.ownerDocument.documentElement;
      const width = Math.min(320, doc.clientWidth - 32), height = Math.min(320, doc.clientHeight - 32);
      const above = rect.top >= height + 8;
      setPosition({ left: Math.max(16, Math.min(rect.left, doc.clientWidth - width - 16)),
        top: above ? Math.max(16, rect.top - height - 8) : Math.min(rect.bottom + 8, doc.clientHeight - height - 16), width, maxHeight: height });
    };
    useEffect(() => () => clearTimeout(closeTimer.current), []);
    const preview = h("div", { ref: previewRef, role: "tooltip", className: "harness-status-panel__fold-preview",
      "data-fold-preview": group,
      style: position && ReactDOM.createPortal ? { ...position, position: "fixed", display: "block", overflowY: "auto", pointerEvents: "auto" } : undefined,
      onMouseEnter: () => clearTimeout(closeTimer.current), onMouseLeave: close },
      h("div", { className: "harness-status-panel__fold-preview-header" }, text),
      h("ul", { className: "harness-status-panel__plan-list" }, items.map(i => h(PlanRow, { key: i.id, item: i }))));
    const root = ref.current?.closest(".harness-status-panel-root");
    return h("div", { ref, className: "harness-status-panel__fold", "data-fold-group": group,
      onMouseEnter: show, onMouseLeave: close, onFocus: show,
      onBlur: event => { if (!ref.current?.contains(event.relatedTarget) && !previewRef.current?.contains(event.relatedTarget)) close(); },
      onKeyDown: event => { if (event.key === "Escape") { clearTimeout(closeTimer.current); setPosition(null); } } },
      h("button", { type: "button", className: "harness-status-panel__fold-trigger", "aria-expanded": !!position,
        "data-fold-trigger": group, onClick: () => position ? setPosition(null) : show() },
        Icon("chevronLeft", { className: "harness-status-panel__fold-chevron" }), h("span", null, text)),
      root && ReactDOM.createPortal ? position && ReactDOM.createPortal(preview, root) : preview);
  }

  function PlanItems({ items, labels }) {
    const win = getStatusPanelTodoFocusWindow(items);
    return h(
      "ul",
      { className: "harness-status-panel__plan-list" },
      win.compact && win.precedingItems.length > 0
        ? h("li", { key: "preceding" }, h(FoldPreview, { group: "preceding", items: win.precedingItems, labels }))
        : null,
      win.focusItems.map((item) => h(PlanRow, { key: item.id, item })),
      win.compact && win.followingItems.length > 0
        ? h("li", { key: "following" }, h(FoldPreview, { group: "following", items: win.followingItems, labels }))
        : null,
    );
  }

  function PlanSection({ plan, labels, separated }) {
    const items = (plan && plan.items) || [];
    const completedCount =
      plan.completedCount != null
        ? plan.completedCount
        : items.filter((i) => planStatusKind(i && i.status) === "completed").length;
    const totalCount = plan.totalCount != null ? plan.totalCount : items.length;
    const isCompleted = totalCount > 0 && completedCount >= totalCount;
    return h(
      Section,
      {
        section: "plan",
        title: labels.todo,
        separated,
        trailing: () =>
          h(
            "span",
            {
              className: `harness-status-panel__plan-count${isCompleted ? " harness-status-panel__plan-count--done" : ""}`,
              "data-plan-complete": isCompleted ? "true" : "false",
            },
            `${completedCount}/${totalCount}`,
          ),
      },
      h(PlanItems, { items, labels }),
    );
  }

  function LiveSection({ section, title, kind, rows, ended, now, openCallback, openDirectory, onCancel, labels, separated, open, onOpenChange, openValue, openValuePlural, miniValue, miniValuePlural }) {
    const ordered = [...rows].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    const active = rows.filter(row => isRunningRow(row, kind === "terminal" ? "state" : "phase"));
    const elapsed = longestElapsedSeconds(active, now);
    return h(
      Section,
      {
        section,
        title,
        separated,
        defaultOpen: false,
        open,
        onOpenChange,
        trailing: (isOpen) =>
          rows.length === 0 ? null : active.length === 0 ? h("span", null, labels.unconfirmed) : isOpen
            ? h("span", null, formatCount(openValue, openValuePlural, active.length))
            : [
                elapsed ? h("span", { key: "el", className: "harness-status-panel__elapsed" }, formatDurationUnits(elapsed, labels)) : null,
                elapsed ? h("span", { key: "sep" }, "·") : null,
                h("span", { key: "cnt" }, formatCount(miniValue, miniValuePlural, active.length)),
              ],
        footer: h(EndedDirectory, { ended, kind, openCallback, openDirectory, labels }),
      },
      h(
        "ul",
        { style: { listStyle: "none", margin: 0, padding: 0 } },
        ordered.map((row) =>
          h(Row, {
            key: row.id || row.runId,
            row,
            kind,
            now,
            openCallback,
            onCancel,
            labels,
          }),
        ),
      ),
    );
  }

  function StatusSummaryRow({ model, labels, onExpand }) {
    const summary = resolveStatusPanelMiniSummary(model, labels);
    if (!summary) return null;
    return h(
      "button",
      {
        type: "button",
        className: "harness-status-panel__mini-trigger",
        "aria-label": labels.showPanel,
        "data-mini-summary": summary.key,
        onClick: onExpand,
      },
      h(
        "span",
        { className: "harness-status-panel__mini-metric" },
        summary.runningDot
          ? h("span", { className: "harness-status-panel__running-dot", "aria-hidden": true })
          : h(
              "span",
              { className: "harness-status-panel__mini-icon" },
              Icon(summary.icon, { className: "harness-status-panel__mini-icon-base" }),
              Icon("maximize2", { className: "harness-status-panel__mini-icon-hover" }),
            ),
        h("span", { className: "harness-status-panel__mini-text" }, summary.text),
        summary.key === "git"
          ? h(
              "span",
              { className: "harness-status-panel__git-delta" },
              h("span", { className: "harness-status-panel__added" }, `+${summary.added}`),
              " ",
              h("span", { className: "harness-status-panel__removed" }, `-${summary.removed}`),
            )
          : null,
        summary.key === "endedDirectory"
          ? h("span", { className: "harness-status-panel__mini-count" }, String(summary.count))
          : null,
      ),
    );
  }

  function MenuButton({ label, autoLabel, onAuto, variant }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
      if (!open) return;
      const handler = (event) => {
        if (ref.current && event.target && !ref.current.contains(event.target)) setOpen(false);
      };
      if (typeof document !== "undefined") {
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
      }
    }, [open]);
    return h(
      "div",
      { className: "harness-status-panel__menu", ref },
      h(
        "button",
        {
          type: "button",
          className: "harness-status-panel__ctrl",
          "aria-label": label,
          "aria-expanded": open,
          "aria-haspopup": "menu",
          onKeyDown: event => { if (event.key === "Escape") { setOpen(false); event.currentTarget.focus(); } },
          "data-display-mode-menu": "true",
          onClick: () => setOpen(!open),
        },
        Icon("ellipsis"),
      ),
      open
        ? h(
            "div",
            { className: "harness-status-panel__menu-popover", role: "menu", onKeyDown: event => { if (event.key === "Escape") { setOpen(false); ref.current?.querySelector("button")?.focus(); } } },
            h(
              "button",
              {
                type: "button",
                role: "menuitemradio",
                "aria-checked": variant === "auto",
                className: "harness-status-panel__menu-item",
                "data-display-mode-value": "auto",
                onClick: () => {
                  setOpen(false);
                  onAuto();
                  ref.current?.querySelector("button")?.focus();
                },
              },
              autoLabel,
            ),
          )
        : null,
    );
  }

  function ConversationStatusPanel(props) {
    const labels = { ...DEFAULT_LABELS, ...(props.labels || {}) };
    const variant = props.variant || "auto";
    const model = props.model || {};
    const git = model.git || null;
    const plan = model.plan && model.plan.items && model.plan.items.length > 0 ? model.plan : null;
    const agents = Array.isArray(model.agents) ? model.agents : [];
    const terminals = Array.isArray(model.terminals) ? model.terminals : [];
    const { current: currentTerminals, ended: endedTerminals } = classifyRowsByStatus(terminals, "state");
    const { current: currentAgents, ended: endedAgents } = classifyRowsByStatus(agents, "phase");

    const hasGit = !!git;
    const hasPlan = !!plan;
    const hasTerminals = currentTerminals.length > 0 || endedTerminals.length > 0;
    const hasAgents = currentAgents.length > 0 || endedAgents.length > 0;
    const hasContent = hasGit || hasPlan || hasTerminals || hasAgents || !!model.isRunning;

    const controlledNow = props.now;
    const [nowState, setNowState] = useState(() => (controlledNow != null ? controlledNow : Date.now()));
    useEffect(() => {
      if (controlledNow != null) return;
      if (currentTerminals.length === 0 && currentAgents.length === 0) return;
      if (typeof window === "undefined") return;
      const id = window.setInterval(() => setNowState(Date.now()), 1000);
      return () => window.clearInterval(id);
    }, [controlledNow, currentTerminals.length, currentAgents.length]);
    const now = controlledNow != null ? controlledNow : nowState;

    const handleExpand = useCallback(() => {
      if (typeof props.onVariantChange === "function") props.onVariantChange("panel");
    }, [props.onVariantChange]);
    const handleMini = useCallback(() => {
      if (typeof props.onVariantChange === "function") props.onVariantChange("mini");
    }, [props.onVariantChange]);
    const handleAuto = useCallback(() => {
      if (typeof props.onVariantChange === "function") props.onVariantChange("auto");
    }, [props.onVariantChange]);

    const onCancel = typeof props.onCancel === "function" ? props.onCancel : null;
    const state = variant === "mini" ? "collapsed" : "expanded";

    const gitSeparated = false;
    const planSeparated = hasGit;
    const terminalsSeparated = hasGit || hasPlan;
    const agentsSeparated = hasGit || hasPlan || hasTerminals;

    if (!hasContent) return null;
    return h(
      "div",
      { "data-theme": props.theme, className: `harness-status-panel-root${props.className ? " " + props.className : ""}` },
      h(
        "aside",
        {
          className: "harness-status-panel",
          "data-state": state,
          "data-display-mode": variant,
          "data-running": String(!!model.isRunning),
          "data-running-terminal-count": String(currentTerminals.filter(row => isRunningRow(row, "state")).length),
          "data-running-agent-count": String(currentAgents.filter(row => isRunningRow(row, "phase")).length),
          "data-ended-terminal-count": String(endedTerminals.length),
          "data-ended-agent-count": String(endedAgents.length),
          "aria-label": labels.title,
          role: "complementary",
        },
        variant !== "mini"
          ? h(
              "div",
              { className: "harness-status-panel__controls" },
              h(MenuButton, { label: labels.displayMode, autoLabel: labels.displayModeAuto, onAuto: handleAuto, variant }),
              h(
                "button",
                {
                  type: "button",
                  className: "harness-status-panel__ctrl",
                  "aria-label": labels.showMini,
                  "data-collapse-to-mini": "true",
                  onClick: handleMini,
                },
                Icon("minimize2"),
              ),
            )
          : null,
        variant !== "mini"
          ? h(
              "div",
              { className: "harness-status-panel__sections" },
              hasGit
                ? h(GitSection, {
                    git,
                    onOpenGitReview: props.onOpenGitReview,
                    onGitBranch: props.onGitBranch,
                    onGitCommitPush: props.onGitCommitPush,
                    labels,
                    separated: gitSeparated,
                  })
                : null,
              hasPlan
                ? h(PlanSection, { plan, labels, separated: planSeparated })
                : null,
              hasTerminals
                ? h(LiveSection, {
                    section: "terminals",
                    title: labels.terminals,
                    kind: "terminal",
                    rows: currentTerminals,
                    ended: endedTerminals,
                    now,
                    openCallback: props.onOpenTerminal,
                    openDirectory: props.onOpenTerminalDirectory,
                    onCancel,
                    labels,
                    separated: terminalsSeparated,
                    open: props.terminalSectionOpen,
                    onOpenChange: props.onTerminalSectionOpenChange,
                    openValue: labels.terminalsOpenValue,
                    openValuePlural: labels.terminalsOpenValuePlural,
                    miniValue: labels.terminalsMiniValue,
                    miniValuePlural: labels.terminalsMiniValuePlural,
                  })
                : null,
              hasAgents
                ? h(LiveSection, {
                    section: "agents",
                    title: labels.agents,
                    kind: "agent",
                    rows: currentAgents,
                    ended: endedAgents,
                    now,
                    openCallback: props.onOpenSubagent,
                    openDirectory: props.onOpenSubagentDirectory,
                    onCancel,
                    labels,
                    separated: agentsSeparated,
                    open: props.agentSectionOpen,
                    onOpenChange: props.onAgentSectionOpenChange,
                    openValue: labels.agentsOpenValue,
                    openValuePlural: labels.agentsOpenValuePlural,
                    miniValue: labels.agentsMiniValue,
                    miniValuePlural: labels.agentsMiniValuePlural,
                  })
                : null,
            )
          : null,
        h(
          "div",
          { className: "harness-status-panel__mini", "aria-hidden": variant === "panel" },
          h(StatusSummaryRow, { model, labels, onExpand: handleExpand }),
        ),
      ),
    );
  }

  function SubagentDirectory({ agents = [], onOpenSubagent, theme, labels: suppliedLabels }) {
    const labels = { ...DEFAULT_LABELS, ...suppliedLabels };
    return h("div", { className: "harness-status-panel-root", "data-theme": theme, style: { position: "relative", display: "block", padding: "1rem", pointerEvents: "auto" } },
      h("style", null, statusPanelStyles),
      h("h3", { style: { margin: "0 0 1rem", font: "inherit" } }, labels.endedAgents),
      h("ul", { style: { listStyle: "none", padding: 0, margin: 0 } },
        agents.filter(row => isEndedStatus(row.phase)).map(row => h(Row, { key: row.runId, row, kind: "agent", now: Date.now(), openCallback: onOpenSubagent, labels }))));
  }
  return { ConversationStatusPanel: memo ? memo(ConversationStatusPanel) : ConversationStatusPanel, SubagentDirectory };
}
