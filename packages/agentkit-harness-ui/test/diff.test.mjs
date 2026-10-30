import test from "node:test";
import assert from "node:assert/strict";
import {
  countChangeStat, patchFilePath, inferOperationKind, parseDiffHunks, diffPreviewLines,
  MAX_DIFF_PREVIEW_LINES,
} from "../src/diff.mjs";

const PATCH = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 context line
-old line
+new line
+added line
 context2`;

test("countChangeStat counts added/removed lines, excluding headers and markers", () => {
  const stat = countChangeStat(PATCH);
  assert.deepEqual(stat, { added: 2, removed: 1 });
  assert.equal(countChangeStat(""), null);
  assert.equal(countChangeStat("--- a/x\n+++ b/x\n@@ -1 +1 @@\n ctx"), null, "no +/- body ⇒ null");
});

test("patchFilePath resolves from ---/+++ and diff --git headers, stripping a/ b/ prefixes", () => {
  assert.equal(patchFilePath(PATCH), "src/a.ts");
  assert.equal(patchFilePath("diff --git a/foo/bar.ts b/foo/bar.ts\n@@ -1 +1 @@\n+x"), "foo/bar.ts");
  assert.equal(patchFilePath(""), "");
  // tab-separated timestamp must be stripped
  assert.equal(patchFilePath("--- a/x.ts\t2024-01-01\n+++ b/x.ts\n@@\n+x"), "x.ts");
  assert.equal(patchFilePath("--- /dev/null\n+++ b/new.ts\n@@\n+x"), "new.ts");
});

test("inferOperationKind detects write/delete from ---/+++ /dev/null and explicit kinds", () => {
  assert.equal(inferOperationKind("write", null, ""), "write");
  assert.equal(inferOperationKind("delete", null, ""), "delete");
  assert.equal(inferOperationKind(null, "create", ""), "write");
  assert.equal(inferOperationKind(null, null, "--- /dev/null\n+++ b/x\n@@\n+x"), "write");
  assert.equal(inferOperationKind(null, null, "--- a/x\n+++ /dev/null\n@@\n-x"), "delete");
  assert.equal(inferOperationKind(null, null, "--- a/x\n+++ b/x\n@@\n-x\n+y"), "edit");
});

test("parseDiffHunks extracts REAL line numbers from @@ -oldStart,oldCount +newStart,newCount @@", () => {
  const parsed = parseDiffHunks(PATCH);
  assert.ok(parsed);
  assert.equal(parsed.path, "src/a.ts");
  assert.equal(parsed.added, 2);
  assert.equal(parsed.removed, 1);
  assert.equal(parsed.truncated, false);
  // Context at line 1, removed old line 2, added new line 2, added new line 3, context
  const oldLines = parsed.unified.map(l => l.oldLine);
  const newLines = parsed.unified.map(l => l.newLine);
  assert.deepEqual(oldLines, [1, 2, null, null, 3], "old gutter advances on context/removed; null on added");
  assert.deepEqual(newLines, [1, null, 2, 3, 4], "new gutter advances on context/added; null on removed");
  assert.equal(parsed.unified[1].text, "old line");
  assert.equal(parsed.unified[2].text, "new line");
  assert.equal(parsed.unified[1].marker, "-");
  assert.equal(parsed.unified[2].marker, "+");
});

test("parseDiffHunks produces a paired split view with blank filler rows", () => {
  const parsed = parseDiffHunks(PATCH);
  // Split: each row paired; added line occupies new col with blank old; removed occupies old with blank new
  const oldCount = parsed.split.old.length;
  const newCount = parsed.split.new.length;
  assert.equal(oldCount, newCount, "split columns are row-aligned");
  // The removed line carries an oldLine, blank newLine filler on the new side
  assert.ok(parsed.split.old.some(l => l.marker === "-" && l.oldLine === 2));
  assert.ok(parsed.split.new.some(l => l.marker === "+" && l.newLine === 2));
});

test("parseDiffHunks accepts a bare @@ hunk header with null line numbers", () => {
  const parsed = parseDiffHunks("@@\n ctx\n-old\n+new");
  assert.ok(parsed);
  assert.equal(parsed.unified[0].oldLine, null);
  assert.equal(parsed.unified[0].newLine, null);
});

test("parseDiffHunks truncates at maxLines and sets truncated", () => {
  const big = "@@ -1 +1 @@\n" + Array.from({ length: 50 }, (_, i) => `+line${i}`).join("\n");
  const parsed = parseDiffHunks(big, { maxLines: 5 });
  assert.ok(parsed.truncated);
  assert.equal(parsed.unified.length, 5);
});

test("parseDiffHunks bounds long lines with an ellipsis", () => {
  const longLine = "x".repeat(300);
  const parsed = parseDiffHunks(`@@ -1 +1 @@\n+${longLine}`, { maxLineChars: 20 });
  assert.ok(parsed.unified[0].text.endsWith("…"));
  assert.ok(parsed.unified[0].text.length <= 20);
});

test("diffPreviewLines returns the backward-compatible flat preview shape", () => {
  const preview = diffPreviewLines(PATCH);
  assert.ok(preview);
  assert.equal(preview.path, "src/a.ts");
  assert.ok(preview.lines.some(l => l.marker === "+" && l.text === "new line"));
  assert.equal(preview.truncated, false);
  assert.equal(diffPreviewLines(""), null);
});

test("parseDiffHunks returns null for a patch with no hunks (only headers)", () => {
  assert.equal(parseDiffHunks("--- a/x\n+++ b/x"), null);
  assert.equal(parseDiffHunks("not a diff at all"), null);
});

test("parseDiffHunks handles multi-hunk patches with independent line numbering", () => {
  const multi = `--- a/x
+++ b/x
@@ -5,2 +5,2 @@
 ctx
-old5
+new5
@@ -20,1 +21,1 @@
 ctx2
-old20
+new20`;
  const parsed = parseDiffHunks(multi);
  assert.ok(parsed);
  const removed = parsed.unified.filter(l => l.marker === "-");
  // @@ -5,2 +5,2 @@: ctx=old5, old5=old6; @@ -20,1 +21,1 @@: ctx2=old20, old20=old21
  assert.deepEqual(removed.map(l => l.oldLine), [6, 21], "each hunk numbers from its own header, advancing past context");
});

test('real content resembling file headers and high line numbers survive parsing without a phantom trailing line', () => {
  const patch='--- a/report.md\n+++ b/report.md\n@@ -10001,1 +10001,1 @@\n--- old heading\n+++ new heading\n';
  const result=parseDiffHunks(patch);
  assert.equal(result.unified.length,2);
  assert.equal(result.unified[0].oldLine,10001);
  assert.equal(result.unified[1].newLine,10001);
  assert.equal(result.unified[0].text,'-- old heading');
  assert.deepEqual(countChangeStat(patch),{added:1,removed:1});
});
