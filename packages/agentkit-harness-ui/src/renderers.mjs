// @kingsoftcloud/agentkit-harness-ui — tool-call renderer registry
//
// Replaces the single generic tool block with a registry of purpose-built
// renderers that mirror the ZCode DESKTOP task conversation:
//  - execute (terminal): `$` prompt + bounded command, live output with
//    stdout/stderr/exit/cwd, safe-ANSI plain text, copy + open-terminal actions
//  - read: a file chip (icon + name) that opens the file via a host callback,
//    not toggleable
//  - edit: file chips, +N/-N change count, inline diff with REAL line numbers
//    from the patch hunk headers, unified + split responsive, bounded preview
//    with a full-retrieval callback; never infers a write succeeded from input
//  - default: the bounded, redacted generic detail block for unknown/MCP tools
//
// Every renderer returns a function-free view-model fragment (plain `h` nodes)
// carrying host actions as `data-action`/`data-*` attributes. The React binding
// delegates a single click handler on the root and dispatches to the host
// callbacks, so the tree stays serializable and testable with node:test.

import { h, terminalIcon, fileTextIcon, searchIcon, pencilIcon, wrenchIcon, chevronIcon } from "./view.mjs";
import { ToolStatus } from "./protocol.mjs";
import { toolTitle, toolDetailLines, workspaceRelative, redactError } from "./tool-detail.mjs";
import { truncateText, latestNonEmptyLine, redactValue, boundedDetailLines } from "./summary.mjs";
import { parseDiffHunks, countChangeStat, inferOperationKind } from "./diff.mjs";
import { extractCommand, extractOutput } from "./terminal.mjs";

/** Tool-name → renderer classification. Host tool names vary across runtimes. */
const EXECUTE_NAMES = new Set(["Bash", "bash", "execute", "run_command", "Execute", "ExecuteCommand", "execute_command", "RunCommand", "shell", "Shell"]);
const READ_NAMES = new Set(["Read", "read", "read_workspace_file"]);
const SEARCH_NAMES = new Set(["Glob", "Grep", "glob", "grep", "list_workspace_files", "search_workspace_files", "Search", "search"]);
const EDIT_NAMES = new Set(["Edit", "Write", "edit_workspace_file", "write_workspace_file", "write_workspace_files", "multi_edit_workspace_file", "delete_workspace_file", "apply_workspace_patch", "MultiEdit", "edit", "write", "StrReplace", "Patch"]);

/**
 * Pick a renderer for a tool name. Unknown names fall through to the default
 * bounded detail block so MCP and future tools still render safely.
 * @param {string} name
 * @returns {"execute"|"read"|"edit"|"default"}
 */
export function toolRendererKind(name) {
  const n = String(name || "");
  if (["native_start_child", "native_delegate", "Agent", "Task", "subagent"].includes(n)) return "agent";
  if (EXECUTE_NAMES.has(n)) return "execute";
  if (READ_NAMES.has(n) || SEARCH_NAMES.has(n)) return "read";
  if (EDIT_NAMES.has(n)) return "edit";
  return "default";
}

/** "read" splits internally into a file read vs a search/list summary. */
function readSubKind(name, input) {
  const n = String(name || "");
  if (READ_NAMES.has(n)) return "file";
  if (SEARCH_NAMES.has(n)) return "search";
  // A file_read display or an explicit file path ⇒ treat as a file read even
  // when the host reused a generic tool name.
  return "file";
}

/**
 * Render a tool item by dispatching to the matching renderer. Returns a
 * function-free view-model fragment rooted at a `tool-block` section.
 * @param {object} item reducer tool item
 * @param {object} opts view options (workspaceRoot, labels, diffMaxLines, toolOpen, callbacks)
 */
export function renderTool(item, opts) {
  if (item.child) return agentRenderer(item, opts);
  switch (toolRendererKind(item.name)) {
    case "agent": return agentRenderer(item, opts);
    case "execute": return executeRenderer(item, opts);
    case "read": return readRenderer(item, opts);
    case "edit": return editRenderer(item, opts);
    default: return defaultRenderer(item, opts);
  }
}

/**
 * Common shell that owns the compact summary row (icon + title/content +
 * status + disclosure chevron) and the error placement. Mirrors the desktop
 * ToolLayout/ToolSummaryRow: a static kind icon, the kind/title text (which
 * takes the running gradient while streaming — applied by each renderer on its
 * own title span), the primary/secondary content, the status word, and a
 * chevron that rotates when the body is open.
 *
 * Error placement preserves the reason for non-toggleable tools too: a read or
 * search that cannot expand still surfaces its redacted error inline in the
 * summary (role=alert), so the failure is never hidden behind a missing toggle.
 */
function toolShell(item, opts, { icon, summary, body, canToggle = true, defaultOpen, actions = [], summaryAction }) {
  const status = item.status;
  const streaming = status === ToolStatus.Running || status === ToolStatus.Scheduled;
  const open = resolveOpen(item, opts, defaultOpen == null ? streaming : defaultOpen, canToggle);
  const summaryKids = [];
  if (icon && opts.showToolIcon !== false) summaryKids.push(icon);
  if (Array.isArray(summary)) summaryKids.push(...summary);
  else if (summary) summaryKids.push(summary);
  const error = status === ToolStatus.Failed && item.error ? redactError(item.error) : null;
  // Non-toggleable tools have no body to expand into, so their error must live
  // in the summary; toggleable tools show it inline only when collapsed.
  const showInlineError = error && (canToggle ? !open : true);
  if (showInlineError) summaryKids.push(h("span", {
    className: "harness-tool-error harness-tool-error-inline",
    role: "alert",
    "data-testid": "tool-error",
  }, error));
  if ([ToolStatus.Failed, ToolStatus.Uncertain, ToolStatus.Interrupted, ToolStatus.Waiting].includes(status)) summaryKids.push(h("span", {
    className: `harness-tool-status harness-tool-status-${status}`,
    "data-testid": "tool-status",
    "data-status": status,
  }, statusLabel(status, opts)));
  for (const action of actions) {
    if (action) summaryKids.push(action);
  }
  if (canToggle) summaryKids.push(chevronIcon("harness-tool-chevron"));
  const bodyKids = Array.isArray(body) ? body : [body];
  if (error && open && canToggle) bodyKids.push(h("div", {
    className: "harness-tool-error", role: "alert", "data-testid": "tool-error",
  }, error));
  const detailsProps = canToggle ? {
    open, className: "harness-tool-details", "data-testid": "tool-details",
    "data-call-id": item.callId, "aria-expanded": open,
  } : {
    className: "harness-tool-details harness-tool-details-static",
    "data-testid": "tool-details", "data-call-id": item.callId, "data-static": "true",
  };
  return h("section", {
    className: `harness-tool harness-tool-${toolRendererKind(item.name)}`,
    "data-testid": "tool-block",
    "data-call-id": item.callId,
    "data-status": status,
    "data-renderer": toolRendererKind(item.name),
    "data-streaming": streaming ? "true" : "false",
  }, h(canToggle ? "details" : "div", detailsProps,
    h(canToggle ? "summary" : summaryAction ? "button" : "div", { className: "harness-tool-summary", "data-testid": canToggle ? "tool-toggle" : summaryAction ? "subagent-summary" : "tool-summary-static", ...(summaryAction ?? {}) }, ...summaryKids),
    ...(canToggle ? bodyKids : [])));
}

function agentRenderer(item, opts) {
  const child = item.child;
  const running = item.status === ToolStatus.Running || item.status === ToolStatus.Scheduled;
  const title = child?.title || item.input?.description || item.input?.task || item.input?.prompt || item.name;
  const activity = running && child?.activity && toolRendererKind(child.activity.name) === 'read' ? child.activity : null;
  const activityPath = activity && readMeta(activity).path;
  const primary = activityPath ? `${opts.labels.readKind || 'Read'} ${leafName(activityPath)}` : title;
  const role = child?.role || item.input?.role || item.input?.subagent_type || '';
  let hash = 0; for (let i = 0; i < role.length; i++) hash = (hash * 31 + role.charCodeAt(i)) >>> 0;
  const colors = ['yellow', 'red', 'orange', 'green', 'cyan', 'blue', 'purple', 'pink'];
  const icon = h('svg', { className: 'harness-icon harness-tool-kind-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    h('path', { d: 'M12 8V4H8' }), h('rect', { width: 16, height: 12, x: 4, y: 8, rx: 2 }),
    h('path', { d: 'M2 14h2M20 14h2M15 13v2M9 13v2' }));
  return toolShell(item, opts, { icon, canToggle: false, body: [],
    summaryAction: child && opts.onOpenSubagent ? { type: 'button', 'data-action': 'open-subagent', 'data-call-id': item.callId,
      'aria-label': opts.labels.openSubagent || 'Open on the right', title: String(title).slice(0, 512) } : undefined,
    summary: [h('span', { className: running ? 'harness-tool-title harness-tool-title-streaming' : 'harness-tool-title' }, opts.labels.subagent || 'SubAgent'),
      role ? h('span', { className: 'harness-agent-name', 'data-color': colors[hash % colors.length] }, role) : null,
      h('span', { className: 'harness-agent-separator', 'aria-hidden': true }, '·'),
      h('span', { className: 'harness-agent-title' }, String(primary).slice(0, 512))] });
}

function resolveOpen(item, opts, defaultOpen, canToggle) {
  if (!canToggle) return true;
  if (opts.toolOpen && opts.toolOpen.has(item.callId)) return Boolean(opts.toolOpen.get(item.callId));
  return defaultOpen;
}

function statusLabel(status, opts) {
  const l = opts.labels || {};
  switch (status) {
    case "scheduled": return l.toolScheduled || "queued";
    case "running": return l.toolRunning || "running";
    case "completed": return l.toolCompleted || "done";
    case "failed": return l.toolFailed || "failed";
    case "uncertain": return l.toolUncertain || "outcome unknown";
    case "interrupted": return l.interrupted || "interrupted";
    case "waiting": return l.waiting || "waiting";
    default: return status;
  }
}

// ── execute / terminal ──────────────────────────────────────────────────────

function executeRenderer(item, opts) {
  const command = extractCommand(item.input);
  const running = item.status === ToolStatus.Running || item.status === ToolStatus.Scheduled;
  const out = extractOutput(item.result, item.display);
  // cwd: prefer the result display, fall back to the input the host scheduled.
  const cwd = out.cwd || (typeof item.input?.cwd === "string" ? item.input.cwd.trim() : "");
  // One extractor handles both normalized event displays (fullText) and
  // Host observation snapshots (stdout/stderr). An empty alias must not hide
  // real streaming bytes supplied through the other supported representation.
  const stdout = out.stdout;
  const hasOutput = Boolean(stdout || out.stderr || out.exit != null);
  const title = toolTitle(item.name, item.input) || item.name;
  const summary = [h("span", {
    className: running
      ? "harness-tool-title harness-tool-title-streaming"
      : "harness-tool-title",
    "data-testid": "tool-title",
  }, title)];
  if (command) summary.push(h("code", {
    className: "harness-tool-command-summary",
    "data-testid": "tool-command-summary",
    title: command,
  }, truncateText(command, { maxLines: 1, maxChars: 80 })));

  const body = [commandBlock(item.callId, command, cwd, opts),
    outputBlock(item.callId, { stdout, stderr: out.stderr, exit: out.exit, cwd, running, hasOutput }, opts)];
  // A host progress message (e.g. "running 4 tests") is shown as a live status
  // line under the command, above the output. The reducer never invents it.
  if (item.progress && item.status !== ToolStatus.Completed) {
    body.splice(1, 0, h("div", {
      className: "harness-tool-progress",
      role: "status",
      "data-testid": "tool-progress",
    }, item.progress));
  }

  return toolShell(item, opts, { icon: terminalIcon("harness-tool-kind-icon"), summary, body, canToggle: true, defaultOpen: running });
}

function commandBlock(callId, command, cwd, opts) {
  return h("div", {
    className: "harness-execute-command",
    "data-testid": "execute-command",
    "data-call-id": callId,
    "data-expand-label": opts.labels?.expandCommand || "Expand command",
    "data-collapse-label": opts.labels?.collapseCommand || "Collapse command",
  }, h("div", { className: "harness-execute-command-row" },
    h("span", { className: "harness-execute-prompt", "data-testid": "execute-command-prompt", "aria-hidden": "true" }, "$"),
    h("pre", {
      className: "harness-execute-command-text",
      "data-testid": "execute-command-text",
    }, command || "")),
  h("div", { className: "harness-execute-command-actions" },
    command ? copyButton(opts, command, "copy-command") : null,
    opts.onOpenTerminal ? h("button", {
      type: "button",
      className: "harness-tool-action",
      "data-testid": "execute-open-terminal",
      "data-action": "open-terminal",
      "data-call-id": callId,
      "data-cwd": cwd || "",
    }, opts.labels && opts.labels.openTerminal || "Open terminal") : null));
}

function outputBlock(callId, out, opts) {
  const { stdout, stderr, exit, cwd, running, hasOutput } = out;
  const parts = [];
  if (stdout || running || hasOutput) parts.push(h("pre", {
    className: "harness-execute-output harness-execute-stdout",
    "data-call-id": callId,
    tabIndex: 0,
    "data-testid": running ? "bash-output-preview-full" : "bash-result-output",
    "data-streaming": running ? "true" : "false",
    "data-following": "true",
  }, stdout));
  if (stderr) parts.push(h("pre", {
    className: "harness-execute-output harness-execute-stderr",
    "data-testid": "bash-result-stderr",
  }, stderr));
  const meta = [];
  if (exit != null) meta.push(h("span", {
    className: `harness-execute-exit ${exit === 0 ? "harness-execute-exit-ok" : "harness-execute-exit-err"}`,
    "data-testid": "execute-exit",
    "data-exit": String(exit),
  }, `exit ${exit}`));
  if (cwd) meta.push(h("span", { className: "harness-execute-cwd", "data-testid": "execute-cwd" }, cwd));
  if (hasOutput) meta.push(copyButton(opts, stdout || stderr || "", "copy-output"));
  if (meta.length) parts.push(h("div", { className: "harness-execute-meta" }, ...meta));
  if (!hasOutput && !running) {
    parts.push(h("p", { className: "harness-execute-no-output", "data-testid": "execute-no-output" },
      opts.labels && opts.labels.noOutput || "No output"));
  }
  if (!parts.length) return null;
  return h("div", { className: "harness-execute-output-block", "data-testid": "execute-output" }, ...parts);
}

function copyButton(opts, text, testid) {
  if (!opts.onCopy) return null;
  return h("button", {
    type: "button",
    className: "harness-tool-action harness-copy-action",
    "data-testid": testid,
    "data-action": "copy",
    "data-copy-text": String(text || ""),
  }, opts.labels && opts.labels.copy || "Copy");
}

// ── read / search / list ─────────────────────────────────────────────────────
//
// The desktop conversation splits "file-read" (ReadToolCallBlock: a file chip)
// from "search" (SearchToolCallBlock: "Find {query}" / "List {cwd}"). Both are
// non-toggleable one-line summaries. The path is shown once (leaf in the chip +
// the workspace-relative path as secondary, full path only in the chip title)
// rather than repeated across the title, the chip, and a third path line.

function readRenderer(item, opts) {
  return readSubKind(item.name, item.input) === "search"
    ? searchListRenderer(item, opts)
    : readFileRenderer(item, opts);
}

function readFileRenderer(item, opts) {
  const meta = readMeta(item);
  const path = meta.path;
  const fileName = leafName(path) || toolTitle(item.name, item.input) || item.name;
  const running = item.status === ToolStatus.Running || item.status === ToolStatus.Scheduled;
  const kindLabel = running
    ? (opts.labels && opts.labels.readReading || "Reading")
    : (opts.labels && opts.labels.readKind || "Read");
  const canOpen = Boolean(opts.onOpenFile) && meta.entryType === "file";
  // Primary content is the file chip itself; the kind label precedes it. The
  // path is NOT duplicated in the title — only the leaf shows in the chip and
  // the workspace-relative path shows once as the secondary.
  const summary = [
    h("span", {
      className: running
        ? "harness-tool-title harness-tool-title-streaming"
        : "harness-tool-title",
      "data-testid": "tool-title",
    }, kindLabel),
    fileChip(path, fileName, canOpen, opts, "read-chip", "read-file-name",
      { kind: meta.entryType === "directory" ? "directory" : "file", callId: item.callId, path }),
  ];
  if (path) summary.push(h("span", {
    className: "harness-tool-secondary harness-read-path",
    "data-testid": "read-file-path",
    title: path,
  }, workspaceRelative(path, opts.workspaceRoot)));
  // Read is a one-line chip; it does not toggle. A failed read surfaces its
  // error inline via the shell, and an optional inspect action lets the host
  // open the result/details (the public result-inspection action).
  return toolShell(item, opts, {
    icon: fileTextIcon("harness-tool-kind-icon"),
    summary, body: [], canToggle: false,
  });
}

function searchListRenderer(item, opts) {
  const running = item.status === ToolStatus.Running || item.status === ToolStatus.Scheduled;
  const isList = isListInput(item.name, item.input);
  const query = searchQuery(item.input);
  const cwd = searchCwd(item.input);
  const labels = opts.labels || {};
  const kindLabel = running
    ? (isList ? (labels.listSearching || "Listing") : (labels.searchSearching || "Searching"))
    : (isList ? (labels.listKind || "List") : (labels.searchKind || "Search"));
  const primary = isList
    ? (cwd ? (labels.searchListIn || "List in {cwd}").replace("{cwd}", truncateText(cwd, { maxLines: 1, maxChars: 60 }))
      : (labels.searchList || "List"))
    : (query ? (labels.searchFindQuery || "Find {query}").replace("{query}", truncateText(query, { maxLines: 1, maxChars: 80 }))
      : (labels.searchFind || "Find"));
  const summary = [
    h("span", {
      className: running
        ? "harness-tool-title harness-tool-title-streaming"
        : "harness-tool-title",
      "data-testid": "tool-title",
    }, kindLabel),
    h("span", {
      className: "harness-tool-primary harness-search-primary",
      "data-testid": "search-primary",
    }, primary),
  ];
  return toolShell(item, opts, {
    icon: searchIcon("harness-tool-kind-icon"),
    summary, body: [], canToggle: false,
  });
}

/** A directory listing (list_workspace_files / parsed list_files) vs a search. */
function isListInput(name, input) {
  const n = String(name || "");
  if (n === "list_workspace_files" || n === "List") return true;
  const pc = input && Array.isArray(input.parsed_cmd) ? input.parsed_cmd : null;
  if (pc) return pc.some(p => p && typeof p === "object" && p.type === "list_files");
  return false;
}

function searchQuery(input) {
  if (!input || typeof input !== "object") {
    if (typeof input === "string") return input.trim();
    return "";
  }
  const pc = Array.isArray(input.parsed_cmd) ? input.parsed_cmd : null;
  if (pc) {
    for (const p of pc) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "search" || p.type === "grep" || p.type === "glob") {
        const q = [p.pattern, p.query, p.path].find(v => typeof v === "string" && v.trim());
        if (q) return q.trim();
      }
    }
  }
  for (const key of ["search_query", "searchQuery", "query", "pattern", "path", "url", "prompt", "target", "name"]) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return "";
}

function searchCwd(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.cwd === "string" && input.cwd.trim()) return input.cwd.trim().replace(/\/+$/, "");
  const pc = Array.isArray(input.parsed_cmd) ? input.parsed_cmd : null;
  if (pc) {
    for (const p of pc) {
      if (p && typeof p === "object" && p.type === "list_files" && typeof p.path === "string" && p.path.trim()) {
        return p.path.trim().replace(/\/+$/, "");
      }
    }
  }
  return "";
}

function readMeta(item) {
  const disp = item.display || {};
  if (disp.kind === "file_read") return { path: disp.path || readInputPath(item.input), entryType: disp.entryType || "file" };
  return { path: readInputPath(item.input), entryType: "file" };
}

function readInputPath(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ["file_path", "filePath", "path", "filename"]) {
    if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return "";
}

// ── edit ───────────────────────────────────────────────────────────────────

function editRenderer(item, opts) {
  const files = editFiles(item);
  const running = item.status === ToolStatus.Running || item.status === ToolStatus.Scheduled;
  // Never infer a write succeeded: the diff/count come from the result display
  // only. While running (no result), show the intent + file chips, no diff.
  const opKind = files.length ? inferOperationKind(files[0].operationKind, null, files[0].patch) : "edit";
  const pending = files.some(file => file.pending);
  const title = pending ? /write|Write/.test(item.name) ? opts.labels.writePending || 'Write requested'
    : opts.labels.editPending || 'Edit requested' : editKindLabel(opKind, running, opts) || toolTitle(item.name, item.input) || item.name;
  const summary = [h("span", {
    className: running
      ? "harness-tool-title harness-tool-title-streaming"
      : "harness-tool-title",
    "data-testid": "tool-title",
  }, title)];
  summary.push(h("span", { className: "harness-edit-chips", "data-testid": "edit-chips" },
    ...files.map((f, i) => h("span", { className: "harness-edit-chip-wrap", key: f.path + i },
      i > 0 ? h("span", { className: "harness-edit-chip-sep" }, ",") : null,
      fileChip(f.path, leafName(f.path) || f.path, !f.pending && Boolean(opts.onOpenFile), opts, "edit-chip", "edit-file-name", { kind: f.patch ? "patch" : "file", callId: item.callId, path: f.path })))));

  const totalStat = files.reduce((acc, f) => {
    const s = f.changeStat || countChangeStat(f.patch);
    if (!s) return acc;
    return { added: acc.added + s.added, removed: acc.removed + s.removed };
  }, { added: 0, removed: 0 });
  if (totalStat.added || totalStat.removed) {
    summary.push(h("span", {
      className: "harness-diff-count",
      "data-testid": "edit-diff-count",
      "aria-label": `+${totalStat.added} -${totalStat.removed}`,
    }, totalStat.added > 0 ? h("span", { className: "harness-diff-added" }, `+${totalStat.added}`) : null,
      totalStat.removed > 0 ? h("span", { className: "harness-diff-removed" }, `-${totalStat.removed}`) : null));
  }

  const body = [];
  for (const f of files) {
    if (!f.patch) continue;
    const parsed = parseDiffHunks(f.patch, { maxLines: opts.diffMaxLines || 200 });
    if (parsed) body.push(diffBlock(item.callId, f, { ...parsed, truncated: parsed.truncated || f.truncated }, opts));
    else if (f.truncated) body.push(h("p", { className: "harness-diff-truncated", "data-testid": "edit-diff-truncated" }, opts.labels.diffUnavailable || "Diff preview omitted because of its size"));
  }
  if (item.display?.omittedFiles) body.push(h("p", { className: "harness-diff-truncated", "data-testid": "edit-diff-omitted" }, `${item.display.omittedFiles} ${opts.labels.diffFilesOmitted || "file previews omitted"}`));
  if (!body.length && !running && files.length) {
    // Result arrived without a patch: surface the file chips only, no diff.
  }
  return toolShell(item, opts, { icon: pencilIcon("harness-tool-kind-icon"), summary, body, canToggle: true,
    defaultOpen: running && !files.some(f => f.patch) ? true : (files.length > 1 ? false : running) });
}

function editFiles(item) {
  const disp = item.display || {};
  if (disp.kind === "file_edit" && Array.isArray(disp.files)) {
    return disp.files.map(f => ({ path: f.path, patch: f.patch, changeStat: f.changeStat, operationKind: f.operationKind, truncated: f.truncated }));
  }
  if (disp.kind === "file_diff") {
    return [{ path: disp.path, patch: disp.patch, changeStat: disp.changeStat, operationKind: disp.operationKind }];
  }
  const paths = typeof item.input?.path === 'string' ? [item.input.path] : Array.isArray(item.input?.files)
    ? item.input.files.map(file => file?.path).filter(path => typeof path === 'string') : [];
  return paths.map(path => ({ path, pending: true }));
}

function editKindLabel(opKind, running, opts) {
  const l = opts.labels || {};
  if (opKind === "write") return running ? (l.editWriting || "writing") : (l.editWrite || "write");
  if (opKind === "delete") return running ? (l.editDeleting || "deleting") : (l.editDelete || "delete");
  return running ? (l.editEditing || "editing") : (l.editEdit || "edit");
}

function diffBlock(callId, file, parsed, opts) {
  const unified = parsed.unified.map((line, i) => diffLine(line, i, "unified"));
  const splitOld = parsed.split.old.map((line, i) => diffLine(line, i, "old"));
  const splitNew = parsed.split.new.map((line, i) => diffLine(line, i, "new"));
  const header = [
    h("span", { className: "harness-diff-path", "data-testid": "edit-diff-path" }, file.path || parsed.path),
    parsed.added || parsed.removed ? h("span", { className: "harness-diff-count", "data-testid": "edit-diff-count-detail" },
      parsed.added > 0 ? h("span", { className: "harness-diff-added" }, `+${parsed.added}`) : null,
      parsed.removed > 0 ? h("span", { className: "harness-diff-removed" }, `-${parsed.removed}`) : null) : null,
  ];
  const actions = [];
  if (opts.onOpenFile) actions.push(h("button", {
    type: "button", className: "harness-tool-action", "data-testid": "edit-open-file",
    "data-action": "open-file", "data-path": file.path || parsed.path, "data-kind": "patch", "data-call-id": callId,
  }, opts.labels && opts.labels.openFile || "Open"));
  if (parsed.truncated && opts.onRetrieveFullDiff) actions.push(h("button", {
    type: "button", className: "harness-tool-action", "data-testid": "edit-show-full-diff",
    "data-action": "retrieve-diff", "data-call-id": callId, "data-path": file.path || parsed.path,
  }, opts.labels && opts.labels.showFullDiff || "Show full diff"));
  return h("div", {
    className: "harness-edit-diff",
    "data-testid": "edit-diff",
    "data-call-id": callId,
    "data-path": file.path || parsed.path,
  }, h("div", { className: "harness-diff-header" }, ...header, actions.length ? h("span", { className: "harness-diff-actions" }, ...actions) : null),
  h("div", { className: "harness-diff-view harness-diff-unified", "data-testid": "edit-diff-unified", "data-diff-view": "unified" }, ...unified),
  h("div", { className: "harness-diff-view harness-diff-split", "data-testid": "edit-diff-split", "data-diff-view": "split" },
    h("div", { className: "harness-diff-split-col", "data-diff-side": "old" }, ...splitOld),
    h("div", { className: "harness-diff-split-col", "data-diff-side": "new" }, ...splitNew)),
  parsed.truncated ? h("div", { className: "harness-diff-truncated", "data-testid": "edit-diff-truncated" }, "…") : null);
}

function diffLine(line, index, side) {
  return h("div", {
    className: `harness-diff-line harness-diff-${markerClass(line.marker)}`,
    "data-marker": line.marker,
    "data-testid": "edit-diff-line",
    "data-diff-side": side,
    key: String(index),
  }, h("span", { className: "harness-diff-gutter harness-diff-gutter-old", "data-testid": "edit-diff-old-line" }, line.oldLine == null ? "" : String(line.oldLine)),
    h("span", { className: "harness-diff-gutter harness-diff-gutter-new", "data-testid": "edit-diff-new-line" }, line.newLine == null ? "" : String(line.newLine)),
    h("span", { className: "harness-diff-marker", "aria-hidden": "true" }, line.marker),
    h("span", { className: "harness-diff-text" }, line.text || ""));
}

function markerClass(marker) {
  if (marker === "+") return "added";
  if (marker === "-") return "removed";
  return "context";
}

function fileChip(path, label, clickable, opts, chipTestid, nameTestid, action) {
  const isDir = action && action.kind === "directory" || String(path || "").endsWith("/");
  const glyph = isDir ? searchIcon("harness-file-icon") : fileTextIcon("harness-file-icon");
  const inner = [
    glyph,
    h("span", { className: "harness-file-name", "data-testid": nameTestid }, label),
  ];
  if (clickable && opts.onOpenFile) {
    return h("button", {
      type: "button",
      className: "harness-file-chip",
      "data-testid": chipTestid,
      "data-action": "open-file",
      "data-path": path,
      "data-kind": action && action.kind || "file",
      "data-call-id": action && action.callId,
      title: path,
    }, ...inner);
  }
  return h("span", { className: "harness-file-chip harness-file-chip-static", "data-testid": chipTestid, title: path }, ...inner);
}

function leafName(path) {
  const p = String(path || "").replace(/\/+$/, "");
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

// ── default (unknown / MCP) ────────────────────────────────────────────────

function defaultRenderer(item, opts) {
  const title = toolTitle(item.name, item.input) || item.name;
  const detail = toolDetailLines(item.name, item.input, { workspaceRoot: opts.workspaceRoot });
  const running = item.status === ToolStatus.Running || item.status === ToolStatus.Scheduled;
  const summary = [h("span", {
    className: running
      ? "harness-tool-title harness-tool-title-streaming"
      : "harness-tool-title",
    "data-testid": "tool-title",
  }, title)];
  const body = [];
  if (detail.length) {
    body.push(h("dl", { className: "harness-tool-detail", "data-testid": "tool-detail" },
      detail.map(row => h("div", { className: "harness-tool-detail-line", key: row.key },
        h("dt", {}, row.key + ":"), h("dd", {}, row.value)))));
  }
  if (item.progress && item.status !== ToolStatus.Completed) {
    body.push(h("div", { className: "harness-tool-progress", role: "status", "data-testid": "tool-progress" }, item.progress));
  }
  if (item.result !== undefined && item.result !== null) {
    const raw = typeof item.result === "string" ? item.result : safeStringify(item.result);
    const preview = truncateText(raw, { maxLines: 80, maxChars: 6000 });
    body.push(h("details", { className: "harness-tool-result", "data-testid": "tool-result" },
      h("summary", {}, opts.labels && opts.labels.result || "Result"),
      h("pre", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "24rem", overflow: "auto" } }, preview)));
  }
  // A file_diff display on an unknown tool still renders a diff so the user can
  // see the change without the host reclassifying the tool.
  if (item.display && item.display.kind === "file_diff" && item.display.patch) {
    const parsed = parseDiffHunks(item.display.patch, { maxLines: opts.diffMaxLines || 200 });
    if (parsed) body.push(diffBlock(item.callId, { path: item.display.path, patch: item.display.patch, changeStat: item.display.changeStat }, parsed, opts));
  }
  return toolShell(item, opts, { icon: wrenchIcon("harness-tool-kind-icon"), summary, body, canToggle: true, defaultOpen: running });
}

function safeStringify(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export { redactValue, boundedDetailLines, latestNonEmptyLine };
