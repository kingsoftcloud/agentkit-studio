import {
  existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { publicErrorMessage, publicErrorCode, publicFailureContent } from '../../diagnostic-text.mjs';
import { checkPythonSyntax, NATIVE_PYTHON_SYNTAX } from './python-syntax.mjs';
import { acquireWorkspaceMutationLock } from './workspace-mutation-lock.mjs';
import { captureWorkspace } from './workspace-snapshot.mjs';
import {
  WorkspacePathError, escapeRegex, fnmatch, publishWorkspaceBytes, sha256, TWO_MB, resolveWorkspacePath, workspaceRelative,
} from './workspace-paths.mjs';
import {
  applySingleEdit, buildDiff, changeCounts, diffLineCount, readWorkspaceText, splitlines, validateReadState, validateSingleEditRequest,
} from './workspace-editing.mjs';
import { WorkspaceStateStore, serializeReadState } from './workspace-state.mjs';

const MUTATING = new Set([
  'write_workspace_file', 'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file', 'delete_workspace_file',
]);
const READ_OBSERVATION_TOOLS = new Set(['read_workspace_file', 'write_workspace_file', 'write_workspace_files', 'edit_workspace_file', 'multi_edit_workspace_file']);

function boundaryError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Workspace tools for one DSH Session. The adapter owns permission and call identity. */
export function createStudioWorkspaceTools({ workspaceRoot: root, pinnedRootReal = realpathSync(root), stateDir, sessionId }) {
  const store = new WorkspaceStateStore(stateDir, sessionId);
  let activeMutations = null, activeGuard = null, activeReads = null;

  function rememberRead(state) {
    store.recordReadState(state);
    if (!state.partial) activeReads.set(state.path, serializeReadState(state));
  }

  function publish(target, bytes, options) {
    activeGuard();
    publishWorkspaceBytes(target, bytes, options);
    activeMutations.add(relativeOf(target));
  }

  function checkRootBoundary() {
    let live;
    try { live = realpathSync(root); }
    catch { throw boundaryError('workspace_missing', 'workspace root no longer exists'); }
    if (live !== pinnedRootReal) throw boundaryError('workspace_root_changed', 'workspace root was replaced or repointed');
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
      items.push({ abs: target, name: basename(target) });
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
    rememberRead({
      path: rel,
      mtimeNs: stat.mtimeNs,
      sizeBytes: Number(stat.size),
      startLine: start,
      endLine: returnedEnd !== null ? returnedEnd : start,
      totalLines,
      partial,
      canonicalPath: target,
      contentSha256: sha256(Buffer.from(text, 'utf-8')),
    });
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
      publish(t, Buffer.from(content, 'utf-8'), { createOnly });
    } catch (e) {
      if (e.code === 'EEXIST') {
        return { ok: false, path: rel, error_type: 'file_exists', error_message: 'workspace file was created before publication', suggested_action: 'Read the new file before proposing an overwrite.' };
      }
      return { ok: false, path: rel, error_type: 'publish_failed', error_message: publicErrorMessage(e) };
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
      if (!result.ok) return { ...result, written, partial: written.length > 0, failed_path: path };
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
      publish(target, Buffer.from(updated, 'utf-8'));
    } catch (e) {
      return { stat: null, error: { ok: false, path: rel, error_type: 'publish_failed', error_message: publicErrorMessage(e) } };
    }
    const stat = statSync(target, { bigint: true });
    refreshReadState(rel, stat, updated, target);
    return { stat, error: null };
  }

  function refreshReadState(rel, stat, text, target) {
    const lines = splitlines(text);
    rememberRead({
      path: rel,
      mtimeNs: stat.mtimeNs,
      sizeBytes: Number(stat.size),
      startLine: 1,
      endLine: lines.length,
      totalLines: lines.length,
      partial: false,
      canonicalPath: target,
      contentSha256: sha256(Buffer.from(text, 'utf-8')),
    });
  }

  function lintWorkspaceFile(args, { signal }) {
    const path = String(args.path ?? '');
    const language = args.language ?? 'auto';
    const target = resolvePath(path);
    const rel = relativeOf(target);
    const { text, error } = readWorkspaceText(target);
    if (error) return { ...error, path };
    const lang = detectLanguage(target, language);
    const issues = [];
    if (lang === 'python') {
      // Capture bytes under the same workspace checks as all text tools. The
      // parser receives no filesystem or host execution authority.
      return checkPythonSyntax(text || '', { signal }).then(issues => ({
        ok: issues.length === 0, path: rel, language: lang, issues,
        lint_model: 'built_in_lightweight', syntax_engine: { ...NATIVE_PYTHON_SYNTAX },
      }));
    } else if (lang === 'json') {
      try {
        JSON.parse(text ?? '');
      } catch (e) {
        issues.push({ severity: 'error', ...jsonErrorPosition(e.message, text), message: publicErrorMessage(e) });
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

  function searchWorkspaceFiles(args, { signal }) {
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
        return fnmatch(rel, glob) || fnmatch(basename(c), glob);
      });
    }
    let pattern;
    try {
      pattern = new RegExp(isRegex ? needle : escapeRegex(needle), caseSensitive ? '' : 'i');
    } catch (e) {
      return { ok: false, error_code: 'invalid_search_pattern', error_message: publicErrorMessage(e) };
    }
    const limit = Math.max(1, Math.min(maxResults || 100, 5000));
    const contextLimit = Math.max(0, Math.min(contextLines || 0, 20));
    const results = [];
    let truncated = false;
    outer:
    for (const item of filtered) {
      if (signal?.aborted) return { ok: false, error_code: 'canceled', error_message: 'workspace search canceled' };
      let target;
      try { target = resolvePath(relativeOf(item)); } catch { continue; }
      if (target !== item) continue;
      const { text, error } = readWorkspaceText(target, 1024 * 1024);
      if (error) continue;
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
      activeGuard?.();
      if (info.isDirectory()) {
        rmdirSync(target);
      } else {
        unlinkSync(target);
      }
      activeMutations?.add(relativeOf(target));
    } catch (e) {
      return { ok: false, error_message: `workspace delete failed: ${publicErrorMessage(e)}` };
    }
    return { ok: true, deleted: relativeOf(target) };
  }


  const implementations = {
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

  async function execute(request, assertCurrent) {
    const { sessionId: caller, call, signal } = request;
    if (caller !== sessionId) return { status: 'error', content: { code: 'workspace_session_mismatch' } };
    const name = call.name;
    if (!Object.hasOwn(implementations, name)) return { status: 'error', content: { code: 'unknown_tool', message: `unknown tool: ${name}` } };
    const mutating = MUTATING.has(name);
    const guard = () => {
      checkRootBoundary();
      signal.throwIfAborted();
      assertCurrent();
    };
    const mutations = new Set(), reads = new Map();
    let result, release;
    try {
      guard();
      if (mutating) release = acquireWorkspaceMutationLock(pinnedRootReal);
      guard();
      activeMutations = mutations; activeGuard = guard; activeReads = reads;
      result = implementations[name](call.arguments, { signal });
      guard();
    } catch (error) {
      if (mutations.size) return { status: 'uncertain', workspaceChangedPaths: [...mutations],
        content: { ok: false, error_type: 'state_persist_failed', executed: true, paths: [...mutations] } };
      if (signal.aborted) return canceled();
      if (error instanceof WorkspacePathError) return failure({ ok: false, error_type: 'path_escape', error_message: publicErrorMessage(error) });
      if (['workspace_missing', 'workspace_root_changed'].includes(error.code))
        return failure({ code: error.code, message: publicErrorMessage(error) });
      return failure({ ok: false, error_type: publicErrorCode(error, 'internal_error'), error_message: publicErrorMessage(error) });
    } finally {
      activeMutations = null; activeGuard = null; activeReads = null;
      release?.();
    }
    // The Python worker parses captured bytes outside the publication lock.
    try {
      result = await result;
    } catch (error) {
      if (signal.aborted) return canceled();
      return failure({ ok: false, error_type: publicErrorCode(error, 'python_syntax_unavailable'), error_message: publicErrorMessage(error) });
    }
    if (signal.aborted && !(result && result.ok)) return canceled();
    if (!result?.ok) return { ...failure(result), ...(mutations.size ? { workspaceChangedPaths: [...mutations] } : {}) };
    const out = { status: 'ok', content: result };
    if (reads.size && READ_OBSERVATION_TOOLS.has(name))
      out.metadata = { nativeWorkspaceReads: { contract: 'native-workspace-read-observation/v1', tool: name, states: [...reads.values()] } };
    if (mutating) {
      const changed = extractChangedPaths(result);
      if (changed.length) out.workspaceChangedPaths = changed;
    }
    return out;
  }

  return { execute, capture(request) {
    if (request.sessionId !== sessionId) throw boundaryError('workspace_session_mismatch', 'workspace_session_mismatch');
    checkRootBoundary();
    const snapshot = captureWorkspace(pinnedRootReal);
    checkRootBoundary();
    return snapshot;
  } };
}

function failure(content) {
  return { status: 'error', content: publicFailureContent(content) };
}

function canceled() {
  return { status: 'error', content: { code: 'canceled', message: 'tool execution canceled' } };
}

function extractChangedPaths(result) {
  if (Array.isArray(result.changed_paths)) return result.changed_paths;
  if (result.path) return [result.path];
  if (result.deleted) return [result.deleted];
  if (Array.isArray(result.written)) return result.written.map((w) => w.path).filter(Boolean);
  return [];
}

export function workspaceToolDefinitions() {
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
    }, { readOnly: true, concurrentSafe: true, contextRole: 'workspace_list', timeoutMs: 30000, recoveryPolicy: 'safe-read/v1' }),
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
    }, { readOnly: true, concurrentSafe: true, contextRole: 'workspace_read', timeoutMs: 30000, recoveryPolicy: 'safe-read/v1' }),
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
    }, { readOnly: true, concurrentSafe: true, contextRole: 'workspace_search', timeoutMs: 60000, recoveryPolicy: 'safe-read/v1' }),
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
    ...(opts.recoveryPolicy ? { recoveryPolicy: opts.recoveryPolicy } : {}),
  };
}
