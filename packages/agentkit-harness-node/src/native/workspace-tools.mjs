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
 * deliberately not reimplemented here. Python syntax checks use the pinned
 * Rust/WASM parser in an isolated Node worker; nothing launches Python.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readlinkSync, readSync, realpathSync, rmdirSync, statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { checkPythonSyntax, NATIVE_PYTHON_SYNTAX } from './python-syntax.mjs';
import { acquireWorkspaceMutationLock, workspaceMutationGuard } from './workspace-mutation-lock.mjs';
import { budgetWorkspaceSourcePage, validateSourcePageBudget } from './source-page.mjs';
import { prepareWorkspaceEdits } from './workspace-edit-match.mjs';
import { prepareWorkspacePatch } from './workspace-patch.mjs';
import { workspaceChangeDisplay } from './workspace-display.mjs';
import { createWorkspaceCheckpointJournal, captureCheckpointFile, checkpointStatesEqual, WORKSPACE_CHECKPOINT_POLICY, CONVERSATION_WORKSPACE_CONTROL } from './workspace-checkpoints.mjs';
import { parseStructuredPatch } from '@kingsoftcloud/agentkit-harness-core/patch-parser';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';

import {
  WorkspacePathError, escapeRegex, fnmatch, publishWorkspaceBytes, sha256,
  TWO_MB, resolveWorkspacePath, workspaceRelative,
} from './workspace-paths.mjs';
import {
  applySingleEdit, buildDiff, changeCounts, diffLineCount, readWorkspaceText,
  splitlines, validateReadState, validateSingleEditRequest,
} from './workspace-editing.mjs';
import {
  WorkspaceStateStore, argumentsDigest, makeReadState, serializeReadState, deserializeReadState,
} from './workspace-state.mjs';

const MUTATING = new Set([
  'write_workspace_file', 'write_workspace_files', 'edit_workspace_file',
  'multi_edit_workspace_file', 'delete_workspace_file', 'apply_workspace_patch', 'rewind_workspace_files',
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
  workspaceRoot, stateDir, sessionId, authorize, enablePatches = false, enableRewind = false,
} = {}) {
  if (!workspaceRoot) throw new TypeError('createNativeWorkspaceTools requires workspaceRoot');
  if (!stateDir) throw new TypeError('createNativeWorkspaceTools requires stateDir');
  const root = workspaceRoot;
  const store = new WorkspaceStateStore(stateDir, sessionId);
  const authorizeFn = authorize || defaultAuthorize;
  // Mutating implementations below are synchronous. Track publications within the
  // current invocation so a later state-write failure cannot masquerade as a
  // definite failure before execution. No tracking state crosses an await.
  let activeMutations = null, activeGuard = null, activeCheckpoint = null, activePublications = null, activeReads = null, activeDisplayChanges = null;
  function rememberDisplay(path, before, after) {
    if (!before || !activeDisplayChanges) return;
    const previous = activeDisplayChanges.get(path);
    activeDisplayChanges.set(path, { before: previous?.before ?? before, after });
  }
  function rememberRead(state) {
    store.recordReadState(state);
    if (!state.partial) activeReads?.set(state.path, serializeReadState(state));
  }
  function assertCheckpointPath(target) {
    if (activeCheckpoint && resolvePath(relativeOf(target)) !== target)
      throw Object.assign(Error('checkpoint_path_changed'), { code: 'checkpoint_path_changed' });
  }
  function publish(target, bytes, options) {
    activeGuard?.(); assertCheckpointPath(target);
    const before = activeCheckpoint?.stage(relativeOf(target), { kind: 'file', bytes: bytes.toString('base64'), sha256: sha256(bytes),
      ...(options?.checkpointMode !== undefined ? { mode: options.checkpointMode } : {}) });
    activeGuard?.(); assertCheckpointPath(target);
    publishWorkspaceBytes(target, bytes, options);
    rememberDisplay(relativeOf(target), before, bytes.length <= 128 * 1024
      ? { kind: 'file', bytes: bytes.toString('base64') } : { kind: 'unavailable' });
    activeMutations?.add(relativeOf(target));
    activePublications?.set(relativeOf(target), { kind: 'file', sha256: sha256(bytes), mode: before?.kind === 'file' ? before.mode : 0o666 & ~process.umask() });
  }

  // Pin the authorized root boundary at factory creation. The caller passes a
  // trusted workspaceRoot; resolving its realpath once here establishes the
  // directory this port is allowed to touch. We never re-resolve `root` later,
  // so swapping the root path (or a parent) for a symlink that points outside
  // cannot widen the boundary mid-life: execute and observe compare the live
  // realpath against this pinned value and refuse on mismatch.
  const pinnedRootReal = resolvePinnedRoot(root);
  const checkpoints = createWorkspaceCheckpointJournal({ stateDir, sessionId: store.sessionId, workspaceRoot: pinnedRootReal,
    resolvePath: path => resolvePath(path) });
  function remove(target, directory = false) {
    activeGuard?.(); assertCheckpointPath(target); const before = activeCheckpoint?.stage(relativeOf(target), { kind: 'absent' });
    activeGuard?.(); assertCheckpointPath(target);
    if (directory) rmdirSync(target); else unlinkSync(target);
    rememberDisplay(relativeOf(target), before, { kind: 'absent' });
    activeMutations?.add(relativeOf(target));
    activePublications?.set(relativeOf(target), { kind: 'absent' });
  }

  function compensateRewind(plan, publications, checkpoint, guard) {
    guard(); checkpoint.compensating(); guard();
    const originals = new Map(plan.files.map(file => [file.path, file]));
    for (const [path, published] of [...publications].reverse()) {
      const file = originals.get(path), target = file?.canonicalPath, desired = file?.current;
      const check = () => { guard(); if (!target || resolvePath(path) !== target)
        throw Object.assign(Error('checkpoint_path_changed'), { code: 'checkpoint_path_changed' }); };
      check();
      if (!desired || !checkpointStatesEqual(captureCheckpointFile(target), published))
        throw Object.assign(Error('checkpoint_compensation_conflict'), { code: 'checkpoint_compensation_conflict' });
      // Restore only our own last publication. Do not stage these inverse writes
      // as a new user operation or overwrite changes made by another editor.
      if (published.kind !== 'absent' && published.kind !== desired.kind) {
        check(); if (published.kind === 'directory') rmdirSync(target); else unlinkSync(target);
      }
      if (desired.kind === 'file') {
        check(); publishWorkspaceBytes(target, Buffer.from(desired.bytes, 'base64'));
        check(); chmodSync(target, desired.mode);
      } else if (desired.kind === 'directory') {
        check(); mkdirSync(target, { recursive: true, mode: desired.mode });
        check(); chmodSync(target, desired.mode);
      }
      check();
      if (!checkpointStatesEqual(captureCheckpointFile(target), desired))
        throw Object.assign(Error('checkpoint_compensation_conflict'), { code: 'checkpoint_compensation_conflict' });
    }
    guard(); checkpoint.compensated(); guard();
  }

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

  function listWorkspaceFiles(args, { request } = {}) {
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
      mtime_ns: request?.definition?.directoryObservationPolicy ? e.mtimeNs : Number(e.mtimeNs),
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

  function readWorkspaceFile(args, { request } = {}) {
    const sourceBudget = request?.definition?.sourceObservationPolicy ? validateSourcePageBudget(request.sourceReadBudget) : null;
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
    if (sourceBudget) {
      const rel = relativeOf(target);
      const result = budgetWorkspaceSourcePage({ ok: true, path: rel, size: Number(stat.size), size_bytes: Number(stat.size),
        mtime_ns: stat.mtimeNs, start_line: start, end_line: end, line_count: selected.length,
        read_range: { start, end }, total_lines: totalLines, partial: start !== 1 || end !== totalLines, suggested_action: '' },
      content, args.max_chars, sourceBudget);
      if (result.ok && !result.artifact_only) rememberRead(makeReadState({ path: rel, mtimeNs: stat.mtimeNs,
        sizeBytes: Number(stat.size), startLine: start, endLine: result.end_line ?? start, totalLines, partial: result.partial,
        canonicalPath: target, contentSha256: sha256(Buffer.from(text, 'utf-8')) }));
      return result;
    }
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
    rememberRead(makeReadState({
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
      publish(t, Buffer.from(content, 'utf-8'), { createOnly });
    } catch (e) {
      if (e.code === 'EEXIST') {
        return { ok: false, path: rel, error_type: 'file_exists', error_message: 'workspace file was created before publication', suggested_action: 'Read the new file before proposing an overwrite.' };
      }
      return { ok: false, path: rel, error_type: e.code?.startsWith('checkpoint_') ? e.code : 'publish_failed', error_message: e.message };
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

  function editWorkspaceFile(args, { preparedEdit } = {}) {
    const path = String(args.path ?? '');
    const oldText = args.old_text;
    const newText = args.new_text;
    const expectedReplacements = Number(args.expected_replacements ?? 1);
    const replaceAll = Boolean(args.replace_all);
    const target = resolvePath(path);
    const rel = relativeOf(target);
    const requestError = preparedEdit?.emptyOldText ? null : validateSingleEditRequest(oldText, rel);
    if (requestError) return requestError;
    if (preparedEdit?.create) {
      // Preparation observed absence. Recheck under the mutation lock, then use
      // create-only publication to refuse a concurrent external creation too.
      if (!absent(target)) return stalePreparedEdit(rel);
      const createdText = preparedEdit.createdText;
      try { publish(target, Buffer.from(createdText, 'utf-8'), { createOnly: true }); }
      catch (error) { return { ok: false, path: rel, error_type: error.code === 'EEXIST' ? 'file_modified_since_read' : error.code || 'publish_failed',
        error_message: error.message, suggested_action: 'Read the current file and retry.' }; }
      const stat = statSync(target, { bigint: true }); refreshReadState(rel, stat, createdText, target);
      const diff = buildDiff(rel, '', createdText);
      return { ok: true, path: rel, absolute_path: target, replacements: 1, used_quote_normalization: false,
        diff, diff_sha256: sha256(Buffer.from(diff)), diff_line_count: diffLineCount(diff), ...changeCounts('', createdText),
        size: Number(stat.size), mtime_ns: Number(stat.mtimeNs) };
    }
    const observed = preparedEdit?.pinned ?? store.getReadState(rel);
    const pinned = observed ? { ...observed } : null;
    let readError = validateReadState(target, rel, { state: pinned });
    if (readError) return readError;
    const { text, error } = readWorkspaceText(target);
    if (error) return { ...error, path };
    if (text === null) return { ok: false, path, error_message: 'workspace file read failed' };
    readError = validateReadState(target, rel, { state: pinned, content: text });
    if (readError) return readError;
    if (preparedEdit && text !== preparedEdit.text) return stalePreparedEdit(rel);
    const editResult = preparedEdit ? preparedEdit.results[0] : applySingleEdit(text, oldText, newText, { expectedReplacements, replaceAll, relative: rel });
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
      ...(editResult.match_strategy ? { match_strategy: editResult.match_strategy, match_candidate_count: editResult.match_candidate_count } : {}),
      diff,
      diff_sha256: sha256(Buffer.from(diff, 'utf-8')),
      diff_line_count: diffLineCount(diff),
      ...changeCounts(text, updated),
      size: Number(newStat.size),
      mtime_ns: Number(newStat.mtimeNs),
    };
  }

  function multiEditWorkspaceFile(args, { preparedEdit } = {}) {
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
    const observed = preparedEdit?.pinned ?? store.getReadState(rel);
    const pinned = observed ? { ...observed } : null;
    let readError = validateReadState(target, rel, { state: pinned });
    if (readError) return readError;
    const { text, error } = readWorkspaceText(target);
    if (error) return { ...error, path };
    const original = text ?? '';
    if (preparedEdit && original !== preparedEdit.text) return stalePreparedEdit(rel);
    readError = validateReadState(target, rel, { state: pinned, content: original });
    if (readError) return readError;
    let updated = original;
    const diagnostics = [];
    let totalReplacements = 0;
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index];
      const r = preparedEdit ? preparedEdit.results[index] : applySingleEdit(updated, edit.old_text, edit.new_text, {
        expectedReplacements: Number(edit.expected_replacements ?? 1),
        replaceAll: Boolean(edit.replace_all ?? replaceAll),
        relative: rel,
      });
      if (!r.ok) return { ...r, failed_edit_index: index, edit_count: edits.length };
      updated = String(r.updated);
      totalReplacements += Number(r.replacements);
      diagnostics.push({ index, replacements: r.replacements, used_quote_normalization: r.used_quote_normalization, matches: r.matches || [],
        ...(r.match_strategy ? { match_strategy: r.match_strategy, match_candidate_count: r.match_candidate_count } : {}) });
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

  function stalePreparedEdit(relative) {
    return { ok: false, path: relative, error_type: 'file_modified_since_read',
      error_message: 'workspace file changed while preparing the edit', suggested_action: 'Read the current file and retry.' };
  }

  function emptyEditContent(text, replacement) {
    let crlf = 0, total = 0;
    for (let index = 0; index < text.length; index++) if (text[index] === '\n') {
      total++; if (text[index - 1] === '\r') crlf++;
    }
    // Use the dominant EOL, with LF on ties
    // and new files. Keep v1/nonempty editing semantics unchanged.
    const ending = crlf > total - crlf ? '\r\n' : '\n';
    return replacement.replace(/\r\n/g, '\n').replace(/\n/g, ending);
  }

  async function prepareEdit(request, guard) {
    const args = request.call.arguments, target = resolvePath(args.path), relative = relativeOf(target);
    const edits = request.call.name === 'edit_workspace_file' ? [args] : args.edits;
    if (!Array.isArray(edits) || !edits.length || edits.some(edit => !edit || typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string'))
      return { error: { ok: false, path: relative, error_type: 'invalid_edits', error_message: 'Non-empty edits with old_text and new_text strings are required.' } };
    const emptyOldText = request.definition.workspaceEditPolicy === 'zcode-match/v2'
      && request.call.name === 'edit_workspace_file' && args.old_text === '';
    if (emptyOldText) {
      if (args.new_text === '') return { error: { ok: false, path: relative, error_type: 'no_change', error_message: 'old_text and new_text are identical' } };
      if (!args.replace_all && Number(args.expected_replacements ?? 1) !== 1) return { error: { ok: false, path: relative,
        error_type: 'ambiguous_edit', error_message: 'Empty old_text replaces one file, but expected_replacements is not 1.',
        occurrences: 1, expected_replacements: args.expected_replacements } };
      if (absent(target)) { guard(); return { create: true, emptyOldText: true, createdText: emptyEditContent('', args.new_text) }; }
    }
    const creationRead = emptyOldText ? readWorkspaceText(target) : null;
    if (creationRead?.error) return { error: { ...creationRead.error, path: relative } };
    if (creationRead && creationRead.text.trim() !== '') return { error: { ok: false, path: relative, error_type: 'file_exists_no_old_text',
      error_message: 'Cannot create a new file: the existing file contains nonblank text.' } };
    const state = store.getReadState(relative), pinned = state ? { ...state } : null;
    if (emptyOldText && pinned?.partial) return { error: { ok: false, path: relative, error_type: 'file_not_fully_read',
      error_message: 'An existing whitespace-only file must be read completely before replacing it.' } };
    let error = validateReadState(target, relative, { state: pinned });
    if (error) return { error };
    const read = creationRead ?? readWorkspaceText(target);
    if (read.error) return { error: { ...read.error, path: relative } };
    error = validateReadState(target, relative, { state: pinned, content: read.text });
    if (error) return { error };
    if (emptyOldText) {
      // Existing empty files still require the same full, fresh read authority.
      const updated = emptyEditContent(read.text, args.new_text);
      guard(); return { text: read.text, pinned, emptyOldText: true,
        results: [{ ok: true, updated, replacements: 1, used_quote_normalization: false }] };
    }
    const results = await prepareWorkspaceEdits({ text: read.text, relative, edits, replaceAll: Boolean(args.replace_all) }, { signal: request.signal });
    guard();
    if (!results) return { error: { ok: false, path: relative, error_type: 'edit_match_budget_exceeded', executed: false,
      error_message: 'Edit matching exceeded its local time or memory budget. No file was changed. Use a smaller unique exact snippet.' } };
    return { text: read.text, pinned, results };
  }

  function patchFailure(code, message) { return { ok: false, error_type: code, error_message: message, executed: false }; }
  function absent(target) {
    try { lstatSync(target); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  async function preparePatch(request, guard) {
    const patch = request.call.arguments?.patch_text;
    if (typeof patch !== 'string' || patch.length > 262144) return { error: patchFailure('apply_patch_invalid_patch', 'patch_text must be a string of at most 262144 characters') };
    let sections;
    try { sections = parseStructuredPatch(patch); }
    catch (error) { return { error: patchFailure('apply_patch_invalid_patch', error.message) }; }
    if (!sections.length) return { error: patchFailure('apply_patch_empty_patch', 'Patch has no file changes') };
    if (sections.length > 64) return { error: patchFailure('patch_budget_exceeded', 'At most 64 file sections are allowed') };
    const changes = [], paths = new Set(); let bytes = 0;
    for (const section of sections) {
      const target = resolvePath(section.path), rel = relativeOf(target);
      const moveTarget = section.movePath === undefined ? undefined : resolvePath(section.movePath);
      for (const path of [target, ...(moveTarget ? [moveTarget] : [])]) {
        if (paths.has(path) || [...paths].some(other => path.startsWith(other + '/') || other.startsWith(path + '/')))
          return { error: patchFailure('patch_path_conflict', 'A file path is repeated, aliases another path or overlaps another file in the patch') };
        paths.add(path);
      }
      if ((section.type === 'add' && !absent(target)) || (moveTarget && !absent(moveTarget)))
        return { error: patchFailure('apply_patch_file_exists', 'An add or move destination already exists') };
      let text = '', pinned, mode;
      if (section.type !== 'add') {
        const read = readWorkspaceText(target);
        if (read.error) return { error: patchFailure('apply_patch_file_not_exist', `${rel}: ${read.error.error_message}`) };
        text = read.text; bytes += Buffer.byteLength(text);
        if (bytes > 16 * 1024 * 1024) return { error: patchFailure('patch_budget_exceeded', 'Patch source exceeds 16 MiB') };
        const stat = statSync(target, { bigint: true }), lines = splitlines(text).length;
        mode = Number(stat.mode) & 0o777;
        pinned = makeReadState({ path: rel, canonicalPath: target, contentSha256: sha256(Buffer.from(text)), mtimeNs: stat.mtimeNs,
          sizeBytes: Number(stat.size), startLine: 1, endLine: lines, totalLines: lines, partial: false });
      }
      if (section.type === 'update' && !section.chunks.length)
        return { error: patchFailure('apply_patch_invalid_patch', 'Update file section has no hunks') };
      changes.push({ section, target, rel, moveTarget, text, pinned, mode });
    }
    const result = await prepareWorkspacePatch(changes.map(({ section, text }) => ({ section, text })), { signal: request.signal });
    guard();
    if (!result) return { error: patchFailure('patch_budget_exceeded', 'Patch verification exceeded its local time or memory budget. No files changed.') };
    if (result.error) return { error: patchFailure(result.code, result.error) };
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      // The reference operates on logical LF text and writes using each file's
      // original encoding/EOL. Native currently supports UTF-8 and LF/CRLF.
      change.updated = change.text.includes('\r\n') ? result.changes[index].replaceAll('\n', '\r\n') : result.changes[index];
    }
    return { changes };
  }

  function verifyPatchChange(change) {
    if (resolvePath(change.section.path) !== change.target || change.moveTarget && resolvePath(change.section.movePath) !== change.moveTarget)
      return patchFailure('patch_path_changed', 'A patch path changed during verification');
    if (change.section.type === 'add') {
      if (!absent(change.target)) return patchFailure('apply_patch_file_exists', 'An add destination was created during verification');
    } else {
      const read = readWorkspaceText(change.target);
      if (read.error) return { ...read.error, path: change.rel };
      const stale = validateReadState(change.target, change.rel, { state: change.pinned, content: read.text });
      if (stale) return stale;
    }
    if (change.moveTarget && !absent(change.moveTarget)) return patchFailure('apply_patch_file_exists', 'A move destination was created during verification');
    return null;
  }

  function applyWorkspacePatch(_args, { preparedPatch }) {
    if (!preparedPatch) return patchFailure('apply_patch_not_prepared', 'Patch must be verified before publication');
    // Validate the complete captured preimage again under the publication lock.
    for (const change of preparedPatch.changes) { const error = verifyPatchChange(change); if (error) return error; }
    const files = [];
    for (const change of preparedPatch.changes) {
      activeGuard?.();
      const stale = verifyPatchChange(change);
      if (stale) {
        if (activeMutations.size) throw Object.assign(Error(stale.error_message), { code: 'patch_publication_incomplete' });
        return stale;
      }
      const type = change.moveTarget ? 'move' : change.section.type;
      if (type === 'delete') { remove(change.target); }
      else {
        const target = change.moveTarget ?? change.target;
        publish(target, Buffer.from(change.updated), { createOnly: type === 'add' || type === 'move',
          ...(type === 'move' ? { checkpointMode: change.mode } : {}) });
        if (type === 'move') { activeGuard?.(); assertCheckpointPath(target); chmodSync(target, change.mode); remove(change.target); }
        refreshReadState(relativeOf(target), statSync(target, { bigint: true }), change.updated, target);
      }
      const path = change.moveTarget ? relativeOf(change.moveTarget) : change.rel;
      const diff = buildDiff(path, change.text, change.updated);
      files.push({ path: change.rel, type, ...(change.moveTarget ? { move_path: path } : {}), diff,
        diff_sha256: sha256(Buffer.from(diff)), ...changeCounts(change.text, change.updated) });
    }
    return { ok: true, files, changed_paths: [...activeMutations], summary: files.map(file => `${file.type}: ${file.path}${file.move_path ? ` -> ${file.move_path}` : ''}`).join('\n') };
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
      return { stat: null, error: { ok: false, path: rel, error_type: e.code?.startsWith('checkpoint_') ? e.code : 'publish_failed', error_message: e.message } };
    }
    const stat = statSync(target, { bigint: true });
    refreshReadState(rel, stat, updated, target);
    return { stat, error: null };
  }

  function refreshReadState(rel, stat, text, target) {
    const lines = splitlines(text);
    rememberRead(makeReadState({
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
      activeGuard?.();
      if (info.isDirectory()) {
        remove(target, true);
      } else {
        remove(target);
      }
      activeMutations?.add(relativeOf(target));
    } catch (e) {
      return { ok: false, error_message: `workspace delete failed: ${e.message}` };
    }
    return { ok: true, deleted: relativeOf(target) };
  }

  // ---- definitions ----------------------------------------------------------

  const definitions = workspaceToolDefinitions();
  if (enablePatches) definitions.push(workspacePatchDefinition());
  if (enableRewind) {
    for (const definition of definitions) if (MUTATING.has(definition.name)) {
      definition.workspaceCheckpointPolicy = WORKSPACE_CHECKPOINT_POLICY;
      definition.recoveryPolicy = 'receipt-observation/v1';
      definition.workspaceRepairPolicy = 'preimage-compensation/v1';
    }
    definitions.push(...workspaceRewindDefinitions());
    definitions.find(tool => tool.name === 'rewind_workspace_files').workspaceRepairPolicy = 'preimage-compensation/v1';
  }

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
    ...(enablePatches ? { apply_workspace_patch: applyWorkspacePatch } : {}),
    ...(enableRewind ? {
      list_workspace_checkpoints: () => ({ ok: true, checkpoints: checkpoints.list() }),
      preview_workspace_rewind: (args, { checkpointCommitted }) => checkpoints.preview(args.checkpoint_id, checkpointCommitted).content,
      rewind_workspace_files: (_args, { preparedRewind }) => {
        for (const file of preparedRewind.files) {
          activeGuard?.(); const target = resolvePath(file.path);
          if (target !== file.canonicalPath) throw Object.assign(Error('checkpoint_path_changed'), { code: 'checkpoint_path_changed' });
          if (!checkpointStatesEqual(captureCheckpointFile(target), file.current)) throw Object.assign(Error('checkpoint_external_modified'), { code: 'checkpoint_external_modified' });
          if (checkpointStatesEqual(file.current, file.desired)) continue;
          if (file.desired.kind === 'absent') {
            if (existsSync(target)) remove(target, lstatSync(target).isDirectory());
          } else if (file.desired.kind === 'directory') {
            if (file.current.kind === 'file') remove(target);
            activeCheckpoint?.stage(file.path, file.desired); activeGuard?.(); assertCheckpointPath(target); mkdirSync(target, { recursive: true, mode: file.desired.mode });
            activeMutations.add(file.path); activePublications?.set(file.path, { kind: 'directory', mode: file.desired.mode & ~process.umask() });
            activeGuard?.(); assertCheckpointPath(target); chmodSync(target, file.desired.mode); activePublications?.set(file.path, file.desired);
          } else {
            if (file.current.kind === 'directory') remove(target, true);
            const bytes = Buffer.from(file.desired.bytes, 'base64'); publish(target, bytes, { checkpointMode: file.desired.mode });
            activeGuard?.(); assertCheckpointPath(target); chmodSync(target, file.desired.mode); activePublications?.set(file.path, file.desired);
            try {
              const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
              refreshReadState(file.path, statSync(target, { bigint: true }), text, target);
            } catch (error) { if (!(error instanceof TypeError)) throw error; }
          }
        }
        return { ok: true, rewound_checkpoint_ids: preparedRewind.ids, changed_paths: [...activeMutations] };
      },
    } : {}),
  };

  // ---- execute --------------------------------------------------------------

  async function execute(request, { assertCurrent, checkpointCommitted } = {}) {
    if (!request || typeof request !== 'object') {
      return { status: 'error', content: { code: 'invalid_request', message: 'request object required' } };
    }
    if (request.sessionId !== store.sessionId) return { status: 'error', content: { code: 'workspace_session_mismatch' } };
    const call = request.call;
    if (!call || !call.name) {
      return { status: 'error', content: { code: 'invalid_request', message: 'request.call.name required' } };
    }
    const name = call.name;
    const impl = impls[name];
    if (!impl) return { status: 'error', content: { code: 'unknown_tool', message: `unknown tool: ${name}` } };
    const signal = request.signal;
    const mutating = MUTATING.has(name);
    let guard;
    try { guard = workspaceMutationGuard(request, mutating ? assertCurrent : undefined, checkRootBoundary); }
    catch (error) { return { status: 'error', content: { code: error.code || 'invalid_request' } }; }

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

    let result, preparedEdit, preparedPatch;
    if (name === 'apply_workspace_patch') {
      if (request.definition?.workspacePatchPolicy !== 'zcode-patch/v1') return { status: 'error', content: { code: 'invalid_workspace_patch_policy' } };
      try {
        preparedPatch = await preparePatch(request, guard);
        if (preparedPatch.error) return { status: 'error', content: preparedPatch.error };
      } catch (error) {
        if (signal?.aborted) return canceled();
        return { status: 'error', content: { ok: false, error_type: error.code || 'apply_patch_verification_failed', error_message: error.message, executed: false } };
      }
    }
    // Matching runs before the publication lock, with strings only. The locked
    // commit rechecks the captured read state and content after this await.
    if (request.definition?.workspaceEditPolicy !== undefined) {
      if (!['zcode-match/v1', 'zcode-match/v2'].includes(request.definition.workspaceEditPolicy) || !['edit_workspace_file', 'multi_edit_workspace_file'].includes(name))
        return { status: 'error', content: { code: 'invalid_workspace_edit_policy' } };
      try {
        preparedEdit = await prepareEdit(request, guard);
        if (preparedEdit.error) return { status: 'error', content: preparedEdit.error };
      } catch (error) {
        if (signal?.aborted) return canceled();
        return { status: 'error', content: { ok: false, error_type: error instanceof WorkspacePathError ? 'path_escape' : error.code || 'edit_match_failed',
          error_message: error.message, executed: false } };
      }
    }
    const mutations = new Set(), publications = new Map(), reads = new Map(), displayChanges = new Map(), previousDisplayChanges = activeDisplayChanges,
      previousMutations = activeMutations, previousGuard = activeGuard,
      previousCheckpoint = activeCheckpoint, previousPublications = activePublications, previousReads = activeReads;
    let release, checkpoint, preparedRewind;
    try {
      if (mutating) release = acquireWorkspaceMutationLock(pinnedRootReal);
      guard();
      activeMutations = mutations; activeGuard = guard; activeReads = reads; activeDisplayChanges = displayChanges;
      if (name === 'rewind_workspace_files') {
        activePublications = publications;
        if (request.definition?.workspaceCheckpointPolicy !== WORKSPACE_CHECKPOINT_POLICY) throw Object.assign(Error('checkpoint_policy_missing'), { code: 'checkpoint_policy_missing' });
        preparedRewind = checkpoints.preview(call.arguments?.checkpoint_id, checkpointCommitted);
        if (!preparedRewind.content.can_apply || preparedRewind.content.preview_token !== call.arguments?.preview_token)
          return { status: 'error', content: { ...preparedRewind.content, ok: false, error_type: 'checkpoint_rewind_conflict', executed: false } };
      }
      if (mutating && enableRewind && request.definition?.workspaceCheckpointPolicy === WORKSPACE_CHECKPOINT_POLICY)
        activeCheckpoint = checkpoint = checkpoints.begin(request, preparedRewind?.ids);
      result = impl(call.arguments ?? {}, { signal, request, preparedEdit, preparedPatch, preparedRewind, checkpointCommitted });
      guard();
      if (checkpoint) {
        if (result?.ok !== true && mutations.size) throw Object.assign(Error('checkpoint_partial_effect'), { code: 'checkpoint_partial_effect' });
        checkpoint.finish(mutations);
        if (mutations.size) result.checkpoint_id = checkpoint.id;
        guard();
      }
    } catch (e) {
      let compensationError;
      if (name === 'rewind_workspace_files' && checkpoint?.canCompensate && mutations.size && !signal?.aborted
        && !['workspace_execution_context_changed', 'workspace_execution_authority_changed', 'workspace_root_changed', 'workspace_missing'].includes(e.code)) {
        try {
          compensateRewind(preparedRewind, publications, checkpoint, guard);
          return { status: 'error', workspaceChangedPaths: [...mutations], content: { ok: false,
            error_type: 'checkpoint_rewind_compensated', cause: e.code || 'rewind_failed', compensated: true, executed: true, paths: [...mutations] } };
        } catch (error) { compensationError = error; }
      }
      if (checkpoint && !mutations.size) { try { checkpoint.fail(); } catch {} }
      if (signal?.aborted && !mutations.size) return canceled();
      if (e instanceof WorkspacePathError && !mutations.size) {
        return { status: 'error', content: { ok: false, error_type: 'path_escape', error_message: e.message } };
      }
      if (mutations.size) return { status: 'uncertain', workspaceChangedPaths: [...mutations],
        content: { ok: false, error_type: compensationError ? 'checkpoint_compensation_incomplete'
          : name === 'apply_workspace_patch' ? 'patch_publication_incomplete' : 'state_persist_failed',
        ...(compensationError ? { compensation_reason: compensationError.code || 'compensation_failed' } : {}), executed: true, paths: [...mutations] } };
      return { status: 'error', content: { ok: false, error_type: e.code || 'internal_error', error_message: e.message } };
    } finally { activeMutations = previousMutations; activeGuard = previousGuard; activeCheckpoint = previousCheckpoint; activeDisplayChanges = previousDisplayChanges;
      activePublications = previousPublications; activeReads = previousReads; release?.(); }
    // The only asynchronous implementation parses captured read-only bytes.
    // Restore mutation tracking before any await so concurrent writers cannot
    // attribute their publications to this invocation.
    if (result && typeof result.then === 'function') {
      try { result = await result; }
      catch (error) {
        if (signal?.aborted) return canceled();
        return { status: 'error', content: { ok: false, error_type: error.code || 'python_syntax_unavailable',
          error_message: error.message } };
      }
    }
    if (signal?.aborted && !(result && result.ok)) return canceled();

    if (result && result.ok === true) {
      const out = { status: 'ok', content: result };
      // Durable Host facts, excluded from model/display output. Restore only
      // exact full observations from successful selected historical calls.
      if (reads.size && ['read_workspace_file', 'write_workspace_file', 'write_workspace_files',
        'edit_workspace_file', 'multi_edit_workspace_file', 'apply_workspace_patch'].includes(name))
        out.metadata = { nativeWorkspaceReads: { contract: 'native-workspace-read-observation/v1', tool: name, states: [...reads.values()] } };
      const presentation = displayChanges.size ? workspaceChangeDisplay(displayChanges) : null;
      if (presentation) out.metadata = { ...out.metadata, nativeTaskDisplay: presentation };
      // Only mutating tools report workspace-changed paths; reads must not.
      if (mutating) {
        const changed = extractChangedPaths(result);
        if (changed.length) out.workspaceChangedPaths = changed;
      }
      return out;
    }
    return { status: 'error', content: result, ...(mutations.size ? { workspaceChangedPaths: [...mutations] } : {}) };
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
    if (request.sessionId !== store.sessionId) return { revision: null, changedPaths: [], status: 'unavailable', reason: 'workspace_session_mismatch' };
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
    return 'sha256:' + captureStable(real).digest;
  }

  function captureStable(real) {
    const first = captureInventory(real);
    const second = captureInventory(real);
    if (first.digest !== second.digest
      || first.entryCount !== second.entryCount
      || !entriesEqual(first.entries, second.entries)) {
      throw new CaptureError('workspace_changed_during_capture');
    }
    return second;
  }

  function captureInventory(real) {
    const hash = createHash('sha256');
    hash.update('ksadk.directory-workspace/v1\0');
    const state = { entries: 0, hashedBytes: 0, list: [], byPath: Object.create(null) };
    scanDir(real, '', hash, state);
    state.list.sort();
    return { digest: hash.digest('hex'), entryCount: state.entries, entries: state.list, byPath: state.byPath };
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
      state.byPath[entryRel] = info.isDirectory() ? `directory:${before}` : state.list.at(-1);
      if (state.hashedBytes > OBSERVE_MAX_HASHED) throw new CaptureError('capture_limit_exceeded');
    }
  }

  /** Stable identity tuple for an entry: mode, size, mtimeNs, ctimeNs, ino. */
  function entryIdentity(info) {
    return `${info.mode}|${info.size}|${info.mtimeNs}|${info.ctimeNs}|${info.ino}`;
  }

  function recordReceipt(request, result, { assertCurrent } = {}) {
    if (!enableRewind || request.definition?.workspaceCheckpointPolicy !== WORKSPACE_CHECKPOINT_POLICY
      || request.definition?.recoveryPolicy !== 'receipt-observation/v1' || !['ok', 'error'].includes(result.status)) return;
    const guard = workspaceMutationGuard(request, assertCurrent, checkRootBoundary);
    guard(); checkpoints.recordReceipt(request, result); guard();
  }
  async function observeReceipt(request, { assertCurrent } = {}) {
    const signal = request.signal, sealed = canonical({ ...request, signal: null });
    const check = () => {
      checkRootBoundary(); signal?.throwIfAborted();
      if (request.sessionId !== store.sessionId || request.signal !== signal || canonical({ ...request, signal: null }) !== sealed
        || request.contract !== 'agentkit.tool-receipt-observation/v1' || request.definition?.workspaceCheckpointPolicy !== WORKSPACE_CHECKPOINT_POLICY
        || request.definition?.recoveryPolicy !== 'receipt-observation/v1' || typeof assertCurrent !== 'function' || assertCurrent(request) !== true)
        throw Object.assign(Error('checkpoint_receipt_authority_changed'), { code: 'checkpoint_receipt_authority_changed' });
    };
    check(); const result = checkpoints.readReceipt(request); check();
    return { contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result };
  }
  async function repairWorkspace(request, { assertCurrent } = {}) {
    const envelope = result => ({ contract: request.contract, originalOperationKey: request.originalOperationKey,
      callId: request.call.callId, result });
    if (request.contract !== 'agentkit.workspace-compensation/v1' || request.sessionId !== store.sessionId
      || request.definition?.workspaceRepairPolicy !== 'preimage-compensation/v1'
      || request.definition?.workspaceCheckpointPolicy !== WORKSPACE_CHECKPOINT_POLICY || typeof assertCurrent !== 'function')
      throw Object.assign(Error('checkpoint_repair_authority_missing'), { code: 'checkpoint_repair_authority_missing' });
    const guard = workspaceMutationGuard(request, assertCurrent, checkRootBoundary);
    let release;
    try {
      guard(); release = acquireWorkspaceMutationLock(pinnedRootReal); guard();
      const plan = checkpoints.prepareRepair(request); guard();
      if (plan.result) return envelope(plan.result);
      for (const file of plan.files) {
        const check = () => { guard(); if (resolvePath(file.path) !== file.canonicalPath)
          throw Object.assign(Error('checkpoint_path_changed'), { code: 'checkpoint_path_changed' }); };
        check(); const current = captureCheckpointFile(file.canonicalPath);
        if (!checkpointStatesEqual(current, file.current)) throw Object.assign(Error('checkpoint_external_modified'), { code: 'checkpoint_external_modified' });
        if (checkpointStatesEqual(current, file.before)) continue;
        if (current.kind !== 'absent' && current.kind !== file.before.kind) {
          check(); if (current.kind === 'directory') rmdirSync(file.canonicalPath); else unlinkSync(file.canonicalPath);
        }
        if (file.before.kind === 'file') {
          check(); publishWorkspaceBytes(file.canonicalPath, Buffer.from(file.before.bytes, 'base64'));
          check(); chmodSync(file.canonicalPath, file.before.mode);
        } else if (file.before.kind === 'directory') {
          check(); mkdirSync(file.canonicalPath, { recursive: true, mode: file.before.mode });
          check(); chmodSync(file.canonicalPath, file.before.mode);
        }
        check();
      }
      guard(); plan.complete(); guard();
      return envelope({ status: 'error', workspaceChangedPaths: plan.files.map(file => file.path), content: {
        ok: false, error_type: 'workspace_operation_compensated', compensated: true,
        original_operation_key: request.originalOperationKey, paths: plan.files.map(file => file.path),
        message: 'The unconfirmed workspace operation was explicitly compensated. Its original success is not asserted.' } });
    } finally { release?.(); }
  }
  function recordRepairReceipt(request, result, { assertCurrent } = {}) {
    const guard = workspaceMutationGuard(request, assertCurrent, checkRootBoundary);
    guard(); checkpoints.recordRepairReceipt(request, result); guard();
  }
  // Explicit authenticated Host action, with its own journaled intent/result.
  // Reuses the workspace publisher/lock, never fabricates a Native tool claim.
  function conversationWorkspace(control, { signal, assertCurrent, checkpointCommitted, selectCheckpoint }, apply) {
    if (!enableRewind || control?.contract !== CONVERSATION_WORKSPACE_CONTROL || control.sessionId !== store.sessionId
      || !(signal instanceof AbortSignal) || typeof assertCurrent !== 'function' || typeof selectCheckpoint !== 'function'
      || typeof checkpointCommitted !== 'function') throw Object.assign(Error('checkpoint_control_authority_missing'), { code: 'checkpoint_control_authority_missing' });
    const frozen = canonical(control);
    const guard = () => {
      signal.throwIfAborted(); checkRootBoundary();
      const valid = assertCurrent();
      if (valid && typeof valid.then === 'function') Promise.resolve(valid).catch(() => {});
      if (valid !== true || canonical(control) !== frozen) throw Object.assign(Error('workspace_execution_authority_changed'), { code: 'workspace_execution_authority_changed' });
      signal.throwIfAborted();
    };
    guard(); const release = acquireWorkspaceMutationLock(pinnedRootReal);
    const previous = [activeMutations, activeGuard, activeCheckpoint, activePublications, activeReads];
    const mutations = new Set(), publications = new Map();
    let checkpoint, plan;
    try {
      guard();
      const previousControl = apply ? checkpoints.controlRecord(control) : null;
      if (previousControl?.status === 'completed') { const result = checkpoints.completeControl(control); guard(); return result; }
      if (previousControl) {
        if (['prepared', 'compensating'].includes(previousControl.status)) {
          const repair = checkpoints.prepareControlRepair(control); guard();
          restoreRepairPlan(repair, guard); guard(); repair.complete(); guard();
        }
        throw Object.assign(Error('checkpoint_control_compensated'), { code: 'checkpoint_control_compensated' });
      }
      const rows = checkpoints.controlRows();
      if (rows.some(row => ['prepared', 'compensating'].includes(row.status))) throw Object.assign(Error('checkpoint_outcome_unknown'), { code: 'checkpoint_outcome_unknown' });
      const checkpointId = selectCheckpoint(rows); guard();
      plan = checkpointId ? checkpoints.preview(checkpointId, checkpointCommitted) : { ids: [], files: [], content: { can_apply: true, unsafe_files: [] } };
      const { requestDigest: _digest, workspacePreviewToken: _token, ...identity } = control;
      const previewToken = sha256(canonical({ identity, checkpointId, plan: plan.content.preview_token ?? null }));
      const preview = { contract: CONVERSATION_WORKSPACE_CONTROL, checkpointId, previewToken, canApply: plan.content.can_apply,
        files: plan.content.files ?? [], unsafeFiles: plan.content.unsafe_files };
      if (!apply) return preview;
      if (!preview.canApply || previewToken !== control.workspacePreviewToken) throw Object.assign(Error('checkpoint_rewind_conflict'), { code: 'checkpoint_rewind_conflict' });
      if (!checkpointId) return { contract: CONVERSATION_WORKSPACE_CONTROL, requestDigest: control.requestDigest,
        checkpointId: null, rewoundCheckpointIds: [], changedPaths: [], previewToken };
      guard(); checkpoint = checkpoints.beginControl(control, plan);
      activeMutations = mutations; activeGuard = guard; activeCheckpoint = checkpoint; activePublications = publications; activeReads = new Map();
      impls.rewind_workspace_files({}, { preparedRewind: plan }); guard();
      checkpoint.finish(mutations); guard();
      const result = checkpoints.completeControl(control); guard(); return result;
    } catch (error) {
      if (checkpoint?.canCompensate && mutations.size && !signal.aborted
        && !['workspace_execution_authority_changed', 'workspace_root_changed', 'workspace_missing'].includes(error.code)) {
        compensateRewind(plan, publications, checkpoint, guard);
      } else if (checkpoint && !mutations.size) checkpoint.fail();
      throw error;
    } finally {
      [activeMutations, activeGuard, activeCheckpoint, activePublications, activeReads] = previous;
      release();
    }
  }
  function restoreRepairPlan(plan, guard) {
    for (const file of plan.files) {
      const check = () => { guard(); if (resolvePath(file.path) !== file.canonicalPath)
        throw Object.assign(Error('checkpoint_path_changed'), { code: 'checkpoint_path_changed' }); };
      check(); const current = captureCheckpointFile(file.canonicalPath);
      if (!checkpointStatesEqual(current, file.current)) throw Object.assign(Error('checkpoint_external_modified'), { code: 'checkpoint_external_modified' });
      if (checkpointStatesEqual(current, file.before)) continue;
      if (current.kind !== 'absent' && current.kind !== file.before.kind) {
        check(); if (current.kind === 'directory') rmdirSync(file.canonicalPath); else unlinkSync(file.canonicalPath);
      }
      if (file.before.kind === 'file') {
        check(); publishWorkspaceBytes(file.canonicalPath, Buffer.from(file.before.bytes, 'base64')); check(); chmodSync(file.canonicalPath, file.before.mode);
      } else if (file.before.kind === 'directory') {
        check(); mkdirSync(file.canonicalPath, { recursive: true, mode: file.before.mode }); check(); chmodSync(file.canonicalPath, file.before.mode);
      }
      check();
    }
  }
  return { definitions, execute, observe, recordReceipt, observeReceipt, repairWorkspace, recordRepairReceipt,
    pendingConversationRewind: accepted => {
      const rows = checkpoints.pendingControlRows().filter(row => row.controlBinding && row.status !== 'failed'
        && !accepted.some(marker => marker.commandId === row.controlBinding.commandId && marker.requestDigest === row.controlBinding.requestDigest));
      if (rows.length > 1) throw Object.assign(Error('checkpoint_control_duplicate'), { code: 'checkpoint_control_duplicate' });
      return rows[0] ? structuredClone(rows[0].controlBinding) : null;
    },
    previewConversationRewind: (control, options) => conversationWorkspace(control, options, false),
    rewindConversation: (control, options) => conversationWorkspace(control, options, true),
    adoptConversationBranch: (branch, restore) => store.adoptConversationBranch(branch, () => {
      const candidates = typeof restore === 'function' ? restore() : restore ?? [];
      return candidates.filter(raw => {
        const state = deserializeReadState(raw);
        if (!state || state.partial) return false;
        try { return resolvePath(state.path) === state.canonicalPath; } catch { return false; }
      });
    }),
    // Host-only change capture for a governed command. It shares the bounded,
    // stable observer; paths remain structured even when names contain tabs.
    capture(request) {
      if (request.sessionId !== store.sessionId) throw new CaptureError('workspace_session_mismatch');
      checkRootBoundary(); const captured = captureStable(pinnedRootReal);
      return { revision: 'sha256:' + captured.digest, entries: { ...captured.byPath } };
    },
  };
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

async function defaultAuthorize(request) {
  const name = request?.call?.name;
  if (name && READ_ONLY.has(name)) return 'allow';
  return 'approval_required';
}

// ---- ToolDefinition[] -------------------------------------------------------

/** Shared execution/catalog definitions. Reading metadata performs no I/O. */
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

/** Shared by Native execution and its local Studio catalog; no workspace access. */
export function workspaceRewindDefinitions() {
  const checkpoint = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
  const read = { readOnly: true, concurrentSafe: true, permissions: ['workspace:read'] };
  return [
    def('list_workspace_checkpoints', 'List this Native Session\'s durable file checkpoints. Prepared/unknown or already rewound records are not permission to replay effects. Checkpoint contents are private and are not returned.',
      { type: 'object', additionalProperties: false, properties: {} }, read),
    def('preview_workspace_rewind', 'Preview file-only rewind from a checkpoint, including later committed changes in this Session. Refuses external modifications and uncommitted effects. Does not rewind conversation or execute files. Use the returned preview_token for an approved rewind.',
      { type: 'object', additionalProperties: false, required: ['checkpoint_id'], properties: { checkpoint_id: checkpoint } }, read),
    { ...def('rewind_workspace_files', 'Restore files from an exact successful preview. This changes workspace files, requires normal write/delete permission and is forbidden in Plan mode. It never reruns the original tools. A changed preview or unknown effect blocks the whole rewind; partial publication is uncertain and must be reconciled.',
      { type: 'object', additionalProperties: false, required: ['checkpoint_id', 'preview_token'], properties: { checkpoint_id: checkpoint, preview_token: { type: 'string', pattern: '^[0-9a-f]{64}$' } } },
      { readOnly: false, concurrentSafe: false, permissions: ['workspace:write', 'workspace:delete'] }),
      workspaceCheckpointPolicy: WORKSPACE_CHECKPOINT_POLICY, recoveryPolicy: 'receipt-observation/v1' },
  ];
}

/** Shared by Native execution and its local Studio catalog; no workspace access. */
export function workspacePatchDefinition() {
  return def('apply_workspace_patch', 'Apply a structured patch to workspace files. Use *** Begin Patch / *** End Patch, Add File, Delete File, Update File and optional Move to headers. Hunks use @@ with space/context, -/removed and +/added lines. All hunks are verified before writing. Existing move destinations and overlapping paths are refused. A multi-file publication is not atomic; an uncertain result requires reconciliation, never blind replay.', {
    type: 'object', additionalProperties: false, required: ['patch_text'], properties: { patch_text: { type: 'string', maxLength: 262144 } },
  }, { workspacePatchPolicy: 'zcode-patch/v1', readOnly: false, concurrentSafe: false,
    contextRole: 'none', permissions: ['workspace:write', 'workspace:delete'], timeoutMs: 30000 });
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
    ...(opts.workspacePatchPolicy ? { workspacePatchPolicy: opts.workspacePatchPolicy } : {}),
  };
}
