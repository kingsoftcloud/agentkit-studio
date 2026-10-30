// @kingsoftcloud/agentkit-harness-ui — tool call detail blocks
//
// One stable bounded detail block per call identity. Presentation consumes
// host-supplied input only; it never reads files or executes commands.

import { truncateText, redactValue, boundedDetailLines } from "./summary.mjs";

/** Maximum detail lines for a single tool block (safety + size contract). */
export const MAX_TOOL_DETAIL_LINES = 4;
const MAX_LINE_CHARS = 120;

/**
 * Stable action title for a tool. Known tools replace the generic lifecycle
 * title with a human audit title; unknown/MCP tools fall back to the tool name.
 * Never prefixed with `Tool` and never carries lifecycle status text.
 * @param {string} name
 * @param {Record<string, unknown>} [input]
 * @returns {string}
 */
export function toolTitle(name, input = {}) {
  const tool = String(name || "tool");
  const path = typeof input.path === "string" ? input.path
    : typeof input.file_path === "string" ? input.file_path
    : typeof input.path === "undefined" && typeof input.file_path === "string" ? input.file_path
    : "";
  const nativeTitles = { read_workspace_file: '读取', write_workspace_file: '写入', edit_workspace_file: '修改',
    apply_workspace_patch: '应用补丁', list_workspace_files: '列出文件', search_workspace_files: '搜索文件', run_command: '运行命令' };
  if (nativeTitles[tool]) return `${nativeTitles[tool]}${path ? ` ${workspaceRelative(path)}` : ''}`;
  switch (tool) {
    case "Read":
      return path ? `Read ${workspaceRelative(path)}` : "Read";
    case "Edit":
    case "Write":
      return path ? `${tool} ${workspaceRelative(path)}` : tool;
    case "Glob":
      return patternTitle("Glob", input);
    case "Grep":
      return patternTitle("Grep", input);
    case "WebFetch":
    case "WebSearch":
      return urlTitle(tool, input);
    default:
      return tool;
  }
}

function patternTitle(tool, input) {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  return pattern ? `${tool} ${truncateText(pattern, { maxLines: 1, maxChars: 60 })}` : tool;
}

function urlTitle(tool, input) {
  const url = typeof input.url === "string" ? input.url : "";
  return url ? `${tool} ${truncateText(url, { maxLines: 1, maxChars: 80 })}` : tool;
}

/**
 * Workspace-relative path when inside the workspace, absolute otherwise. The
 * workspace root is host-supplied (the UI does not detect it); when no root is
 * configured the path is shown unchanged so the host stays the source of truth.
 * @param {string} path
 * @param {string} [workspaceRoot]
 * @returns {string}
 */
export function workspaceRelative(path, workspaceRoot) {
  const p = String(path || "");
  if (!workspaceRoot) return p;
  const root = workspaceRoot.endsWith("/") ? workspaceRoot : workspaceRoot + "/";
  if (p === workspaceRoot || p === workspaceRoot.replace(/\/$/, "")) return ".";
  if (p.startsWith(root)) return p.slice(root.length);
  return p;
}

/**
 * Bounded detail lines for a tool input. Known tools prefer human audit fields;
 * unknown/MCP tools get a generic redacted preview capped at
 * MAX_TOOL_DETAIL_LINES. Large content blobs are never dumped verbatim.
 * @param {string} name
 * @param {Record<string, unknown>} [input]
 * @param {{workspaceRoot?: string, maxLines?: number, maxChars?: number}} [opts]
 * @returns {{key: string, value: string}[]}
 */
export function toolDetailLines(name, input = {}, opts = {}) {
  const tool = String(name || "tool");
  const maxLines = opts.maxLines && opts.maxLines > 0 ? Math.min(opts.maxLines, MAX_TOOL_DETAIL_LINES) : MAX_TOOL_DETAIL_LINES;
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : MAX_LINE_CHARS;
  const detail = knownToolDetail(tool, input, opts.workspaceRoot, maxLines, maxChars);
  if (detail) return detail;
  return boundedDetailLines(input, { maxLines, maxChars });
}

function knownToolDetail(tool, input, workspaceRoot, maxLines, maxChars) {
  const pushBounded = (rows, key, value) => {
    if (rows.length >= maxLines) return rows;
    if (value == null || value === "") return rows;
    rows.push({ key, value: truncateText(String(value), { maxLines: 1, maxChars }) });
    return rows;
  };
  let rows = [];
  switch (tool) {
    case "Bash":
      pushBounded(rows, "command", input.command);
      pushBounded(rows, "cwd", input.cwd);
      if (input.timeout != null) pushBounded(rows, "timeout", input.timeout);
      if (input.background) pushBounded(rows, "background", "true");
      return rows.slice(0, maxLines);
    case "Read":
      pushBounded(rows, "offset", input.offset);
      pushBounded(rows, "limit", input.limit);
      pushBounded(rows, "pages", input.pages);
      return rows.slice(0, maxLines);
    case "Write":
      pushBounded(rows, "offset", input.offset);
      pushBounded(rows, "limit", input.limit);
      pushBounded(rows, "pages", input.pages);
      pushBounded(rows, "replace_all", input.replace_all);
      return rows.slice(0, maxLines);
    case "Edit":
      // file_path is in the title; old_string/new_string are the audit surface
      // but are summarized, not dumped. replace_all is omitted (already audited
      // via the diff), matching the reference Edit rule.
      return [];
    case "Grep":
      pushBounded(rows, "path", input.path ? workspaceRelative(input.path, workspaceRoot) : input.path);
      pushBounded(rows, "glob", input.glob);
      pushBounded(rows, "output_mode", input.output_mode);
      pushBounded(rows, "type", input.type);
      return rows.slice(0, maxLines);
    case "Glob":
      pushBounded(rows, "path", input.path ? workspaceRelative(input.path, workspaceRoot) : input.path);
      return rows.slice(0, maxLines);
    case "WebFetch":
      pushBounded(rows, "prompt", typeof input.prompt === "string" ? input.prompt : "");
      return rows.slice(0, maxLines);
    case "Agent":
      pushBounded(rows, "description", input.description);
      pushBounded(rows, "subagent_type", input.subagent_type);
      if (input.background) pushBounded(rows, "background", "true");
      return rows.slice(0, maxLines);
    case "Skill":
      pushBounded(rows, "skill", input.skill);
      return rows.slice(0, maxLines);
    case "TodoWrite":
      return todoDetail(input, maxLines, maxChars);
    default:
      return null;
  }
}

function todoDetail(input, maxLines, maxChars) {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  if (!todos.length) return [];
  const inProgress = todos.find(t => t && t.status === "in_progress");
  const rows = [];
  rows.push({ key: "todos", value: String(todos.length) });
  if (inProgress && rows.length < maxLines) {
    rows.push({ key: "in_progress", value: truncateText(String(inProgress.content || ""), { maxLines: 1, maxChars }) });
  }
  return rows.slice(0, maxLines);
}

/**
 * Bounded file_diff preview from a `tool.result` display payload. Returns null
 * when the display is not a supported file_diff. The preview keeps a small set
 * of hunk lines with `+`/`-` markers and a path summary; the full patch is
 * never rendered verbatim.
 * @param {Record<string, unknown>} [display]
 * @param {{maxLines?: number}} [opts]
 * @returns {{path: string, lines: {marker: string, text: string}[], truncated: boolean}|null}
 */
export function fileDiffPreview(display, opts = {}) {
  if (!display || display.kind !== "file_diff") return null;
  const maxLines = opts.maxLines && opts.maxLines > 0 ? Math.floor(opts.maxLines) : 8;
  const path = String(display.path || "");
  const patch = typeof display.patch === "string" ? display.patch : "";
  const lines = [];
  let truncated = false;
  for (const raw of patch.split("\n")) {
    if (lines.length >= maxLines) { truncated = true; break; }
    if (!raw) continue;
    if (raw.startsWith("@@")) continue;
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    const marker = raw.startsWith("+") ? "+" : raw.startsWith("-") ? "-" : " ";
    lines.push({ marker, text: truncateText(raw.slice(1), { maxLines: 1, maxChars: MAX_LINE_CHARS }) });
  }
  if (patch && !lines.length) {
    lines.push({ marker: " ", text: "(no viewable lines)" });
  }
  return { path, lines, truncated };
}

/**
 * Redact an error message for user-facing display. Keeps the message concise
 * and bounded; never exposes values that may carry secrets in the raw error.
 * @param {string} error
 * @param {{maxChars?: number}} [opts]
 * @returns {string}
 */
export function redactError(error, opts = {}) {
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : 200;
  const value = String(error || "");
  // The error color/placement already expresses the type; keep the message
  // itself, bounded. Strip common secret patterns defensively.
  const cleaned = value.replace(/(token|secret|password|api[_-]?key|authorization)\s*[=:]\s*\S+/gi, "$1=[redacted]");
  return truncateText(cleaned, { maxLines: 3, maxChars });
}

export { redactValue };
