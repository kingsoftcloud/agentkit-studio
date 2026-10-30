// @kingsoftcloud/agentkit-harness-ui — public entry
//
// Re-exports the stable public surface. Hosts that want only the pure logic
// (no React) should import from the subpaths (./protocol, ./reducer, ./view,
// etc.) to avoid pulling React into their bundle. Importing from "." pulls
// the React binding as well.

export {
  PROTOCOL_VERSION, EventType, TaskState, TaskOutcome, ToolStatus, DisplayKind,
  TASK_TRANSITIONS, normalizeEvent, canTransition, isTaskState, isToolStatus, isEventType, isDisplayKind,
} from "./protocol.mjs";

export { initialState, reduce, reduceAll } from "./reducer.mjs";

export {
  visibleItems, isStreaming, isWaitingForFirstToken, isTerminal,
  planProgress, activeTool, failedTools, taskStatusLabel, DEFAULT_LABELS,
} from "./project.mjs";

export {
  latestNonEmptyLine, truncateText, redactValue, boundedDetailLines,
  SummaryQueue, SENSITIVE_KEYS,
} from "./summary.mjs";

export {
  toolTitle, toolDetailLines, workspaceRelative, fileDiffPreview, redactError,
  MAX_TOOL_DETAIL_LINES,
} from "./tool-detail.mjs";

export {
  countChangeStat, patchFilePath, inferOperationKind, parseDiffHunks, diffPreviewLines,
  MAX_DIFF_PREVIEW_LINES,
} from "./diff.mjs";

export {
  extractCommand, extractOutput, sanitizeAnsi, normalizeCwd,
} from "./terminal.mjs";

export {
  renderTool, toolRendererKind,
} from "./renderers.mjs";

export {
  buildViewModel, h, isElement, ELEMENT, DEFAULT_VIEW_OPTIONS,
} from "./view.mjs";

export { styles } from "./styles.mjs";
export { toolIdentity, toolConversationVisible, localizedToolTitle } from './tool-identity.mjs';

// React binding. Imported lazily-safe only because this barrel re-exports it;
// hosts that do not need React should import the subpaths directly.
export { HarnessTimeline } from "./components.mjs";
