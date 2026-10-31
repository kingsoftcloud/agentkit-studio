import test from "node:test";
import assert from "node:assert/strict";
import { EventType } from "../src/protocol.mjs";
import { initialState, reduceAll } from "../src/reducer.mjs";
import { renderTool, toolRendererKind } from "../src/renderers.mjs";
import { findByTestId, findAllByTestId, attr, textOf, hasText } from "./helpers.mjs";

function ev(type, id, extra = {}) { return { v: 1, type, id, ...extra }; }
const render = (item, opts = {}) => renderTool(item, { diffMaxLines: 200, ...opts });

test("toolRendererKind classifies execute/read/edit and falls back to default", () => {
  assert.equal(toolRendererKind("Bash"), "execute");
  assert.equal(toolRendererKind("run_command"), "execute");
  assert.equal(toolRendererKind("Read"), "read");
  assert.equal(toolRendererKind("read_workspace_file"), "read");
  assert.equal(toolRendererKind("Edit"), "edit");
  assert.equal(toolRendererKind("apply_workspace_patch"), "edit");
  assert.equal(toolRendererKind("some-mcp-tool"), "default");
  assert.equal(toolRendererKind(""), "default");
});

test("execute renderer emits $ prompt, monospace command, cwd, and open-terminal/copy actions", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Bash", input: { command: "npm test", cwd: "packages/ui" } }),
    ev(EventType.ToolStarted, "x2", { callId: "c1" }),
  ]);
  const item = s.items[0];
  const tree = render(item, { onOpenTerminal: () => {}, onCopy: () => {} });
  assert.equal(attr(tree, "data-renderer"), "execute");
  assert.equal(attr(tree, "data-status"), "running");
  assert.equal(textOf(findByTestId(tree, "execute-command-prompt")), "$");
  assert.ok(hasText(findByTestId(tree, "execute-command-text"), "npm test"));
  assert.equal(textOf(findByTestId(tree, "execute-cwd")), "packages/ui");
  assert.ok(findByTestId(tree, "execute-open-terminal"), "open-terminal action renders when callback provided");
  assert.ok(findByTestId(tree, "copy-command"), "copy-command action renders when onCopy provided");
  // No result yet ⇒ no exit, no output; running not completed (no invented success)
  assert.equal(findByTestId(tree, "execute-exit"), null);
});

test("execute renderer shows live output with stdout/stderr/exit from the result display", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Bash", input: { command: "npm test" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "command_output", stdout: "ok\n", stderr: "", exit: 0, cwd: "/r" } }),
  ]);
  const tree = render(s.items[0], { onCopy: () => {} });
  assert.equal(textOf(findByTestId(tree, "bash-result-output")), "ok\n");
  const exit = findByTestId(tree, "execute-exit");
  assert.equal(attr(exit, "data-exit"), "0");
  assert.ok(attr(exit, "className").includes("harness-execute-exit-ok"), "exit 0 is success-styled");
  assert.equal(textOf(findByTestId(tree, "execute-cwd")), "/r");
});

test("execute renderer surfaces a nonzero exit as an error-styled badge", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Bash", input: { command: "bad" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "command_output", stdout: "", stderr: "boom", exit: 1 } }),
  ]);
  const tree = render(s.items[0]);
  assert.ok(textOf(findByTestId(tree, "bash-result-stderr")).includes("boom"));
  const exit = findByTestId(tree, "execute-exit");
  assert.equal(attr(exit, "data-exit"), "1");
  assert.ok(attr(exit, "className").includes("harness-execute-exit-err"));
});

test("execute renderer shows streaming preview via tool.progress display (command_preview)", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Bash", input: { command: "npm test" } }),
    ev(EventType.ToolStarted, "x2", { callId: "c1" }),
    ev(EventType.ToolProgress, "x3", { callId: "c1", message: "running", display: { kind: "command_preview", fullText: "partial..." } }),
  ]);
  const tree = render(s.items[0]);
  assert.equal(textOf(findByTestId(tree, "bash-output-preview-full")), "partial...");
  assert.equal(attr(findByTestId(tree, "bash-output-preview-full"), "data-streaming"), "true");
});

test('event and direct Host previews preserve separate stdout/stderr without an exit claim', () => {
  const display = { kind: 'command_preview', stdout: 'phase=1\n', stderr: 'diagnostic=1\n' };
  const state = reduceAll(initialState(), [
    ev(EventType.TaskStarted, 'p0', { taskId: 'T' }),
    ev(EventType.ToolScheduled, 'p1', { callId: 'c1', name: 'run_command', input: { command: 'controlled' } }),
    ev(EventType.ToolStarted, 'p2', { callId: 'c1' }),
    ev(EventType.ToolProgress, 'p3', { callId: 'c1', display }),
  ]);
  for (const item of [state.items[0], { ...state.items[0], display }]) {
    const tree = render(item);
    assert.equal(textOf(findByTestId(tree, 'bash-output-preview-full')), 'phase=1\n');
    assert.equal(textOf(findByTestId(tree, 'bash-result-stderr')), 'diagnostic=1\n');
    assert.equal(findByTestId(tree, 'execute-exit'), null);
  }
});

test("execute output is ANSI-sanitized: escape sequences are stripped to plain text", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Bash", input: { command: "ls" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "command_output", stdout: "\x1b[31mfile\x1b[0m" } }),
  ]);
  const tree = render(s.items[0]);
  assert.equal(textOf(findByTestId(tree, "bash-result-output")), "file");
});

test("read renderer is a non-toggleable file chip; open-file action carries path/kind", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Read", input: { file_path: "src/a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_read", path: "src/a.ts", entryType: "file" } }),
  ]);
  const tree = render(s.items[0], { onOpenFile: () => {}, workspaceRoot: "/repo" });
  assert.equal(attr(tree, "data-renderer"), "read");
  assert.equal(attr(findByTestId(tree, "tool-details"), "data-static"), "true", "read is not toggleable");
  const chip = findByTestId(tree, "read-chip");
  assert.ok(chip, "file chip renders");
  assert.equal(attr(chip, "data-action"), "open-file");
  assert.equal(attr(chip, "data-path"), "src/a.ts");
  assert.equal(textOf(findByTestId(tree, "read-file-name")), "a.ts");
});

test("read renderer does not repeat the path three times: kind label, leaf chip, one path line", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Read", input: { file_path: "src/a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_read", path: "src/a.ts", entryType: "file" } }),
  ]);
  const tree = render(s.items[0], { workspaceRoot: "/repo" });
  const summary = findByTestId(tree, "tool-summary-static") || findByTestId(tree, "tool-toggle");
  const txt = textOf(summary);
  // The full workspace-relative path appears exactly once as text (not in the
  // kind label, not duplicated in a third line). The leaf appears once in the chip.
  const pathMatches = txt.match(/src\/a\.ts/g) || [];
  assert.equal(pathMatches.length, 1, "full path shown once, not three times");
  assert.equal(textOf(findByTestId(tree, "tool-title")), "Read", "kind label carries no path");
});

test("search renderer (Grep) shows a Find {query} summary, not a file path, and stays non-toggleable", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Grep", input: { pattern: "TODO", path: "src" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", result: "no hits" }),
  ]);
  const tree = render(s.items[0]);
  assert.equal(attr(tree, "data-renderer"), "read");
  assert.equal(attr(findByTestId(tree, "tool-details"), "data-static"), "true", "search is non-toggleable");
  assert.equal(textOf(findByTestId(tree, "tool-title")), "Search", "search kind label");
  assert.equal(textOf(findByTestId(tree, "search-primary")), "Find TODO", "primary text is the query, not a path");
  assert.equal(findByTestId(tree, "read-chip"), null, "no file chip for a content search");
});

test("list renderer (list_workspace_files) names the directory once after its kind", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "list_workspace_files", input: { cwd: "/repo/src" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", result: "a.ts\nb.ts" }),
  ]);
  const tree = render(s.items[0]);
  assert.equal(attr(tree, "data-renderer"), "read");
  assert.equal(textOf(findByTestId(tree, "tool-title")), "List", "list kind label distinguishes from search");
  assert.equal(textOf(findByTestId(tree, "search-primary")), "/repo/src", "directory listing names the cwd without repeating its kind");
});

test("a failed non-toggleable read preserves its redacted error reason inline (not hidden by a missing toggle)", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Read", input: { file_path: "missing.ts" } }),
    ev(EventType.ToolError, "x2", { callId: "c1", error: "enoent: token=secret" }),
  ]);
  const tree = render(s.items[0]);
  const err = findByTestId(tree, "tool-error");
  assert.ok(err, "failed read surfaces its error inline");
  assert.equal(attr(err, "role"), "alert");
  assert.ok(textOf(err).includes("enoent"), "error reason preserved");
  assert.ok(!textOf(err).includes("secret"), "secret redacted");
});

test("read rows do not add a redundant inspect button even when a diagnostic callback exists", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Read", input: { file_path: "a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_read", path: "a.ts" } }),
  ]);
  const tree = render(s.items[0], { onInspectTool() {} });
  assert.equal(findByTestId(tree, "tool-inspect"), null);
});

test("each renderer emits a vector kind icon (inline svg) in the summary row", () => {
  const icons = [
    ["Bash", { command: "x" }, "execute"],
    ["Read", { file_path: "a.ts" }, "read"],
    ["Grep", { pattern: "x" }, "read"],
    ["Edit", { file_path: "a.ts" }, "edit"],
    ["mcp__x", { q: 1 }, "default"],
  ];
  for (const [name, input] of icons) {
    const s = reduceAll(initialState(), [
      ev(EventType.TaskStarted, "t0", { taskId: "T" }),
      ev(EventType.ToolScheduled, "x1", { callId: "c1", name, input }),
      ev(EventType.ToolStarted, "x2", { callId: "c1" }),
    ]);
    const tree = render(s.items[0]);
    const svg = findBySvg(tree);
    assert.ok(svg, `${name} renders an inline svg kind icon`);
    assert.equal(svg.type, "svg");
  }
});

function findBySvg(node) {
  let found = null;
  (function walk(n) {
    if (found || n == null || n === false) return;
    if (typeof n !== "object") return;
    if (n.type === "svg") { found = n; return; }
    for (const c of n.children || []) walk(c);
  })(node);
  return found;
}

test("edit renderer shows file chips, +N/-N count, and an inline diff with real line numbers from the patch", () => {
  const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new";
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Edit", input: { file_path: "a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_diff", path: "a.ts", patch, changeStat: { added: 1, removed: 1 } } }),
  ]);
  const tree = render(s.items[0], { onOpenFile: () => {}, onRetrieveFullDiff: () => {} });
  assert.equal(attr(tree, "data-renderer"), "edit");
  const count = findByTestId(tree, "edit-diff-count");
  assert.ok(textOf(count).includes("+1"));
  assert.ok(textOf(count).includes("-1"));
  const diff = findByTestId(tree, "edit-diff");
  assert.ok(findByTestId(diff, "edit-diff-unified"), "unified view present");
  assert.ok(findByTestId(diff, "edit-diff-split"), "split view present");
  const oldLines = findAllByTestId(findByTestId(diff, "edit-diff-unified"), "edit-diff-old-line").map(n => textOf(n));
  assert.ok(oldLines.includes("1") && oldLines.includes("2"), "real old line numbers");
  assert.ok(findByTestId(diff, "edit-open-file"), "open-file action present");
  // Never infers a write succeeded from input alone: while running with no patch, no diff
  const running = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c2", name: "Edit", input: { file_path: "b.ts", new_string: "y" } }),
  ]);
  const rtree = render(running.items[0]);
  assert.equal(findByTestId(rtree, "edit-diff"), null, "no diff rendered before a result arrives");
});

test("edit renderer retrieves full diff via callback when the preview is truncated", () => {
  const big = "@@ -1 +1 @@\n" + Array.from({ length: 50 }, (_, i) => `+line${i}`).join("\n");
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "Edit", input: { file_path: "a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_diff", path: "a.ts", patch: big } }),
  ]);
  const tree = render(s.items[0], { onRetrieveFullDiff: () => {}, diffMaxLines: 5 });
  assert.ok(findByTestId(tree, "edit-diff-truncated"), "truncated marker shown");
  assert.ok(findByTestId(tree, "edit-show-full-diff"), "retrieve-full-diff action present");
});

test("default renderer keeps the bounded detail block for unknown/MCP tools and still renders a file_diff display", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "mcp__weather", input: { city: "London" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", result: { temp: 12 } }),
  ]);
  const tree = render(s.items[0], { workspaceRoot: null });
  assert.equal(attr(tree, "data-renderer"), "default");
  assert.ok(findByTestId(tree, "tool-detail"), "bounded detail block for unknown tool");
  assert.ok(findByTestId(tree, "tool-result"), "result preview for unknown tool");
});

test("default renderer surfaces a file_diff display even on an unknown tool name", () => {
  const s = reduceAll(initialState(), [
    ev(EventType.TaskStarted, "t0", { taskId: "T" }),
    ev(EventType.ToolScheduled, "x1", { callId: "c1", name: "custom_patch", input: { path: "a.ts" } }),
    ev(EventType.ToolResult, "x2", { callId: "c1", display: { kind: "file_diff", path: "a.ts", patch: "@@ -1 +1 @@\n-x\n+y" } }),
  ]);
  const tree = render(s.items[0]);
  assert.ok(findByTestId(tree, "edit-diff"), "file_diff display renders a diff regardless of tool name");
});
