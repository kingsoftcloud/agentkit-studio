/** Native file-only rewind. Behavioral reference: ZCode 3c5b227 core/runtime/
 * methods/{tools,file-rewind,workspace-checkpoint-persistence}.ts. A prepared
 * journal is never an instruction to replay effects after process death. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical } from '../../../agentkit-harness-core/dist/index.mjs';
import { privateDirectory, privateFile, openPrivate } from './local-command-state.mjs';
import { sessionKeyFor } from './workspace-state.mjs';
import { sha256, TWO_MB, realpathExisting } from './workspace-paths.mjs';

export const WORKSPACE_CHECKPOINT_POLICY = 'file-preimages/v1';
const fail = code => { throw Object.assign(Error(code), { code }); };
const MAX_BYTES = 16 * 1024 * 1024;
export function captureCheckpointFile(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return { kind: 'absent' }; throw error; }
  if (stat.isDirectory()) {
    if (readdirSync(path).length) fail('checkpoint_directory_not_empty');
    return { kind: 'directory', mode: stat.mode & 0o777 };
  }
  if (!stat.isFile() || stat.size > TWO_MB) fail('checkpoint_file_unsupported');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    stat = fstatSync(fd); if (!stat.isFile() || stat.size > TWO_MB) fail('checkpoint_file_unsupported');
    const buffer = Buffer.alloc(TWO_MB + 1); bytes = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0));
  }
  finally { closeSync(fd); }
  if (bytes.length > TWO_MB) fail('checkpoint_file_unsupported');
  return { kind: 'file', bytes: bytes.toString('base64'), sha256: sha256(bytes), mode: stat.mode & 0o777 };
}
export const checkpointStatesEqual = (a, b) => a.kind === b.kind && a.mode === b.mode && a.sha256 === b.sha256;

export function createWorkspaceCheckpointJournal({ stateDir, sessionId, workspaceRoot, resolvePath }) {
  const filename = join(realpathExisting(stateDir), sessionKeyFor(sessionId), 'checkpoints', 'files.sqlite');
  const rootDigest = sha256(workspaceRoot);
  function database(write, action) {
    if (!write && !existsSync(filename)) return action(null);
    if (write) { privateDirectory(dirname(filename), true); const fd = openPrivate(filename, constants.O_RDWR | constants.O_CREAT); closeSync(fd); }
    else { privateDirectory(dirname(filename)); privateFile(filename); }
    for (const suffix of ['-journal', '-wal', '-shm']) privateFile(filename + suffix, true);
    const db = new DatabaseSync(filename, { readOnly: !write });
    try {
      if (write) db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS checkpoints (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL)');
      return action(db);
    } finally { db.close(); }
  }
  function decode(row) {
    if (sha256(row.body) !== row.digest) fail('checkpoint_corrupt');
    const value = JSON.parse(row.body);
    if (value.rootDigest !== rootDigest || value.sessionId !== sessionId || value.policy !== WORKSPACE_CHECKPOINT_POLICY) fail('checkpoint_binding_changed');
    return { ...value, seq: Number(row.seq) };
  }
  const rows = () => database(false, db => db ? db.prepare('SELECT * FROM checkpoints ORDER BY seq').all().map(decode) : []);
  function save(value, undone = []) {
    const copy = { ...value }; delete copy.seq;
    database(true, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const put = item => { const body = canonical(item); db.prepare('INSERT INTO checkpoints(id,body,digest) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,digest=excluded.digest').run(item.id, body, sha256(body)); };
        put(copy);
        for (const id of undone) {
          const old = decode(db.prepare('SELECT * FROM checkpoints WHERE id=?').get(id)); delete old.seq;
          put({ ...old, status: 'undone', undoneBy: value.id });
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  function begin(request, rewindOf = []) {
    if (!request.operationKey || !request.call?.callId) fail('checkpoint_execution_binding_missing');
    const existing = rows();
    if (existing.some(row => row.status === 'prepared')) fail('checkpoint_outcome_unknown');
    const binding = Object.fromEntries(['scope', 'sessionId', 'runId', 'turnId', 'buildId', 'operationKey', 'executionFence']
      .filter(key => request[key] !== undefined).map(key => [key, structuredClone(request[key])]));
    binding.callId = request.call.callId; binding.toolName = request.call.name;
    // Ownership transfer changes the fence, not the identity of the effect.
    // A durable completed publication must not run again just because its
    // original Native receipt was lost before a new owner acquired the Run.
    const operationIdentity = value => canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'executionFence')));
    if (existing.some(row => row.status !== 'failed' && operationIdentity(row.binding) === operationIdentity(binding))) fail('checkpoint_operation_already_recorded');
    const record = { policy: WORKSPACE_CHECKPOINT_POLICY, rootDigest, sessionId, id: randomUUID(), createdAt: new Date().toISOString(),
      status: 'prepared', binding, files: [], rewindOf };
    save(record);
    return {
      id: record.id,
      stage(path, after) {
        if (Buffer.byteLength(after.bytes ?? '', 'base64') > TWO_MB) fail('checkpoint_budget_exceeded');
        const target = resolvePath(path), before = captureCheckpointFile(target);
        if (after.kind === 'file' && after.mode === undefined && before.kind === 'file') after = { ...after, mode: before.mode };
        const entry = record.files.find(file => file.path === path);
        if (entry && entry.canonicalPath !== target) fail('checkpoint_path_changed');
        const replacement = entry ? { ...entry, after } : { path, canonicalPath: target, before, after };
        const files = entry ? record.files.map(file => file === entry ? replacement : file) : [...record.files, replacement];
        if (files.length > 100 || files.reduce((size, file) => size + Buffer.byteLength(file.before.bytes ?? '', 'base64')
          + Buffer.byteLength(file.after.bytes ?? '', 'base64'), 0) > MAX_BYTES) fail('checkpoint_budget_exceeded');
        record.files = files;
        save(record);
      },
      finish(paths) {
        record.files = record.files.filter(file => paths.has(file.path));
        for (const file of record.files) {
          if (resolvePath(file.path) !== file.canonicalPath) fail('checkpoint_path_changed');
          const actual = captureCheckpointFile(file.canonicalPath);
          if (actual.kind !== file.after.kind || actual.sha256 !== file.after.sha256
            || file.after.mode !== undefined && actual.mode !== file.after.mode) fail('checkpoint_postimage_changed');
          file.after = actual;
        }
        record.status = record.files.length ? 'completed' : 'failed'; save(record, record.files.length ? rewindOf : []);
      },
      fail() { record.status = 'failed'; save(record); },
    };
  }
  function preview(checkpointId, committed) {
    const all = rows(), target = all.find(row => row.id === checkpointId);
    if (!target) fail('checkpoint_not_found');
    const selected = all.filter(row => row.seq >= target.seq && row.status !== 'undone' && row.status !== 'failed');
    const unsafe = [], states = new Map();
    if (target.status !== 'completed' || all.some(row => row.status === 'prepared')) unsafe.push({ reason: 'checkpoint_outcome_unknown' });
    for (const row of selected.toReversed()) {
      if (row.status !== 'completed' || committed?.(row) !== true) { unsafe.push({ checkpoint_id: row.id, reason: 'checkpoint_receipt_uncommitted' }); continue; }
      for (const file of row.files.toReversed()) {
        let state;
        try {
          if (resolvePath(file.path) !== file.canonicalPath) fail('checkpoint_path_changed');
          state = states.get(file.path);
          if (!state) { const current = captureCheckpointFile(file.canonicalPath); state = { current, desired: current, path: file.path }; }
          if (!checkpointStatesEqual(state.desired, file.after)) fail('checkpoint_external_modified');
          state.desired = file.before; states.set(file.path, state);
        } catch (error) { unsafe.push({ path: file.path, reason: error.code || 'checkpoint_read_failed' }); }
      }
    }
    const files = [...states.values()], ids = selected.map(row => row.id);
    const token = sha256(canonical({ checkpointId, files, ids }));
    return { files, ids, content: { ok: true, checkpoint_id: checkpointId, preview_token: token,
      can_apply: files.length > 0 && unsafe.length === 0, unsafe_files: unsafe,
      files: files.map(file => ({ path: file.path, action: file.desired.kind === 'absent' ? 'delete' : 'restore',
        current_sha256: file.current.sha256 ?? null, restored_sha256: file.desired.sha256 ?? null })) } };
  }
  return { begin, preview, list: () => rows().toReversed().slice(0, 50).map(row => ({ checkpoint_id: row.id, created_at: row.createdAt,
    status: row.status, run_id: row.binding.runId ?? null, tool: row.binding.toolName, paths: row.files.map(file => file.path) })) };
}

/** Actual committed success, not a journal, UI inventory or model claim. */
export function committedWorkspaceCheckpoint(row, { store, scope, sessionId }) {
  if (!row.binding.scope || !scope || row.sessionId !== sessionId || canonical(row.binding.scope) !== canonical(scope)) return false;
  let record;
  try { record = store.load(scope, row.binding.runId); } catch { return false; }
  if (!record || record.snapshot.sessionId !== sessionId || record.snapshot.buildId !== row.binding.buildId) return false;
  const intent = record.intents.find(item => item.operationKey === row.binding.operationKey && item.kind === 'tool');
  const index = intent?.payload.calls?.findIndex(call => call.callId === row.binding.callId && call.name === row.binding.toolName) ?? -1;
  if (index < 0 || intent.claimedFence !== row.binding.executionFence
    || record.snapshot.turnId !== row.binding.turnId
    || !record.configuration.tools.some(tool => tool.name === row.binding.toolName && tool.workspaceCheckpointPolicy === WORKSPACE_CHECKPOINT_POLICY)) return false;
  return record.receipts.some(receipt => receipt.operationKey === row.binding.operationKey && receipt.status === 'committed'
    && receipt.result.results?.[index]?.status === 'ok' && receipt.result.results[index].content?.checkpoint_id === row.id);
}
