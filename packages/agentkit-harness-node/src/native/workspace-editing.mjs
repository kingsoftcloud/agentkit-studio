/**
 * Read-state reconciliation, edit matching and bounded diff evidence for the
 * Native Node workspace tools. Filesystem authorization and tool entry points
 * live in workspace-tools.mjs; this module holds the pure editing logic that
 * mirrors ksadk.toolsets.workspace_editing.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { sha256, TWO_MB } from './workspace-paths.mjs';
import { findEditMatch, normalizeLineEndings, normalizeReplacementForMatch, preserveQuoteStyle } from '@kingsoftcloud/agentkit-harness-core/edit-matchers';
/**
 * Python str.splitlines() boundaries, with \r\n consumed as a single split.
 * The character class is built from code points at runtime because \u2028 and
 * \u2029 are line terminators that Node's regex-literal grammar rejects even
 * as escapes, so a regex literal cannot express the full splitlines boundary
 * set.
 */
const SEPARATOR_CHARS = [0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029];
const CHAR_CLASS = '[' + SEPARATOR_CHARS.map((c) => String.fromCharCode(c)).join('') + ']';
const LINE_SPLIT = new RegExp('\\r\\n|' + CHAR_CLASS);
const LINE_SPLIT_KEEP = new RegExp('(' + '\\r\\n' + '|' + CHAR_CLASS + ')');
const LINE_SPLIT_END = new RegExp('(?:\\r\\n|' + CHAR_CLASS + ')$');

/** splitlines(keepends=False): drop the trailing empty that follows a final separator. */
export function splitlines(text) {
  if (text === '') return [];
  return splitKeepends(text).map(stripLineEnd);
}

/** splitlines(keepends=True): keep the separator with the preceding segment. */
export function splitKeepends(text) {
  if (text === '') return [];
  const parts = text.split(LINE_SPLIT_KEEP);
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    const sep = parts[i + 1] ?? '';
    if (i === parts.length - 1 && seg === '' && sep === '') continue;
    lines.push(seg + sep);
  }
  return lines;
}

function stripLineEnd(line) {
  return line.replace(LINE_SPLIT_END, '');
}

/**
 * Read a UTF-8 workspace file as raw text, bounded to 2MB. Returns
 * {text, error}; error is a result-shaped object on failure. Mirrors
 * _read_workspace_text, including the strict utf-8 rejection.
 */
export function readWorkspaceText(target) {
  let size;
  try {
    const info = statSync(target, { bigint: true });
    if (!info.isFile()) return { text: null, error: { ok: false, error_message: 'workspace file not found' } };
    size = Number(info.size);
  } catch (error) {
    if (error.code === 'ENOENT') return { text: null, error: { ok: false, error_message: 'workspace file not found' } };
    return { text: null, error: { ok: false, error_message: 'workspace file not found' } };
  }
  if (size > TWO_MB) return { text: null, error: { ok: false, error_message: 'file is larger than 2MB' } };
  let payload;
  try {
    const fd = openSync(target, 'r');
    try {
      const buf = Buffer.alloc(TWO_MB + 1);
      const n = readSync(fd, buf, 0, TWO_MB + 1, null);
      payload = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: null, error: { ok: false, error_message: 'workspace file read failed' } };
  }
  if (payload.length > TWO_MB) return { text: null, error: { ok: false, error_message: 'file is larger than 2MB' } };
  let text;
  try {
    // Python's payload.decode('utf-8') is strict and keeps a BOM; reproduce
    // that with a fatal TextDecoder that does not strip the BOM.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
  } catch {
    return { text: null, error: { ok: false, error_message: 'file is not utf-8 text' } };
  }
  return { text, error: null };
}

/**
 * Validate that an observed read state still matches the file on disk. Returns
 * null when valid, or a result-shaped error. Mirrors _validate_read_state:
 * a missing/partial-omitted state is file_not_read; a changed mtime, size or
 * content digest is file_modified_since_read.
 */
export function validateReadState(target, relative, { state, content = null }) {
  if (!state || state.canonicalPath !== target || !state.contentSha256) {
    return {
      ok: false,
      path: relative,
      error_type: 'file_not_read',
      error_message: 'file must be read before editing',
      suggested_action: `Call read_workspace_file(path=${quote(relative)}) before editing.`,
    };
  }
  let stat = null;
  try {
    stat = statSync(target, { bigint: true });
  } catch { /* missing below */ }
  if (
    stat === null
    || stat.mtimeNs !== state.mtimeNs
    || Number(stat.size) !== state.sizeBytes
    || (content !== null && sha256(Buffer.from(content, 'utf-8')) !== state.contentSha256)
  ) {
    return {
      ok: false,
      path: relative,
      error_type: 'file_modified_since_read',
      error_message: 'workspace file changed since last read',
      suggested_action: `Re-read the file with read_workspace_file(path=${quote(relative)}) and retry.`,
    };
  }
  return null;
}

export function validateSingleEditRequest(oldText, relative) {
  if (!String(oldText ?? '')) {
    return {
      ok: false,
      path: relative,
      error_type: 'missing_old_text',
      error_message: 'old_text is required',
    };
  }
  return null;
}

const QUOTE_MAP = { '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '‚': "'" };
const SMART_TO_ASCII = { '"': '“', "'": '‘' };

export function normalizeQuotes(value) {
  return value.replace(/[“”„‘’‚]/g, (ch) => QUOTE_MAP[ch]);
}

/**
 * Find the actual occurrence of old in text, tolerating smart/straight quote
 * substitution. Returns {actual, usedQuoteNormalization}. Mirrors
 * _find_actual_string: exact match first, then normalized, then sliced.
 */
export function findActualString(text, old) {
  if (text.includes(old)) return { actual: old, usedQuoteNormalization: false };
  const normalizedOld = normalizeQuotes(old);
  const candidates = new Set([normalizedOld, old.replace(/["']/g, (ch) => SMART_TO_ASCII[ch] ?? ch)]);
  for (const candidate of candidates) {
    if (candidate && text.includes(candidate)) return { actual: candidate, usedQuoteNormalization: true };
  }
  const normalizedText = normalizeQuotes(text);
  const index = normalizedText.indexOf(normalizedOld);
  if (index < 0) return { actual: null, usedQuoteNormalization: false };
  return { actual: text.slice(index, index + old.length), usedQuoteNormalization: true };
}

export function matchPreviews(text, needle, limit = 20) {
  if (!needle) return [];
  const matches = [];
  const lines = splitlines(text);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      matches.push({ line: i + 1, text: lines[i].trim(), snippet: lines[i] });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

export function nearbyCandidates(text, old, limit = 5) {
  const oldNorm = normalizeQuotes(old).trim();
  const candidates = [];
  const lines = splitlines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNorm = normalizeQuotes(line).trim();
    const ratio = similarityRatio(oldNorm, lineNorm);
    const prefix = oldNorm.slice(0, Math.max(1, Math.min(4, oldNorm.length)));
    if (oldNorm && (lineNorm.includes(prefix) || ratio > 0.45)) {
      candidates.push({ line: i + 1, text: line.trim(), snippet: line, score: Math.round(ratio * 1000) / 1000 });
    }
  }
  candidates.sort((a, b) => (b.score - a.score) || (a.line - b.line));
  return candidates.slice(0, limit);
}

/** difflib.SequenceMatcher.ratio() approximation: 2*M/(len(a)+len(b)). */
function similarityRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const matches = lcsLength(a, b);
  return (2 * matches) / (a.length + b.length);
}

function lcsLength(a, b) {
  if (a.length < b.length) [a, b] = [b, a];
  const m = a.length, n = b.length;
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n];
}

/**
 * Apply one exact-text edit. Matches LF/CRLF snippets against the file's
 * prevailing line ending without converting unrelated bytes. Mirrors
 * _apply_single_edit, including expected_replacements/replace_all semantics.
 */
export function applySingleEdit(text, oldText, newText, { expectedReplacements = 1, replaceAll = false, relative }) {
  const requestError = validateSingleEditRequest(oldText, relative);
  if (requestError) return requestError;
  const ending = text.includes('\r\n') ? '\r\n' : '\n';
  const old = String(oldText).replace(/\r\n/g, '\n').replace(/\n/g, ending);
  const replacement = String(newText ?? '').replace(/\r\n/g, '\n').replace(/\n/g, ending);
  const expected = Math.max(1, Number(expectedReplacements || 1));
  const { actual, usedQuoteNormalization } = findActualString(text, old);
  const matches = actual ? matchPreviews(text, actual) : [];
  const occurrences = actual ? countOccurrences(text, actual) : 0;
  if (occurrences === 0) {
    return {
      ok: false,
      path: relative,
      error_type: 'snippet_not_found',
      error_message: 'old_text was not found in the workspace file',
      occurrences: 0,
      nearby_candidates: nearbyCandidates(text, old),
      suggested_action: 'Use one nearby candidate as old_text, or call read_workspace_file with line numbers and retry.',
    };
  }
  if (actual === null) {
    return { ok: false, path: relative, error_type: 'snippet_not_found', error_message: 'old_text was not found in the workspace file' };
  }
  if (!replaceAll && occurrences !== expected) {
    return {
      ok: false,
      path: relative,
      error_type: 'ambiguous_edit',
      error_message: `old_text matched ${occurrences} occurrences, expected ${expected}`,
      occurrences,
      expected_replacements: expected,
      matches,
      suggested_action: 'Provide a larger unique old_text snippet, set expected_replacements, or use replace_all=true.',
    };
  }
  const replacements = replaceAll ? occurrences : expected;
  return {
    ok: true,
    updated: replaceFirst(text, actual, replacement, replacements),
    replacements,
    used_quote_normalization: usedQuoteNormalization,
    matches,
  };
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while ((from = text.indexOf(needle, from)) !== -1) { count++; from += needle.length; }
  return count;
}

/** Pure reference matching; called in the bounded worker, never with file authority. */
export function applyZcodeEdit(text, oldText, newText, { expectedReplacements = 1, replaceAll = false, relative }) {
  const invalid = validateSingleEditRequest(oldText, relative);
  if (invalid) return invalid;
  if (oldText === newText) return { ok: false, path: relative, error_type: 'no_change', error_message: 'old_text and new_text are identical' };
  const content = normalizeLineEndings(text), search = normalizeLineEndings(oldText);
  const match = findEditMatch({ content, search, replaceAll });
  if (match.status === 'not_found') return { ok: false, path: relative, error_type: 'snippet_not_found',
    error_message: 'old_text was not found in the workspace file', occurrences: 0,
    nearby_candidates: nearbyCandidates(content, search), suggested_action: 'Read the current file and provide a unique old_text snippet.' };
  if (match.status === 'ambiguous') return { ok: false, path: relative, error_type: 'ambiguous_edit',
    error_message: 'Normalized old_text matches different file fragments. Provide a larger unique snippet.',
    occurrences: match.candidateCount, match_strategy: match.strategy, suggested_action: 'Read the current file and use a unique exact snippet.' };
  const occurrences = countOccurrences(content, match.actualString), expected = Math.max(1, Number(expectedReplacements || 1));
  if (!replaceAll && occurrences !== expected) return { ok: false, path: relative, error_type: 'ambiguous_edit',
    error_message: `old_text matched ${occurrences} occurrences, expected ${expected}`, occurrences,
    expected_replacements: expected, matches: matchPreviews(content, match.actualString), match_strategy: match.strategy,
    suggested_action: 'Provide a larger unique snippet or use replace_all=true.' };
  const replacement = preserveQuoteStyle(search, match.actualString,
    normalizeReplacementForMatch(match.strategy, normalizeLineEndings(newText)));
  const ending = text.includes('\r\n') ? '\r\n' : '\n';
  // Match normalized LF across the original bytes, preserving all untouched
  // line endings. A callback keeps replacement $ sequences literal.
  const actualSearch = replacement === '' && !match.actualString.endsWith('\n') && content.includes(`${match.actualString}\n`)
    ? `${match.actualString}\n` : match.actualString;
  const pattern = actualSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split('\n').join('\\r?\\n');
  let remaining = replaceAll ? occurrences : expected, replacements = 0;
  const updated = text.replace(new RegExp(pattern, 'g'), actual => {
    if (remaining-- <= 0) return actual;
    replacements++; return replacement.replaceAll('\n', ending);
  });
  return { ok: true, updated, replacements,
    used_quote_normalization: match.strategy === 'quote_normalized', match_strategy: match.strategy,
    match_candidate_count: match.candidateCount, matches: matchPreviews(content, match.actualString) };
}

function replaceFirst(text, needle, replacement, count) {
  let result = '';
  let from = 0;
  let replaced = 0;
  while (replaced < count) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    result += text.slice(from, idx) + replacement;
    from = idx + needle.length;
    replaced++;
  }
  result += text.slice(from);
  return result;
}

/** Locate the changed middle: shared prefix and suffix line runs. */
export function changedMiddle(before, after) {
  const oldLines = splitKeepends(before);
  const newLines = splitKeepends(after);
  let first = 0;
  while (first < Math.min(oldLines.length, newLines.length) && oldLines[first] === newLines[first]) first++;
  let endOld = oldLines.length, endNew = newLines.length;
  while (endOld > first && endNew > first && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
  return { oldLines, newLines, first, endOld, endNew };
}

/** LCS-based opcodes over two line arrays: equal/replace/insert/delete. */
export function lineDiffOpcodes(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      const start = i;
      while (i < n && j < m && a[i] === b[j]) { i++; j++; }
      ops.push({ tag: 'equal', aStart: start, aEnd: i, bStart: start, bEnd: j });
    } else {
      const aS = i, bS = j;
      while (i < n && j < m && a[i] !== b[j]) {
        if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
      }
      if (i > aS && j > bS) ops.push({ tag: 'replace', aStart: aS, aEnd: i, bStart: bS, bEnd: j });
      else if (i > aS) ops.push({ tag: 'delete', aStart: aS, aEnd: i, bStart: bS, bEnd: bS });
      else ops.push({ tag: 'insert', aStart: aS, aEnd: aS, bStart: bS, bEnd: j });
    }
  }
  if (i < n) ops.push({ tag: 'delete', aStart: i, aEnd: n, bStart: m, bEnd: m });
  if (j < m) ops.push({ tag: 'insert', aStart: n, aEnd: n, bStart: j, bEnd: m });
  return ops;
}

export function changeCounts(before, after) {
  const { oldLines, newLines, first, endOld, endNew } = changedMiddle(before, after);
  if ((endOld - first) * (endNew - first) > 1_000_000) {
    return { diff_additions: endNew - first, diff_deletions: endOld - first };
  }
  const ops = lineDiffOpcodes(oldLines.slice(first, endOld), newLines.slice(first, endNew));
  let additions = 0, deletions = 0;
  for (const op of ops) {
    if (op.tag === 'equal') continue;
    additions += op.bEnd - op.bStart;
    deletions += op.aEnd - op.aStart;
  }
  return { diff_additions: additions, diff_deletions: deletions };
}

/** Unified-diff hunk header range, matching difflib._format_range_unified. */
function formatRange(start, length) {
  const beginning = start + 1;
  if (length === 1) return `${beginning}`;
  if (length === 0) return `${beginning - 1},0`;
  return `${beginning},${length}`;
}

export function buildDiff(relative, before, after) {
  const { oldLines, newLines, first, endOld, endNew } = changedMiddle(before, after);
  if (first === endOld && first === endNew) return '';
  if ((endOld - first) * (endNew - first) > 1_000_000) {
    return bulkMiddleHunk(relative, oldLines, newLines, first, endOld, endNew);
  }
  return singleHunk(relative, oldLines, newLines, first, endOld, endNew, 3);
}

/** Fast path for a huge changed middle: emit the whole span as one hunk. */
function bulkMiddleHunk(relative, oldLines, newLines, first, endOld, endNew) {
  let diff = `--- ${relative} before\n+++ ${relative} after\n`;
  diff += `@@ -${formatRange(first, endOld - first)} +${formatRange(first, endNew - first)} @@\n`;
  for (let k = first; k < endOld; k++) diff += '-' + oldLines[k];
  for (let k = first; k < endNew; k++) diff += '+' + newLines[k];
  return diff;
}

/** One unified-diff hunk over the changed middle with optional context lines. */
function singleHunk(relative, oldLines, newLines, first, endOld, endNew, context) {
  const ops = lineDiffOpcodes(oldLines.slice(first, endOld), newLines.slice(first, endNew));
  const beforeStart = Math.max(0, first - context);
  const afterEnd = Math.min(oldLines.length, endOld + context);
  const body = [];
  for (let k = beforeStart; k < first; k++) body.push(' ' + oldLines[k]);
  for (const op of ops) {
    if (op.tag === 'equal') {
      for (let k = op.aStart; k < op.aEnd; k++) body.push(' ' + oldLines[first + k]);
    } else {
      if (op.tag === 'replace' || op.tag === 'delete') {
        for (let k = op.aStart; k < op.aEnd; k++) body.push('-' + oldLines[first + k]);
      }
      if (op.tag === 'replace' || op.tag === 'insert') {
        for (let k = op.bStart; k < op.bEnd; k++) body.push('+' + newLines[first + k]);
      }
    }
  }
  for (let k = endOld; k < afterEnd; k++) body.push(' ' + oldLines[k]);
  const aStart = beforeStart;
  const aLen = afterEnd - beforeStart;
  const bStart = beforeStart; // the context prefix is equal in both files
  const bAfterEnd = Math.min(newLines.length, endNew + context);
  const bLen = bAfterEnd - beforeStart;
  let diff = `--- ${relative} before\n+++ ${relative} after\n`;
  diff += `@@ -${formatRange(aStart, aLen)} +${formatRange(bStart, bLen)} @@\n`;
  diff += body.join('');
  return diff;
}

export function diffLineCount(diff) {
  let count = 0;
  for (let i = 0; i < diff.length; i++) if (diff[i] === '\n') count++;
  return count;
}

function quote(value) {
  return `'${value}'`;
}
