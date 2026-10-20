/**
 * Native Node workspace tools for the AgentKit Harness.
 *
 * Exports createNativeWorkspaceTools({workspaceRoot, stateDir, sessionId,
 * authorize}) -> {definitions, execute, observe}. `definitions` is the complete
 * ToolDefinition[] for the ten formal workspace tools ported from
 * ksadk.toolsets.workspace. `execute` runs a ToolRequest and returns a
 * ToolResult; `observe` returns a WorkspaceObservation over the workspace root.
 *
 * Faithful to the Python semantics that matter to the model and the safety
 * boundary: pagination and content limits, read-after-modify and stale-read
 * rejection, symlink/path-escape protection, atomic writes, cancellation and
 * explicit errors. Host-owned concerns (effect intent/receipt, artifact
 * persistence, source-read budget, diagnostics overlay, definition digest) are
 * deliberately not reimplemented here. Nothing launches Python; capabilities
 * the Node port cannot honestly provide (e.g. python AST lint) are reported
 * explicitly rather than faked as successful.
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, readSync, realpathSync, rmdirSync, statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  WorkspacePathError, escapeRegex, fnmatch, publishWorkspaceBytes, sha256,
  TWO_MB, resolveWorkspacePath, workspaceRelative,
} from './workspace-paths.mjs';
import {
  applySingleEdit, buildDiff, changeCounts, diffLineCount, readWorkspaceText,
  splitlines, validateReadState, validateSingleEditRequest,
} from './workspace-editing.mjs';
import {
  WorkspaceStateStore, argumentsDigest, makeReadState,
} from './workspace-state.mjs';

const MUTATING = new Set([
  'write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
  'multi_edit_workspace_file', 'delete_workspace_file',
]);

const READ_ONLY = new Set([
  'workspace_status', 'list_workspace_files', 'read_workspace_file',
  'lint_workspace_file', 'search_workspace_files',
]);

const OBSERVE_MAX_ENTRIES = 2048;
const OBSERVE_MAX_HASHED = 64 * 1024 * 1024;

class CaptureError extends Error {
  constructor(reason) { super(reason); this.code = reason; this.name = 'CaptureError'; }
}

/** Raised when the workspace root symlink is swapped to point outside its
 *  creation-time boundary. Pinned at factory construction; never re-resolved. */
class RootBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RootBoundaryError';
    this.code = 'workspace_root_changed';
  }
}

export function createNativeWorkspaceTools({
  workspaceRoot, stateDir, sessionId, authorize,
} = {}) {
  if (!workspaceRoot) throw new TypeError('createNativeWorkspaceTools requires workspaceRoot');
  if (!stateDir) throw new TypeError('createNativeWorkspaceTools requires stateDir');
  const root = workspaceRoot;
  const store = new WorkspaceStateStore(stateDir, sessionId);
  const authorizeFn = authorize || defaultAuthorize;

  // Pin the authorized root boundary at factory creation. The caller passes a
  // trusted workspaceRoot; resolving its realpath once here establishes the
  // directory this port is allowed to touch. We never re-resolve `root` later,
  // so swapping the root path (or a parent) for a symlink that points outside
  // cannot widen the boundary mid-life: execute and observe compare the live
  // realpath against this pinned value and refuse on mismatch.
  const pinnedRootReal = resolvePinnedRoot(root);

  function resolvePinnedRoot(r) {
    // If the root exists, lock its realpath. If not yet created, lock the
    // lexical path so it can be created later but is still boundary-checked.
    try {
      if (existsSync(r)) {
        const real = realpathSync(r);
        if (!lstatSync(r).isSymbolicLink()) return real;
        // A symlinked root at creation is allowed but pinned to its target;
        // a later swap to a different target is rejected by checkRootBoundary.
        return real;
      }
    } catch { /* fall through to lexical */ }
    return r;
  }

  function checkRootBoundary() {
    // The live root must still resolve to the same real path it was pinned to.
    // A symlink swap (or a parent rewrite) that changes the realpath is refused
    // for both execute and observe, regardless of authorization outcome.
    if (!existsSync(root)) {
      const err = new RootBoundaryError('workspace root no longer exists');
      err.code = 'workspace_missing';
      throw err;
    }
    let live;
    try { live = realpathSync(root); }
    catch {
      const err = new RootBoundaryError('workspace root is not resolvable');
      err.code = 'workspace_missing';
      throw err;
    }
    if (live !== pinnedRootReal) {
      throw new RootBoundaryError('workspace root was replaced or repointed');
    }
  }


  function resolvePath(relativePath) {
    return resolveWorkspacePath(root, pinnedRootReal, relativePath);
  }

  function relativeOf(target) {
    return workspaceRelative(pinnedRootReal, target);
  }

  // ---- tool implementations -------------------------------------------------

  function workspaceStatus() {
    const real = pinnedRootReal;
    mkdirSync(real, { recursive: true });
    const all = [];
    collectFiles(real, '', all);
    all.sort();
    const files = all.slice(0, 50).map((rel) => {
      let size = 0;
      try { size = Number(lstatSync(join(real, rel), { bigint: true }).size); } catch { /* gone */ }
      return { path: rel, size };
    });
    return { ok: true, workspace_root: real, file_count_sampled: files.length, files };
  }

  function collectFiles(base, rel, out) {
    let dirents;
    try { dirents = readdirSync(rel ? join(base, rel) : base, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      const entryRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory() && !d.isSymbolicLink()) {
        collectFiles(base, entryRel, out);
      } else if (d.isFile()) {
        out.push(entryRel);
      }
    }
  }

  function listWorkspaceFiles(args) {
    const path = String(args.path ?? '.');
    const glob = args.glob ?? null;
    const recursive = Boolean(args.recursive);
    const includeDirs = args.include_dirs !== false;
    const maxResults = Number(args.max_results ?? 500);
    const sortBy = String(args.sort_by ?? 'name').trim().toLowerCase();
    const target = resolvePath(path);
    if (!existsSync(target)) return { ok: false, error_message: `workspace path not found: ${path}` };
    const items = []; // {abs, name}
    const targetInfo = lstatSync(target, { bigint: true });
    if (targetInfo.isFile()) {
      items.push({ abs: target, name: target.split('/').pop() });
    } else if (targetInfo.isDirectory()) {
      const stack = [target];
      while (stack.length) {
        const cur = stack.pop();
        let dirents;
        try { dirents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of dirents) {
          const abs = join(cur, d.name);
          items.push({ abs, name: d.name });
          if (recursive && d.isDirectory() && !d.isSymbolicLink()) stack.push(abs);
        }
      }
    }
    let filtered = items;
    if (glob) {
      filtered = items.filter((it) => {
        const rel = relativeOf(it.abs);
        return fnmatch(rel, glob) || fnmatch(it.name, glob);
      });
    }
    const enriched = filtered.map((it) => {
      let info = null;
      try { info = lstatSync(it.abs, { bigint: true }); } catch { /* gone */ }
      const isDir = info ? info.isDirectory() : false;
      const isFile = info ? info.isFile() : false;
      return {
        rel: relativeOf(it.abs),
        name: it.name,
        isFile,
        isDir,
        size: isFile && info ? Number(info.size) : 0,
        mtimeNs: info ? info.mtimeNs : 0n,
      };
    });
    let visible = enriched;
    if (!includeDirs) visible = enriched.filter((e) => e.isFile);
    sortEntries(visible, sortBy);
    const limit = Math.max(1, Math.min(maxResults || 500, 5000));
    const sliced = visible.slice(0, limit);
    const entries = sliced.map((e) => ({
      name: e.name,
      path: e.rel,
      type: e.isDir ? 'directory' : 'file',
      size: e.size,
      mtime_ns: Number(e.mtimeNs),
    }));
    return {
      ok: true,
      path,
      recursive,
      entries,
      truncated: visible.length > entries.length,
    };
  }

  function sortEntries(entries, sortBy) {
    if (sortBy === 'mtime') {
      entries.sort((a, b) => (a.mtimeNs < b.mtimeNs ? -1 : a.mtimeNs > b.mtimeNs ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    } else if (sortBy === 'size') {
      entries.sort((a, b) => (a.size - b.size) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    } else {
      entries.sort((a, b) => {
        const ka = a.rel.toLowerCase();
        const kb = b.rel.toLowerCase();
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return (a.isFile === b.isFile) ? 0 : a.isFile ? 1 : -1;
      });
    }
  }

  function readWorkspaceFile(args) {
    const path = String(args.path ?? '');
    const includeLineNumbers = args.include_line_numbers !== false;
    const target = resolvePath(path);
    let stat;
    try { stat = statSync(target, { bigint: true }); } catch {
      return { ok: false, error_message: `workspace file not found: ${path}` };
    }
    if (!stat.isFile()) return { ok: false, error_message: `workspace file not found: ${path}` };
    if (Number(stat.size) > TWO_MB) return { ok: false, error_message: 'file is larger than 2MB' };
    const { text, error } = readWorkspaceText(target);
    if (error) return { ...error, path };
    const lines = splitlines(text);
    const totalLines = lines.length;
    const start = Math.max(1, Number(args.start_line ?? 1));
    const end = totalLines ? Math.min(totalLines, Number(args.end_line ?? totalLines)) : 0;
    if (end && start > end) {
      const rel = relativeOf(target);
      return {
        ok: false,
        error_message: 'start_line must be <= end_line',
        path: rel,
        requested_range: { start, end: args.end_line },
        total_lines: totalLines,
        suggested_action: `Re-read the current file with read_workspace_file(path='${rel}', start_line=${Math.max(1, Math.min(start, totalLines))}) before editing.`,
      };
    }
    const selected = totalLines ? lines.slice(start - 1, end) : [];
    const content = selected.map((line, i) => includeLineNumbers ? `${start + i} | ${line}` : line).join('\n');
    const limit = Math.max(1000, Math.min(Number(args.max_chars ?? 20000), 100000));
    let returnedEnd = end;
    let returnedCount = selected.length;
    let partial = start !== 1 || end !== totalLines;
    let previewChars = content.length;
    let truncated = false;
    let window = {};
    let visible = content;
    if (content.length > limit) {
      const preview = content.slice(0, limit);
      const complete = preview.length > 0 && content[limit] === '\n';
      const boundary = preview.lastIndexOf('\n');
      if (complete) {
        returnedCount = preview.split('\n').length;
      } else if (boundary >= 0) {
        returnedCount = preview.slice(0, boundary).split('\n').length;
      } else {
        returnedCount = 0;
      }
      visible = complete ? preview : (returnedCount ? preview.slice(0, boundary) : '');
      returnedEnd = returnedCount ? start + returnedCount - 1 : null;
      previewChars = visible.length;
      truncated = true;
      partial = true;
      window = {
        source_read_range: { start, end },
        next_start_line: returnedCount ? returnedEnd + 1 : null,
        suggested_action: returnedCount
          ? `Continue with read_workspace_file(path='${relativeOf(target)}', start_line=${returnedEnd + 1}); the remaining lines were not returned.`
          : 'A source line exceeds the output window. Use bound search or another permitted inspection tool; the unread remainder cannot be skipped.',
      };
      if (!returnedCount) window.partial_line = start;
    }
    const rel = relativeOf(target);
    store.recordReadState(makeReadState({
      path: rel,
      mtimeNs: stat.mtimeNs,
      sizeBytes: Number(stat.size),
      startLine: start,
      endLine: returnedEnd !== null ? returnedEnd : start,
      totalLines,
      partial,
      canonicalPath: target,
      contentSha256: sha256(Buffer.from(text, 'utf-8')),
    }));
    return {
      ok: true,
      path: rel,
      size: Number(stat.size),
      size_bytes: Number(stat.size),
      mtime_ns: Number(stat.mtimeNs),
      start_line: start,
      end_line: returnedEnd,
      line_count: returnedCount,
      read_range: returnedEnd !== null ? { start, end: returnedEnd } : null,
      total_lines: totalLines,
      suggested_action: '',
      partial,
      content: visible,
      preview_chars: previewChars,
      truncated,
      ...window,
    };
  }

  function writePrecondition(path, overwrite) {
    const target = resolvePath(path);
    const rel = relativeOf(target);
    if (!existsSync(target)) return { target, rel, error: null, previous: '' };
    if (!overwrite) {
      return { target, rel, error: { ok: false, path: rel, error_type: 'file_exists', error_message: `workspace file already exists: ${path}` }, previous: '' };
    }
    const { text: current, error } = readWorkspaceText(target);
    if (error) return { target, rel, error: { ...error, path: rel }, previous: '' };
    const state = store.getReadState(rel);
    if (state && state.partial) {
      return {
        target, rel, previous: '',
        error: {
          ok: false, path: rel, error_type: 'file_not_fully_read',
          error_message: 'existing file must be read completely before overwriting',
          suggested_action: `Call read_workspace_file(path='${rel}') without a line range, then retry.`,
        },
      };
    }
    let validation = validateReadState(target, rel, { state, content: current });
    if (validation && validation.error_type === 'file_not_read') {
      validation = {
        ...validation,
        error_message: 'existing file must be read before overwriting',
        suggested_action: `Call read_workspace_file(path='${rel}') before overwriting it.`,
      };
    }
    if (validation) return { target, rel, error: validation, previous: '' };
    return { target, rel, error: null, previous: current };
  }

  function writeWorkspaceFile(args) {
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');
    const overwrite = args.overwrite !== false;
    const target = resolvePath(path);
    const createOnly = !existsSync(target);
    const { target: t, rel, error, previous } = writePrecondition(path, overwrite);
    if (error) return error;
    try {
      publishWorkspaceBytes(t, Buffer.from(content, 'utf-8'), { createOnly });
    } catch (e) {
      if (e.code === 'EEXIST') {
        return { ok: false, path: rel, error_type: 'file_exists', error_message: 'workspace file was created before publication', suggested_action: 'Read the new file before proposing an overwrite.' };
      }
      return { ok: false, path: rel, error_type: 'publish_failed', error_message: e.message };
    }
    const stat = statSync(t, { bigint: true });
    refreshReadState(rel, stat, content, t);
    return { ok: true, path: rel, absolute_path: t, size: Number(stat.size), ...changeCounts(previous, content) };
  }

  function writeWorkspaceFiles(args) {
    const files = args.files;
    const overwrite = args.overwrite !== false;
    if (!Array.isArray(files) || !files.length) return { ok: false, error_message: 'files must be a non-empty list' };
    const prepared = [];
    for (const item of files.slice(0, 100)) {
      if (!item || typeof item !== 'object') return { ok: false, error_message: 'each file item must be an object' };
      const p = String(item.path ?? '').trim();
      if (!p) return { ok: false, error_message: 'each file item requires path' };
      prepared.push({ path: p, content: String(item.content ?? '') });
    }
    for (const { path } of prepared) {
      const { error } = writePrecondition(path, overwrite);
      if (error) return error;
    }
    const written = [];
    for (const { path, content } of prepared) {
      const result = writeWorkspaceFile({ path, content, overwrite });
      if (!result.ok) return result;
      written.push({
        path: result.path,
        size: result.size,
        diff_additions: result.diff_additions,
        diff_deletions: result.diff_deletions,
      });
    }
    return { ok: true, written, truncated: files.length > written.length };
  }

  function editWorkspaceFile(args) {
    const path = String(args.path ?? '');
    const oldText = args.old_text;
    const newText = args.new_text;
    const expectedReplacements = Number(args.expected_replacements ?? 1);
    const replaceAll = Boolean(args.replace_all);
    const target = resolvePath(path);
    const rel = relativeOf(target);
    const requestError = validateSingleEditRequest(oldText, rel);
    if (requestError) return requestError;
    const observed = store.getReadState(rel);
    const pinned = observed ? { ...observed } : null;
    let readError = validateReadState(target, rel, { state: pinned });
    if (readError) return readError;
    const { text, error } = readWorkspaceText(target);
    if (error) return { ...error, path };
    if (text === null) return { ok: false, path, error_message: 'workspace file read failed' };
    readError = validateReadState(target, rel, { state: pinned, content: text });
    if (readError) return readError;
    const editResult = applySingleEdit(text, oldText, newText, { expectedReplacements, replaceAll, relative: rel });
    if (!editResult.ok) return editResult;
    const updated = String(editResult.updated);
    const diff = buildDiff(rel, text, updated);
    const { stat: newStat, error: commitError } = commitEdit(target, rel, updated, pinned);
    if (commitError) return commitError;
    return {
      ok: true,
      path: rel,
      absolute_path: target,
      replacements: editResult.replacements,
      used_quote_normalization: editResult.used_quote_normalization,
      diff,
      diff_sha256: sha256(Buffer.from(diff, 'utf-8')),
      diff_line_count: diffLineCount(diff),
      ...changeCounts(text, updated),
      size: Number(newStat.size),
      mtime_ns: Number(newStat.mtimeNs),
    };
  }

  function multiEditWorkspaceFile(args) {
    const path = String(args.path ?? '');
    const edits = args.edits;
    const replaceAll = Boolean(args.replace_all);
    const target = resolvePath(path);
    const rel = relativeOf(target);
    if (!Array.isArray(edits) || !edits.length) {
      return { ok: false, path: rel, error_type: 'invalid_edits', error_message: 'edits must be a non-empty list' };
    }
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index];
      if (!edit || typeof edit !== 'object') {
        return { ok: false, path: rel, error_type: 'invalid_edit', error_message: `edit at index ${index} must be an object`, failed_edit_index: index };
      }
      const reqErr = validateSingleEditRequest(edit.old_text, rel);
      if (reqErr) return { ...reqErr, failed_edit_index: index, edit_count: edits.length };
    }
    const observed = store.getReadState(rel);
    const pinned = observed ? { ...observed } : null;
    let readError = validateReadState(target, rel, { state: pinned });
    if (readError) return readError;
    const { text, error } = readWorkspaceText(target);
    if (error) return { ...error, path };
    const original = text ?? '';
    readError = validateReadState(target, rel, { state: pinned, content: original });
    if (readError) return readError;
    let updated = original;
    const diagnostics = [];
    let totalReplacements = 0;
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index];
      const r = applySingleEdit(updated, edit.old_text, edit.new_text, {
        expectedReplacements: Number(edit.expected_replacements ?? 1),
        replaceAll: Boolean(edit.replace_all ?? replaceAll),
        relative: rel,
      });
      if (!r.ok) return { ...r, failed_edit_index: index, edit_count: edits.length };
      updated = String(r.updated);
      totalReplacements += Number(r.replacements);
      diagnostics.push({ index, replacements: r.replacements, used_quote_normalization: r.used_quote_normalization, matches: r.matches || [] });
    }
    const diff = buildDiff(rel, original, updated);
    const { stat: newStat, error: commitError } = commitEdit(target, rel, updated, pinned);
    if (commitError) return commitError;
    return {
      ok: true,
      path: rel,
      absolute_path: target,
      edit_count: edits.length,
      replacements: totalReplacements,
      edits: diagnostics,
      diff,
      diff_sha256: sha256(Buffer.from(diff, 'utf-8')),
      diff_line_count: diffLineCount(diff),
      ...changeCounts(original, updated),
      size: Number(newStat.size),
      mtime_ns: Number(newStat.mtimeNs),
    };
  }

  function commitEdit(target, rel, updated, pinned) {
    const { text: current, error } = readWorkspaceText(target);
    if (error) return { stat: null, error: { ...error, path: rel } };
    if (current === null) return { stat: null, error: { ok: false, path: rel, error_message: 'workspace file read failed' } };
    const err = validateReadState(target, rel, { state: pinned, content: current });
    if (err) return { stat: null, error: err };
    try {
      publishWorkspaceBytes(target, Buffer.from(updated, 'utf-8'));
    } catch (e) {
      return { stat: null, error: { ok: false, path: rel, error_type: 'publish_failed', error_message: e.message } };
    }
    const stat = statSync(target, { bigint: true });
    refreshReadState(rel, stat, updated, target);
    return { stat, error: null };
  }

  function refreshReadState(rel, stat, text, target) {
    const lines = splitlines(text);
    store.recordReadState(makeReadState({
      path: rel,
      mtimeNs: stat.mtimeNs,
      sizeBytes: Number(stat.size),
      startLine: 1,
      endLine: lines.length,
      totalLines: lines.length,
      partial: false,
      canonicalPath: target,
      contentSha256: sha256(Buffer.from(text, 'utf-8')),
    }));
  }

  function lintWorkspaceFile(args) {
    const path = String(args.path ?? '');
    const language = args.language ?? 'auto';
    const target = resolvePath(path);
    const rel = relativeOf(target);
    const { text, error } = readWorkspaceText(target);
    if (error) return { ...error, path };
    const lang = detectLanguage(target, language);
    const issues = [];
    if (lang === 'python') {
      genericTextChecks(text, issues);
      issues.push({ severity: 'warning', line: 0, column: 0, message: 'python syntax validation unavailable in native node port; install python or use the python runtime' });
    } else if (lang === 'json') {
      try {
        JSON.parse(text ?? '');
      } catch (e) {
        issues.push({ severity: 'error', ...jsonErrorPosition(e.message, text), message: e.message });
      }
    } else {
      genericTextChecks(text, issues);
    }
    return {
      ok: !issues.some((i) => i.severity === 'error'),
      path: rel,
      language: lang,
      issues,
      lint_model: 'built_in_lightweight',
    };
  }

  function genericTextChecks(text, issues) {
    const lines = splitlines(text || '');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nul = line.indexOf('\x00');
      if (nul >= 0) issues.push({ severity: 'error', line: i + 1, column: nul + 1, message: 'NUL byte found' });
      if (line !== line.replace(/\s+$/, '')) {
        issues.push({ severity: 'warning', line: i + 1, column: line.length, message: 'trailing whitespace' });
        if (issues.length >= 20) break;
      }
    }
  }

  function jsonErrorPosition(message, text) {
    const match = /position (\d+)/.exec(message || '');
    if (!match) return { line: 0, column: 0 };
    const pos = Number(match[1]);
    const upto = (text || '').slice(0, pos);
    const parts = upto.split('\n');
    return { line: parts.length, column: parts[parts.length - 1].length + 1 };
  }

  function detectLanguage(target, language) {
    const value = String(language || 'auto').trim().toLowerCase();
    if (value && value !== 'auto') {
      const aliases = { py: 'python', python3: 'python', js: 'javascript' };
      return aliases[value] || value;
    }
    const ext = (target.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
    if (ext === 'py') return 'python';
    if (ext === 'json') return 'json';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'txt' || ext === 'log') return 'text';
    return 'text';
  }

  function searchWorkspaceFiles(args, ctx) {
    const query = String(args.query ?? '');
    const path = String(args.path ?? '.');
    const isRegex = Boolean(args.is_regex);
    const glob = args.glob ?? null;
    const caseSensitive = Boolean(args.case_sensitive);
    const contextLines = Number(args.context_lines ?? 0);
    const maxResults = Number(args.max_results ?? 100);
    const needle = query.trim();
    if (!needle) return { ok: false, error_message: 'query is required' };
    const base = resolvePath(path);
    if (!existsSync(base)) return { ok: false, error_code: 'workspace_path_not_found', error_message: `workspace path not found: ${path}` };
    const candidates = [];
    if (lstatSync(base, { bigint: true }).isFile()) {
      candidates.push(base);
    } else {
      // Real files beneath the base subtree; symlinked directories are not
      // followed so the search cannot escape the workspace root.
      const stack = [base];
      while (stack.length) {
        const cur = stack.pop();
        let dirents;
        try { dirents = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const d of dirents) {
          const abs = join(cur, d.name);
          if (d.isFile()) candidates.push(abs);
          else if (d.isDirectory() && !d.isSymbolicLink()) stack.push(abs);
        }
      }
    }
    let filtered = candidates;
    if (glob) {
      filtered = candidates.filter((c) => {
        const rel = relativeOf(c);
        return fnmatch(rel, glob) || fnmatch(c.split('/').pop(), glob);
      });
    }
    let pattern;
    try {
      pattern = new RegExp(isRegex ? needle : escapeRegex(needle), caseSensitive ? '' : 'i');
    } catch (e) {
      return { ok: false, error_code: 'invalid_search_pattern', error_message: e.message };
    }
    const limit = Math.max(1, Math.min(maxResults || 100, 5000));
    const contextLimit = Math.max(0, Math.min(contextLines || 0, 20));
    const results = [];
    let truncated = false;
    outer:
    for (const item of filtered) {
      if (ctx?.signal?.aborted) return { ok: false, error_code: 'canceled', error_message: 'workspace search canceled' };
      let size;
      try { size = Number(lstatSync(item, { bigint: true }).size); } catch { continue; }
      if (size > 1024 * 1024) continue;
      let payload;
      try { payload = readFileSync(item); } catch { continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload); }
      catch { continue; }
      const lines = splitlines(text);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!pattern.test(line)) continue;
        if (results.length >= limit) { truncated = true; break outer; }
        results.push({
          path: relativeOf(item),
          line: i + 1,
          text: line,
          snippet: line,
          context_before: lines.slice(Math.max(0, i - contextLimit), i),
          context_after: lines.slice(i + 1, i + 1 + contextLimit),
        });
      }
    }
    return {
      ok: true,
      query,
      searched_path: path,
      results,
      match_count: results.length,
      truncated,
      context_lines: contextLimit,
      search_backend: 'node',
    };
  }

  function deleteWorkspaceFile(args) {
    const path = String(args.path ?? '');
    const target = resolvePath(path);
    const real = pinnedRootReal;
    if (target === real) return { ok: false, error_message: 'refuse to delete workspace root' };
    if (!existsSync(target)) return { ok: false, error_message: `workspace path not found: ${path}` };
    const info = lstatSync(target, { bigint: true });
    try {
      if (info.isDirectory()) {
        rmdirSync(target);
      } else {
        unlinkSync(target);
      }
    } catch (e) {
      return { ok: false, error_message: `workspace delete failed: ${e.message}` };
    }
    return { ok: true, deleted: relativeOf(target) };
  }

  // ---- definitions ----------------------------------------------------------

  const definitions = buildDefinitions();

  const impls = {
    workspace_status: workspaceStatus,
    list_workspace_files: listWorkspaceFiles,
    read_workspace_file: readWorkspaceFile,
    write_workspace_file: writeWorkspaceFile,
    write_workspace_files: writeWorkspaceFiles,
    edit_workspace_file: editWorkspaceFile,
    multi_edit_workspace_file: multiEditWorkspaceFile,
    lint_workspace_file: lintWorkspaceFile,
    search_workspace_files: searchWorkspaceFiles,
    delete_workspace_file: deleteWorkspaceFile,
  };

  // ---- execute --------------------------------------------------------------

  async function execute(request) {
    if (!request || typeof request !== 'object') {
      return { status: 'error', content: { code: 'invalid_request', message: 'request object required' } };
    }
    const call = request.call;
    if (!call || !call.name) {
      return { status: 'error', content: { code: 'invalid_request', message: 'request.call.name required' } };
    }
    const name = call.name;
    const impl = impls[name];
    if (!impl) return { status: 'error', content: { code: 'unknown_tool', message: `unknown tool: ${name}` } };
    const signal = request.signal;
    const mutating = MUTATING.has(name);

    // The root boundary is pinned at factory creation. Re-check it on every
    // execute: a symlink swap (or parent rewrite) that changes the live
    // realpath is refused before authorization, so a swapped root can never
    // authorize a write even if the caller later approves.
    try { checkRootBoundary(); }
    catch (e) {
      if (e instanceof RootBoundaryError) {
        return { status: 'error', content: { code: e.code, message: e.message } };
      }
      throw e;
    }

    if (mutating) {
      if (signal?.aborted) return canceled();
      if (request.interaction != null) {
        const reply = handleApprovalReply(request);
        if (reply.error) return { status: 'error', content: reply.error };
      } else {
        let decision;
        try { decision = await authorizeFn(request); } catch (e) {
          return { status: 'error', content: { code: 'authorize_failed', message: e.message } };
        }
        // Re-check the boundary after the authorization await: the root could
        // have been swapped while the caller was deciding approval.
        try { checkRootBoundary(); }
        catch (e) {
          if (e instanceof RootBoundaryError) {
            return { status: 'error', content: { code: e.code, message: e.message } };
          }
          throw e;
        }
        if (decision === 'deny') return { status: 'error', content: { code: 'policy_denied' } };
        if (decision === 'approval_required') {
          const pending = store.addPending({
            callId: call.callId, name, argumentsDigest: argumentsDigest(call.arguments),
          });
          return {
            status: 'approval_required',
            interactionId: pending.interactionId,
            content: {
              code: 'approval_required',
              interactionId: pending.interactionId,
              call: { name, callId: call.callId },
              operation_key: request.operationKey,
              message: `approval required for ${name}`,
            },
          };
        }
        if (decision !== 'allow') {
          return { status: 'error', content: { code: 'authorize_unexpected', message: `authorize returned ${String(decision)}` } };
        }
      }
    }

    if (signal?.aborted) return canceled();

    let result;
    try {
      result = impl(call.arguments ?? {}, { signal, request });
    } catch (e) {
      if (e instanceof WorkspacePathError) {
        return { status: 'error', content: { ok: false, error_type: 'path_escape', error_message: e.message } };
      }
      return { status: 'error', content: { ok: false, error_type: 'internal_error', error_message: e.message } };
    }
    if (signal?.aborted && !(result && result.ok)) return canceled();

    if (result && result.ok === true) {
      const out = { status: 'ok', content: result };
      // Only mutating tools report workspace-changed paths; reads must not.
      if (mutating) {
        const changed = extractChangedPaths(result);
        if (changed.length) out.workspaceChangedPaths = changed;
      }
      return out;
    }
    return { status: 'error', content: result };
  }

  function handleApprovalReply(request) {
    const interaction = request.interaction;
    const call = request.call;
    if (!interaction || typeof interaction !== 'object') {
      return { error: { code: 'interaction_required', message: 'approval interaction required' } };
    }
    if (!call?.callId || interaction.callId !== call.callId) {
      return { error: { code: 'interaction_binding_mismatch', message: 'interaction.callId does not match request.call.callId' } };
    }
    if (!interaction.interactionId) {
      return { error: { code: 'interaction_binding_mismatch', message: 'interaction.interactionId missing' } };
    }
    const pending = store.getPending(interaction.interactionId);
    if (!pending) return { error: { code: 'interaction_unknown_or_expired', message: 'approval interaction unknown or expired' } };
    if (pending.callId !== call.callId || pending.name !== call.name || argumentsDigest(call.arguments) !== pending.argumentsDigest) {
      return { error: { code: 'interaction_binding_mismatch', message: 'pending approval does not match this call' } };
    }
    const decision = String(interaction.decision || '').toLowerCase();
    if (decision === 'deny' || decision === 'denied') {
      store.consumePending(interaction.interactionId);
      return { error: { code: 'policy_denied', message: 'approval denied' } };
    }
    if (decision !== 'allow' && decision !== 'approve' && decision !== 'approved') {
      return { error: { code: 'interaction_binding_mismatch', message: 'approval decision missing or unrecognized' } };
    }
    store.consumePending(interaction.interactionId);
    return { approved: true };
  }

  // ---- observe --------------------------------------------------------------

  async function observe(request) {
    if (!request || typeof request !== 'object') {
      return { revision: null, changedPaths: [], status: 'unavailable', reason: 'invalid_request' };
    }
    // The root boundary is pinned at factory creation; a swapped root is not
    // observed even if it still exists at a new real path.
    try { checkRootBoundary(); }
    catch (e) {
      if (e instanceof RootBoundaryError) {
        return { revision: null, changedPaths: [], status: 'unavailable', reason: e.code };
      }
      throw e;
    }
    const real = pinnedRootReal;
    if (!existsSync(real)) {
      return { revision: null, changedPaths: [], status: 'unavailable', reason: 'workspace_missing' };
    }
    try {
      const revision = computeRevision(real);
      return { revision, changedPaths: [], status: 'ok', reason: null };
    } catch (e) {
      if (e instanceof CaptureError) {
        return { revision: null, changedPaths: [], status: 'unavailable', reason: e.code };
      }
      return { revision: null, changedPaths: [], status: 'unavailable', reason: 'capture_failed' };
    }
  }

  /**
   * Compute a workspace revision by scanning the directory tree twice and
   * requiring the two captures to agree. A single scan would treat a file
   * truncated or rewritten mid-scan as a stable revision; the double capture
   * mirrors ksadk.harness.workspace_adapters.native_directory, which rejects a
   * capture whose two passes differ in digest, entry list or per-entry
   * identity. A short read (fewer bytes than lstat reported) is a change and
   * makes the capture unavailable.
   *
   * Remaining non-atomic limit: two captures are sequential, not a single
   * filesystem transaction. A change that happens entirely between the two
   * scans, or within a single scan with no carry-over, can still produce a
   * stable but momentary revision. The Host's effect/receipt layer, not this
   * port, owns the authoritative mutation ledger; observe is a best-effort
   * snapshot that refuses to confirm a workspace it saw changing.
   */
  function computeRevision(real) {
    const first = captureInventory(real);
    const second = captureInventory(real);
    if (first.digest !== second.digest
      || first.entryCount !== second.entryCount
      || !entriesEqual(first.entries, second.entries)) {
      throw new CaptureError('workspace_changed_during_capture');
    }
    return 'sha256:' + first.digest;
  }

  function captureInventory(real) {
    const hash = createHash('sha256');
    hash.update('ksadk.directory-workspace/v1\0');
    const state = { entries: 0, hashedBytes: 0, list: [] };
    scanDir(real, '', hash, state);
    state.list.sort();
    return { digest: hash.digest('hex'), entryCount: state.entries, entries: state.list };
  }

  /** Compare two sorted entry-identity lists for exact equality. */
  function entriesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function scanDir(real, rel, hash, state) {
    const dir = rel ? join(real, rel) : real;
    let dirents;
    try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { throw new CaptureError('capture_failed'); }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const entryRel = rel ? `${rel}/${d.name}` : d.name;
      if (entryRel.includes('\\') || entryRel.includes('\0')) throw new CaptureError('unsupported_workspace_path');
      state.entries += 1;
      if (state.entries > OBSERVE_MAX_ENTRIES) throw new CaptureError('capture_limit_exceeded');
      const abs = join(real, entryRel);
      let info;
      try { info = lstatSync(abs, { bigint: true }); } catch { throw new CaptureError('capture_failed'); }
      // Re-stat after opening files below would race; record the pre-read identity
      // and verify it again at the end of the entry so a mid-entry change is caught.
      const before = entryIdentity(info);
      hash.update(`\0path\0${entryRel}`);
      hash.update(`\0mode:${Number(info.mode & 0o777n).toString(8)}`);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        hash.update('\0directory');
        scanDir(real, entryRel, hash, state);
      } else if (info.isSymbolicLink()) {
        let target;
        try { target = readlinkSync(abs); } catch { throw new CaptureError('capture_failed'); }
        const tb = Buffer.from(target, 'utf-8');
        state.hashedBytes += tb.length;
        if (state.hashedBytes > OBSERVE_MAX_HASHED) throw new CaptureError('capture_limit_exceeded');
        hash.update('\0symlink\0');
        hash.update(tb);
        state.list.push(`${entryRel}\tsymlink\t${before}`);
      } else if (info.isFile()) {
        if (state.hashedBytes + Number(info.size) > OBSERVE_MAX_HASHED) throw new CaptureError('capture_limit_exceeded');
        const fileHash = createHash('sha256');
        const fd = openSync(abs, 'r');
        let readBytes = 0;
        try {
          let remaining = Number(info.size);
          const buf = Buffer.alloc(1024 * 1024);
          while (remaining > 0) {
            const n = readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
            if (n === 0) break; // short read: file shrank under us
            readBytes += n;
            state.hashedBytes += n;
            if (state.hashedBytes > OBSERVE_MAX_HASHED) throw new CaptureError('capture_limit_exceeded');
            fileHash.update(buf.subarray(0, n));
            remaining -= n;
          }
        } finally { closeSync(fd); }
        // A short read (fewer bytes than lstat reported) means the file changed
        // during the read; treat the capture as changing rather than locking
        // in a truncated digest as if it were the whole file.
        if (readBytes !== Number(info.size)) throw new CaptureError('workspace_changed_during_capture');
        // Compute the file digest once; Hash.digest() finalizes the hash and a
        // second call throws "Digest already called".
        const fileDigest = fileHash.digest();
        hash.update('\0file\0');
        hash.update(fileDigest);
        state.list.push(`${entryRel}\tfile\t${before}\t${fileDigest.toString('hex')}`);
      } else {
        throw new CaptureError('unsupported_workspace_entry');
      }
      // Verify the entry's identity is unchanged since the start of this entry;
      // a rename/replace/truncate that landed during the read is a change.
      let after;
      try { after = entryIdentity(lstatSync(abs, { bigint: true })); } catch { throw new CaptureError('capture_failed'); }
      if (after !== before) throw new CaptureError('workspace_changed_during_capture');
      if (state.hashedBytes > OBSERVE_MAX_HASHED) throw new CaptureError('capture_limit_exceeded');
    }
  }

  /** Stable identity tuple for an entry: mode, size, mtimeNs, ctimeNs, ino. */
  function entryIdentity(info) {
    return `${info.mode}|${info.size}|${info.mtimeNs}|${info.ctimeNs}|${info.ino}`;
  }

  return { definitions, execute, observe };
}

function canceled() {
  return { status: 'error', content: { code: 'canceled', message: 'tool execution canceled' } };
}

function extractChangedPaths(result) {
  if (result.path) return [result.path];
  if (result.deleted) return [result.deleted];
  if (Array.isArray(result.written)) return result.written.map((w) => w.path).filter(Boolean);
  return [];
}

async function defaultAuthorize(request) {
  const name = request?.call?.name;
  if (name && READ_ONLY.has(name)) return 'allow';
  return 'approval_required';
}

// ---- ToolDefinition[] -------------------------------------------------------

function buildDefinitions() {
  return [
    def('workspace_status', 'Return the current AgentEngine workspace status.', {
      type: 'object', properties: {}, additionalProperties: false,
    }, { readOnly: true, concurrentSafe: true, contextRole: 'none', timeoutMs: 30000 }),
    def('list_workspace_files', 'List files under the AgentEngine workspace.', {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        glob: { type: ['string', 'null'] },
        recursive: { type: 'boolean', default: false },
        include_dirs: { type: 'boolean', default: true },
        max_results: { type: 'integer', default: 500, minimum: 1, maximum: 5000 },
        sort_by: { type: 'string', default: 'name', enum: ['name', 'mtime', 'size'] },
      },
      additionalProperties: false,
    }, { readOnly: true, concurrentSafe: true, contextRole: 'workspace_list', timeoutMs: 30000 }),
    def('read_workspace_file', 'Read a UTF-8 workspace file. Inspect the result before editing it. Do not issue a dependent read and edit in the same parallel tool-call batch.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: ['integer', 'null'], minimum: 1 },
        end_line: { type: ['integer', 'null'], minimum: 1 },
        max_chars: { type: ['integer', 'null'], minimum: 1000, maximum: 100000 },
        include_line_numbers: { type: 'boolean', default: true },
      },
      required: ['path'], additionalProperties: false,
    }, { readOnly: true, concurrentSafe: true, contextRole: 'workspace_read', timeoutMs: 30000 }),
    def('write_workspace_file', 'Write a UTF-8 text file inside the AgentEngine workspace. Creating a new file needs no prior read; replacing an existing file requires a complete current read or a successful write in this session.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', default: true },
      },
      required: ['path', 'content'], additionalProperties: false,
    }, { readOnly: false, concurrentSafe: false, contextRole: 'none', permissions: ['workspace:write'], timeoutMs: 30000 }),
    def('write_workspace_files', 'Write multiple UTF-8 text files inside the AgentEngine workspace. Preconditions for the batch are checked before the first file is changed.', {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        overwrite: { type: 'boolean', default: true },
      },
      required: ['files'], additionalProperties: false,
    }, { readOnly: false, concurrentSafe: false, contextRole: 'none', permissions: ['workspace:write'], timeoutMs: 60000 }),
    def('edit_workspace_file', 'Replace exact text after reading or successfully writing the file. The prior operation must complete; do not batch dependent reads/writes and edits.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        expected_replacements: { type: 'integer', default: 1, minimum: 1 },
        replace_all: { type: 'boolean', default: false },
      },
      required: ['path', 'old_text', 'new_text'], additionalProperties: false,
    }, { readOnly: false, concurrentSafe: false, contextRole: 'none', permissions: ['workspace:write'], timeoutMs: 30000 }),
    def('multi_edit_workspace_file', 'Apply atomic exact edits after reading or successfully writing the file. The prior operation must complete; do not batch dependent reads/writes and edits.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { old_text: { type: 'string' }, new_text: { type: 'string' }, expected_replacements: { type: 'integer', default: 1, minimum: 1 }, replace_all: { type: 'boolean', default: false } }, required: ['old_text', 'new_text'] } },
        replace_all: { type: 'boolean', default: false },
      },
      required: ['path', 'edits'], additionalProperties: false,
    }, { readOnly: false, concurrentSafe: false, contextRole: 'none', permissions: ['workspace:write'], timeoutMs: 30000 }),
    def('lint_workspace_file', 'Run lightweight built-in lint checks for a UTF-8 workspace text file.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        language: { type: 'string', default: 'auto' },
      },
      required: ['path'], additionalProperties: false,
    }, { readOnly: true, concurrentSafe: true, contextRole: 'none', timeoutMs: 30000 }),
    def('search_workspace_files', 'Search UTF-8 text files in the AgentEngine workspace.', {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', default: '.' },
        is_regex: { type: 'boolean', default: false },
        glob: { type: ['string', 'null'] },
        case_sensitive: { type: 'boolean', default: false },
        context_lines: { type: 'integer', default: 0, minimum: 0, maximum: 20 },
        max_results: { type: 'integer', default: 100, minimum: 1, maximum: 5000 },
      },
      required: ['query'], additionalProperties: false,
    }, { readOnly: true, concurrentSafe: true, contextRole: 'workspace_search', timeoutMs: 60000 }),
    def('delete_workspace_file', 'Delete a file or empty directory inside the AgentEngine workspace.', {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false,
    }, { readOnly: false, concurrentSafe: false, contextRole: 'none', permissions: ['workspace:delete'], timeoutMs: 30000 }),
  ];
}

function def(name, description, parameters, opts) {
  return {
    name,
    description,
    parameters,
    readOnly: opts.readOnly,
    concurrentSafe: opts.concurrentSafe,
    permissions: opts.permissions || [],
    timeoutMs: opts.timeoutMs || 30000,
    contextRole: opts.contextRole || 'none',
    observationRole: 'none',
    progressObservation: false,
    contextRetention: 'normal',
  };
}
