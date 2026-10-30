// @kingsoftcloud/agentkit-harness-ui — unified-diff parsing
//
// Pure patch parsing for the file-edit renderer. Extracts actual line numbers
// from `@@ -oldStart,oldCount +newStart,newCount @@` hunk headers (never
// synthesized), counts additions/deletions, and produces bounded unified and
// split representations with real gutter line numbers. The full patch is never
// rendered verbatim; a bounded preview is returned and the host retrieves the
// full diff via a callback when the user asks for it.
//
// No file is read and no write is inferred from input. This module only parses
// a patch string the host already supplied in a `tool.result` display payload.

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FILE_HEADER_RE = /^(?:diff --git a\/(\S+) b\/\S+|(?:---|\+\+\+) (?:a\/|b\/)?(.+))$/;

/** Maximum preview lines rendered inline before the host retrieves the full diff. */
export const MAX_DIFF_PREVIEW_LINES = 200;
/** Maximum hunk line number rendered; beyond this the gutter is blanked for safety. */
export const MAX_DIFF_LINE_NUMBER = Number.MAX_SAFE_INTEGER;

/**
 * Count added/removed lines in a patch. Hunk headers, file headers, and the
 * `\ No newline` marker are excluded. Returns null when the patch is empty.
 * @param {string} patch
 * @returns {{added: number, removed: number}|null}
 */
export function countChangeStat(patch) {
  const text = String(patch || "");
  if (!text) return null;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    if (raw.startsWith("@@")) { inHunk = true; continue; }
    if (raw.startsWith("diff --git ")) { inHunk = false; continue; }
    if (raw.startsWith("index ")) continue;
    if (!inHunk && (raw.startsWith("--- ") || raw.startsWith("+++ "))) continue;
    if (raw.startsWith("\\ ")) continue;
    if (raw.startsWith("+")) added += 1;
    else if (raw.startsWith("-")) removed += 1;
  }
  if (!added && !removed) return null;
  return { added, removed };
}

/**
 * Resolve the file path from a patch's `--- a/path` / `+++ b/path` or
 * `diff --git a/x b/x` headers. Returns "" when no header is present.
 * @param {string} patch
 * @returns {string}
 */
export function patchFilePath(patch) {
  const text = String(patch || "");
  if (!text) return "";
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git a/") && raw.includes(" b/")) {
      const rest = raw.slice("diff --git ".length);
      const aEnd = rest.indexOf(" b/");
      if (aEnd > 0) return rest.slice(2, aEnd);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      let p = raw.slice(4).trim();
      const tab = p.indexOf("\t");
      if (tab >= 0) p = p.slice(0, tab).trim();
      if (!p || p === "/dev/null") continue;
      if (p.startsWith("a/") || p.startsWith("b/")) p = p.slice(2);
      return p;
    }
  }
  return "";
}

/**
 * Infer the edit operation kind from an explicit `operationKind`, an
 * `actionLabel`, or the patch shape (`--- /dev/null` ⇒ write, `+++ /dev/null`
 * ⇒ delete). Falls back to "edit".
 * @param {string} [operationKind]
 * @param {string} [actionLabel]
 * @param {string} [patch]
 * @returns {"write"|"delete"|"edit"}
 */
export function inferOperationKind(operationKind, actionLabel, patch) {
  const op = String(operationKind || "").toLowerCase();
  if (op === "write" || op === "create") return "write";
  if (op === "delete" || op === "remove") return "delete";
  const label = String(actionLabel || "").toLowerCase();
  if (label === "write" || label === "create") return "write";
  if (label === "delete" || label === "remove") return "delete";
  const text = String(patch || "");
  if (text) {
    const hasNewNull = text.split("\n").some(l => l.startsWith("+++ /dev/null"));
    const hasOldNull = text.split("\n").some(l => l.startsWith("--- /dev/null"));
    if (hasNewNull && !hasOldNull) return "delete";
    if (hasOldNull && !hasNewNull) return "write";
  }
  return "edit";
}

/**
 * Parse a unified diff into bounded hunks carrying REAL line numbers derived
 * from the hunk headers (old side starts at oldStart, new side at newStart;
 * context/removed advance the old gutter, context/added advance the new
 * gutter). Returns both a unified interleaved list and a split pair so the
 * view can render either; the host chooses via options and CSS switches
 * responsively.
 *
 * @param {string} patch
 * @param {{maxLines?: number, maxLineChars?: number}} [opts]
 * @returns {{path: string, added: number, removed: number, truncated: boolean,
 *   unified: DiffLine[], split: {old: DiffLine[], new: DiffLine[]}}|null}
 *
 * @typedef {{marker: " " | "+" | "-", text: string, oldLine: number|null, newLine: number|null}} DiffLine
 */
export function parseDiffHunks(patch, opts = {}) {
  const text = String(patch || "");
  if (!text) return null;
  const maxLines = opts.maxLines && opts.maxLines > 0 ? Math.floor(opts.maxLines) : MAX_DIFF_PREVIEW_LINES;
  const maxChars = opts.maxLineChars && opts.maxLineChars > 0 ? Math.floor(opts.maxLineChars) : 200;
  const path = patchFilePath(text);
  const lines = text.split("\n");
  const unified = [];
  const splitOld = [];
  const splitNew = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let oldLine = null;
  let newLine = null;
  let inHunk = false;

  for (const raw of lines) {
    if (truncated) break;
    if (raw.startsWith("diff --git ") || raw.startsWith("index ")) continue;
    if (!inHunk && (raw.startsWith("--- ") || raw.startsWith("+++ "))) continue;
    const header = HUNK_HEADER_RE.exec(raw);
    if (header) {
      inHunk = true;
      oldLine = parseLineNumber(header[1], header[2]);
      newLine = parseLineNumber(header[3], header[4]);
      continue;
    }
    // A bare `@@` (no line ranges) is still a hunk header; the reference
    // accepts `line === "@@"` as a hunk start. Line numbers stay null.
    if (raw === "@@") { inHunk = true; oldLine = null; newLine = null; continue; }
    if (!inHunk || !raw || ![" ", "+", "-", "\\"].includes(raw[0])) continue;
    if (raw.startsWith("\\ ")) continue; // "\ No newline at end of file"
    const marker = raw.startsWith("+") ? "+" : raw.startsWith("-") ? "-" : " ";
    const body = raw.length ? raw.slice(1) : "";
    const lineText = truncateLine(body, maxChars);
    const entry = { marker, text: lineText, oldLine: null, newLine: null };
    if (marker === "+") {
      added += 1;
      entry.newLine = newLine;
      newLine = incLine(newLine);
    } else if (marker === "-") {
      removed += 1;
      entry.oldLine = oldLine;
      oldLine = incLine(oldLine);
    } else {
      entry.oldLine = oldLine;
      entry.newLine = newLine;
      oldLine = incLine(oldLine);
      newLine = incLine(newLine);
    }
    pushBounded(unified, entry, maxLines, () => { truncated = true; });
    pushSplit(splitOld, splitNew, entry, maxLines, () => { truncated = true; });
  }
  if (!unified.length) return null;
  return { path, added, removed, truncated, unified, split: { old: splitOld, new: splitNew } };
}

function parseLineNumber(start, count) {
  const s = Number.parseInt(start, 10);
  if (!Number.isSafeInteger(s) || s < 0) return null;
  // Real editors number from the start line; a 0-count hunk is a pure insertion
  // whose first body line is `start` (or `start+1` when start is 0). Match the
  // unified-diff convention: line numbers begin at `start`, clamped to >= 1.
  return Math.max(1, s);
}

function incLine(line) {
  if (line == null) return null;
  const next = line + 1;
  return next > MAX_DIFF_LINE_NUMBER ? null : next;
}

function truncateLine(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function pushBounded(list, entry, maxLines, markTruncated) {
  if (list.length >= maxLines) { markTruncated(); return; }
  list.push(entry);
}

function pushSplit(oldList, newList, entry, maxLines, markTruncated) {
  // Split view pairs old and new columns; a context line occupies both, an
  // added line only the new column, a removed line only the old column.
  if (entry.marker === "+") {
    if (newList.length >= maxLines) { markTruncated(); return; }
    newList.push(entry);
    if (oldList.length < maxLines) oldList.push(blankSplit(entry.oldLine));
  } else if (entry.marker === "-") {
    if (oldList.length >= maxLines) { markTruncated(); return; }
    oldList.push(entry);
    if (newList.length < maxLines) newList.push(blankSplit(entry.newLine));
  } else {
    if (oldList.length >= maxLines || newList.length >= maxLines) { markTruncated(); return; }
    oldList.push(entry);
    newList.push(entry);
  }
}

function blankSplit(line) {
  return { marker: " ", text: "", oldLine: line, newLine: line };
}

/**
 * Bounded backward-compat preview: a flat list of `{marker, text}` lines, the
 * shape the original `fileDiffPreview` returned. Kept so existing hosts and
 * tests that consume the simple preview still work.
 * @param {string} patch
 * @param {{maxLines?: number}} [opts]
 * @returns {{path: string, lines: {marker: string, text: string}[], truncated: boolean}|null}
 */
export function diffPreviewLines(patch, opts = {}) {
  const parsed = parseDiffHunks(patch, opts);
  if (!parsed) return null;
  return {
    path: parsed.path,
    lines: parsed.unified.map(l => ({ marker: l.marker, text: l.text })),
    truncated: parsed.truncated,
  };
}

export { patchFilePath as _patchFilePath };
