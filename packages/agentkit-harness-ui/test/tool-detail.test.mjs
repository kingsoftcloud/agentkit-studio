import test from "node:test";
import assert from "node:assert/strict";
import {
  toolTitle, toolDetailLines, workspaceRelative, fileDiffPreview, redactError, MAX_TOOL_DETAIL_LINES,
} from "../src/tool-detail.mjs";

test("Bash detail block shows command and cwd without an extra Tool prefix", () => {
  const rows = toolDetailLines("Bash", { command: "npm test", cwd: "packages/tui", timeout: 30000 });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  assert.equal(map.command, "npm test");
  assert.equal(map.cwd, "packages/tui");
  assert.equal(map.timeout, "30000");
  assert.equal(toolTitle("Bash", { command: "npm test" }), "Bash");
  assert.ok(!toolTitle("Bash", {}).startsWith("Tool"));
});

test("Read title is `Read <path>` and omits file_path as a detail line", () => {
  assert.equal(toolTitle("Read", { path: "src/foo.ts" }), "Read src/foo.ts");
  const rows = toolDetailLines("Read", { path: "src/foo.ts", offset: 10, limit: 20 });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  assert.equal(map.offset, "10");
  assert.equal(map.limit, "20");
  assert.equal(map.path, undefined, "path is in the title, not a detail line");
});

test("Read and Edit use workspace-relative inside root and absolute outside", () => {
  assert.equal(workspaceRelative("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(workspaceRelative("/repo", "/repo"), ".");
  assert.equal(workspaceRelative("/etc/passwd", "/repo"), "/etc/passwd");
  assert.equal(workspaceRelative("/repo/src/a.ts"), "/repo/src/a.ts");
  assert.equal(toolTitle("Edit", { file_path: "/repo/src/a.ts" }), "Edit /repo/src/a.ts");
});

test("Edit detail block omits file_path and replace_all (already in title/diff)", () => {
  const rows = toolDetailLines("Edit", { file_path: "a.ts", old_string: "x", new_string: "y", replace_all: true });
  assert.equal(rows.length, 0);
});

test("Grep shows pattern in title and audit fields in detail, capped to four lines", () => {
  assert.equal(toolTitle("Grep", { pattern: "TODO" }), "Grep TODO");
  const rows = toolDetailLines("Grep", { pattern: "TODO", path: "/repo/src", glob: "*.ts", output_mode: "content", type: "ts", extra: "z" });
  assert.ok(rows.length <= MAX_TOOL_DETAIL_LINES);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  assert.equal(map.glob, "*.ts");
  assert.equal(map.output_mode, "content");
});

test("Agent shows description and subagent_type", () => {
  const rows = toolDetailLines("Agent", { description: "search code", subagent_type: "Explore", background: true });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  assert.equal(map.description, "search code");
  assert.equal(map.subagent_type, "Explore");
  assert.equal(map.background, "true");
});

test("TodoWrite shows count and current in-progress item", () => {
  const rows = toolDetailLines("TodoWrite", { todos: [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" },
  ] });
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  assert.equal(map.todos, "3");
  assert.equal(map.in_progress, "b");
});

test("unknown/MCP tool gets a bounded redacted generic preview", () => {
  const rows = toolDetailLines("mcp_server_tool", { url: "https://x", api_key: "shh", command: "run" });
  assert.ok(rows.length <= MAX_TOOL_DETAIL_LINES);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  assert.equal(map.api_key, "[redacted]");
  assert.equal(map.url, "https://x");
});

test("scheduled input detail is reused on later result events (title stable across lifecycle)", () => {
  assert.equal(toolTitle("Read", { path: "a.ts" }), "Read a.ts");
  // the view computes title from input each render; the reducer keeps input on
  // the part so the title survives a result event that does not repeat input
  const rowsAfter = toolDetailLines("Read", { path: "a.ts", offset: 5 });
  const map = Object.fromEntries(rowsAfter.map(r => [r.key, r.value]));
  assert.equal(map.offset, "5");
});

test("fileDiffPreview renders bounded hunk lines with markers, skipping headers", () => {
  const diff = fileDiffPreview({ kind: "file_diff", path: "a.ts", patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n+more" });
  assert.equal(diff.path, "a.ts");
  assert.deepEqual(diff.lines.map(l => l.marker), [" ", "-", "+", "+"]);
  assert.deepEqual(diff.lines.map(l => l.text), ["ctx", "old", "new", "more"]);
  assert.equal(diff.truncated, false);
});

test("fileDiffPreview truncates long patches and returns null for non file_diff", () => {
  const diff = fileDiffPreview({ kind: "file_diff", path: "a.ts", patch: Array.from({ length: 20 }, (_, i) => `+line${i}`).join("\n") }, { maxLines: 4 });
  assert.equal(diff.lines.length, 4);
  assert.equal(diff.truncated, true);
  assert.equal(fileDiffPreview({ kind: "text", path: "a" }), null);
  assert.equal(fileDiffPreview(undefined), null);
});

test("redactError bounds the message and strips inline secrets", () => {
  const out = redactError("token=abc123 failed with api_key=xyz");
  assert.ok(out.includes("[redacted]"));
  assert.ok(!out.includes("abc123"));
  assert.ok(!out.includes("xyz"));
  const long = redactError("x".repeat(500), { maxChars: 50 });
  assert.ok(long.length <= 52);
});
