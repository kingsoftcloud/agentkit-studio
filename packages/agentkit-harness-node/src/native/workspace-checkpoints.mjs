/** Native file-only rewind. A prepared
 * journal is never an instruction to replay effects after process death. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { privateDirectory, privateFile, openPrivate } from './local-command-state.mjs';
import { sessionKeyFor } from './workspace-state.mjs';
import { sha256, TWO_MB, realpathExisting } from './workspace-paths.mjs';

export const WORKSPACE_CHECKPOINT_POLICY = 'file-preimages/v1';
export const CONVERSATION_WORKSPACE_CONTROL = 'agentkit.native-conversation-workspace-control/v1';
const fail = code => { throw Object.assign(Error(code), { code }); };
const MAX_BYTES = 16 * 1024 * 1024;
const unsettled = row => ['prepared', 'compensating'].includes(row.status);
const operationIdentity = value => canonical(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'executionFence')));
const stateIdentity = ({ kind, sha256, mode }) => ({ kind, ...(sha256 !== undefined ? { sha256 } : {}), ...(mode !== undefined ? { mode } : {}) });
const uniqueStates = states => [...new Map(states.map(state => [canonical(stateIdentity(state)), stateIdentity(state)])).values()];
const repairStatesFor = (row, path) => row.repairStates && Object.hasOwn(row.repairStates, path) ? row.repairStates[path] : [];
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
  function save(value, undone = [], restoreUndone = false) {
    const copy = { ...value }; delete copy.seq;
    database(true, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const put = item => { const body = canonical(item); db.prepare('INSERT INTO checkpoints(id,body,digest) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,digest=excluded.digest').run(item.id, body, sha256(body)); };
        put(copy);
        for (const id of undone) {
          const old = decode(db.prepare('SELECT * FROM checkpoints WHERE id=?').get(id)); delete old.seq;
          if (restoreUndone) {
            if (old.status !== 'undone' || old.undoneBy !== value.id) fail('checkpoint_repair_chain_changed');
            const previous = value.rewindStates?.find(item => item.id === id);
            delete old.undoneBy;
            put({ ...old, status: previous?.status ?? 'completed', ...(previous?.undoneBy ? { undoneBy: previous.undoneBy } : {}) });
          } else put({ ...old, status: 'undone', undoneBy: value.id });
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  function begin(request, rewindOf = []) {
    if (!request.operationKey || !request.call?.callId) fail('checkpoint_execution_binding_missing');
    const existing = rows();
    if (existing.some(unsettled)) fail('checkpoint_outcome_unknown');
    const binding = Object.fromEntries(['scope', 'sessionId', 'runId', 'turnId', 'buildId', 'operationKey', 'executionFence']
      .filter(key => request[key] !== undefined).map(key => [key, structuredClone(request[key])]));
    binding.callId = request.call.callId; binding.toolName = request.call.name;
    // Ownership transfer changes the fence, not the identity of the effect.
    // A durable completed publication must not run again just because its
    // original Native receipt was lost before a new owner acquired the Run.
    if (existing.some(row => row.binding && row.status !== 'failed' && operationIdentity(row.binding) === operationIdentity(binding))) fail('checkpoint_operation_already_recorded');
    const record = { policy: WORKSPACE_CHECKPOINT_POLICY, rootDigest, sessionId, id: randomUUID(), createdAt: new Date().toISOString(),
      status: 'prepared', binding, callDigest: sha256(canonical(request.call)), definitionDigest: sha256(canonical(request.definition)), files: [], rewindOf };
    return beginRecord(record, rewindOf);
  }
  function beginRecord(record, rewindOf) {
    const previous = new Map(rows().map(row => [row.id, row]));
    record.rewindStates = rewindOf.map(id => {
      const row = previous.get(id);
      if (!row) fail('checkpoint_not_found');
      return { id, status: row.status, ...(row.undoneBy ? { undoneBy: row.undoneBy } : {}) };
    });
    save(record);
    return {
      id: record.id,
      get canCompensate() { return record.status === 'prepared'; },
      stage(path, after) {
        if (Buffer.byteLength(after.bytes ?? '', 'base64') > TWO_MB) fail('checkpoint_budget_exceeded');
        const target = resolvePath(path), before = captureCheckpointFile(target);
        if (after.kind === 'file' && after.mode === undefined) after = { ...after,
          mode: before.kind === 'file' ? before.mode : 0o666 & ~process.umask() };
        const entry = record.files.find(file => file.path === path);
        if (entry && entry.canonicalPath !== target) fail('checkpoint_path_changed');
        const intermediateStates = uniqueStates([...(entry?.intermediateStates ?? []), ...(entry ? [stateIdentity(before)] : []),
          ...(after.kind === 'file' ? [{ ...stateIdentity(after), mode: before.kind === 'file' ? before.mode : 0o666 & ~process.umask() }] : [])]);
        const replacement = { ...(entry ?? { path, canonicalPath: target, before }), after, intermediateStates };
        const files = entry ? record.files.map(file => file === entry ? replacement : file) : [...record.files, replacement];
        if (files.length > 100 || files.reduce((size, file) => size + Buffer.byteLength(file.before.bytes ?? '', 'base64')
          + Buffer.byteLength(file.after.bytes ?? '', 'base64'), 0) > MAX_BYTES) fail('checkpoint_budget_exceeded');
        record.files = files;
        save(record);
        return before;
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
        const completed = record.files.length > 0 || Boolean(record.controlBinding);
        record.status = completed ? 'completed' : 'failed'; save(record, completed ? rewindOf : []);
      },
      fail() { record.status = 'failed'; save(record); },
      compensating() { record.status = 'compensating'; save(record); },
      compensated() {
        for (const file of record.files) {
          if (resolvePath(file.path) !== file.canonicalPath || !checkpointStatesEqual(captureCheckpointFile(file.canonicalPath), file.before)) fail('checkpoint_compensation_conflict');
        }
        record.status = 'failed'; record.compensated = true; save(record);
      },
    };
  }
  function preview(checkpointId, committed) {
    const all = rows(), target = all.find(row => row.id === checkpointId);
    if (!target) fail('checkpoint_not_found');
    const suffix = all.filter(row => row.seq >= target.seq && row.status !== 'failed');
    // An undo is itself a publication. If its inverse is in this suffix,
    // include the original publication too, so earlier cuts do not resurrect
    // files from an already removed branch.
    const selected = suffix.filter(row => row.status !== 'undone' || suffix.some(inverse => inverse.id === row.undoneBy));
    const unsafe = [], states = new Map();
    if (target.status !== 'completed' || all.some(unsettled)) unsafe.push({ reason: 'checkpoint_outcome_unknown' });
    for (const row of selected.toReversed()) {
      if (!['completed', 'undone'].includes(row.status) || committed?.(row) !== true) { unsafe.push({ checkpoint_id: row.id, reason: 'checkpoint_receipt_uncommitted' }); continue; }
      for (const file of row.files.toReversed()) {
        let state;
        try {
          if (resolvePath(file.path) !== file.canonicalPath) fail('checkpoint_path_changed');
          state = states.get(file.path);
          if (!state) { const current = captureCheckpointFile(file.canonicalPath); state = { current, desired: current, path: file.path, canonicalPath: file.canonicalPath }; }
          if (!checkpointStatesEqual(state.desired, file.after)) fail('checkpoint_external_modified');
          state.desired = file.before; states.set(file.path, state);
        } catch (error) { unsafe.push({ path: file.path, reason: error.code || 'checkpoint_read_failed' }); }
      }
    }
    const files = [...states.values()], ids = selected.map(row => row.id);
    if (files.length > 100 || files.reduce((size, file) => size + Buffer.byteLength(file.current.bytes ?? '', 'base64')
      + Buffer.byteLength(file.desired.bytes ?? '', 'base64'), 0) > MAX_BYTES) unsafe.push({ reason: 'checkpoint_budget_exceeded' });
    const token = sha256(canonical({ checkpointId, files, ids }));
    return { files, ids, content: { ok: true, checkpoint_id: checkpointId, preview_token: token,
      can_apply: files.length > 0 && unsafe.length === 0, unsafe_files: unsafe,
      files: files.map(file => ({ path: file.path, action: file.desired.kind === 'absent' ? 'delete' : 'restore',
        current_sha256: file.current.sha256 ?? null, restored_sha256: file.desired.sha256 ?? null })) } };
  }
  function originalRecord(request, original = false) {
    return rows().toReversed().find(row =>
      row.binding && ['scope', 'sessionId', 'runId', 'turnId', 'buildId'].every(key => canonical(row.binding[key] ?? null) === canonical(request[key] ?? null))
      && row.binding.operationKey === (original ? request.originalOperationKey : request.operationKey)
      && row.binding.executionFence === (original ? request.originalClaimedFence : request.executionFence)
      && row.callDigest === sha256(canonical(request.call)) && row.definitionDigest === sha256(canonical(request.definition)));
  }
  function receiptRecord(request, original = false) {
    const row = originalRecord(request, original);
    return row && ['completed', 'failed'].includes(row.status) ? row : undefined;
  }
  function prepareRepairRow(row) {
      if (!row || row.receipt || !['prepared', 'compensating', 'completed', 'failed'].includes(row.status)
        || rows().some(other => other.seq > row.seq && !['failed', 'undone'].includes(other.status))) fail('checkpoint_repair_unavailable');
      if (row.repairReceipt) return { result: structuredClone(row.repairReceipt) };
      const files = row.files.toReversed().map(file => {
        if (resolvePath(file.path) !== file.canonicalPath) fail('checkpoint_path_changed');
        const current = captureCheckpointFile(file.canonicalPath);
        if (![file.before, file.after, ...(file.intermediateStates ?? []), ...repairStatesFor(row, file.path)]
          .some(state => checkpointStatesEqual(current, state))) fail('checkpoint_external_modified');
        return { ...file, current };
      });
      const restore = row.status === 'completed' && row.rewindOf?.length ? row.rewindOf : [];
      // Persist the chain restoration responsibility BEFORE any inverse write.
      // A second crash must retain it even though status is now compensating.
      const repairRewindOf = row.repairRewindOf ?? restore;
      const repairStates = Object.fromEntries(files.map(file => [file.path, uniqueStates([...repairStatesFor(row, file.path),
        ...(file.current.kind !== 'absent' && file.current.kind !== file.before.kind ? [{ kind: 'absent' }] : []),
        ...(file.before.kind === 'file' ? [{ ...stateIdentity(file.before), mode: file.current.kind === 'file'
          ? file.current.mode : 0o666 & ~process.umask() }] : []),
        ...(file.before.kind === 'directory' ? [{ kind: 'directory', mode: file.before.mode & ~process.umask() }] : [])])]));
      save({ ...row, status: 'compensating', repairRewindOf, repairStates });
      return { files, complete() {
        for (const file of files) if (resolvePath(file.path) !== file.canonicalPath
          || !checkpointStatesEqual(captureCheckpointFile(file.canonicalPath), file.before)) fail('checkpoint_compensation_conflict');
        save({ ...row, status: 'failed', compensated: true, repairRewindOf: [] }, repairRewindOf, true);
      } };
  }
  function controlRecord(control) {
    const matches = rows().filter(row => row.controlBinding?.commandId === control.commandId);
    if (matches.length > 1) fail('checkpoint_control_duplicate');
    const row = matches[0];
    if (row && canonical(row.controlBinding) !== canonical(control)) fail('command_replay_conflict');
    return row;
  }
  return { begin, preview,
    controlRows: rows,
    pendingControlRows: () => database(false, db => db ? db.prepare("SELECT * FROM checkpoints WHERE json_extract(body,'$.controlBinding') IS NOT NULL AND json_extract(body,'$.status') != 'failed' ORDER BY seq").all().map(decode) : []),
    controlRecord,
    beginControl(control, plan) {
      if (control?.contract !== CONVERSATION_WORKSPACE_CONTROL || control.sessionId !== sessionId
        || !control.commandId || !control.requestDigest || !control.sourceDigest || !control.scope) fail('checkpoint_control_invalid');
      if (controlRecord(control) || rows().some(unsettled)) fail('checkpoint_outcome_unknown');
      const record = { policy: WORKSPACE_CHECKPOINT_POLICY, rootDigest, sessionId, id: randomUUID(), createdAt: new Date().toISOString(),
        status: 'prepared', controlBinding: structuredClone(control), files: [], rewindOf: [...plan.ids],
        plannedPaths: plan.files.filter(file => !checkpointStatesEqual(file.current, file.desired)).map(file => file.path) };
      return beginRecord(record, plan.ids);
    },
    completeControl(control) {
      const row = controlRecord(control);
      if (!row || row.status !== 'completed' || row.files.length !== row.plannedPaths.length
        || row.files.some(file => !row.plannedPaths.includes(file.path))) fail('checkpoint_control_incomplete');
      // finish() durably verified all publications. Observe that historical
      // result on retry; later user edits must neither be overwritten nor turn
      // a completed control into an unresolvable pending operation.
      const receipt = { contract: CONVERSATION_WORKSPACE_CONTROL, requestDigest: control.requestDigest,
        checkpointId: row.id, rewoundCheckpointIds: row.rewindOf, changedPaths: row.files.map(file => file.path),
        previewToken: control.workspacePreviewToken };
      if (row.receipt && canonical(row.receipt) !== canonical(receipt)) fail('checkpoint_receipt_conflict');
      save({ ...row, receipt }); return structuredClone(receipt);
    },
    prepareControlRepair(control) { return prepareRepairRow(controlRecord(control)); },
    prepareRepair(request) {
      const row = originalRecord(request, true);
      return prepareRepairRow(row);
    },
    recordRepairReceipt(request, result) {
      const row = originalRecord(request, true);
      if (!row || row.status !== 'failed' || row.compensated !== true) fail('checkpoint_repair_unavailable');
      if (row.repairReceipt && canonical(row.repairReceipt) !== canonical(result)) fail('checkpoint_receipt_conflict');
      save({ ...row, repairReceipt: structuredClone(result) });
    },
    recordReceipt(request, result) {
      if (!['ok', 'error'].includes(result.status)) return;
      const row = receiptRecord(request); if (!row) return;
      // The Host calls this only after its complete permission/post-policy and
      // model/display projection pipeline. A raw filesystem success is not a
      // product receipt and cannot bypass that pipeline on cold recovery.
      if (row.receipt && canonical(row.receipt) !== canonical(result)) fail('checkpoint_receipt_conflict');
      save({ ...row, receipt: structuredClone(result) });
    },
    readReceipt(request) { return structuredClone(receiptRecord(request, true)?.receipt ?? null); },
    list: () => rows().toReversed().slice(0, 50).map(row => ({ checkpoint_id: row.id, created_at: row.createdAt,
    status: row.status, run_id: row.binding?.runId ?? row.controlBinding?.expectedHeadRunId ?? null,
    tool: row.binding?.toolName ?? 'conversation_workspace_rewind', paths: row.files.map(file => file.path) })) };
}

/** Actual committed success, not a journal, UI inventory or model claim. */
export function committedWorkspaceCheckpoint(row, { store, scope, sessionId }) {
  if (row.controlBinding) {
    const control = row.controlBinding;
    if (control.contract !== CONVERSATION_WORKSPACE_CONTROL || control.sessionId !== sessionId
      || canonical(control.scope) !== canonical(scope) || row.sessionId !== sessionId
      || row.receipt?.contract !== control.contract || row.receipt.requestDigest !== control.requestDigest
      || row.receipt.checkpointId !== row.id || row.receipt.previewToken !== control.workspacePreviewToken
      || canonical(row.receipt.rewoundCheckpointIds) !== canonical(row.rewindOf)
      || canonical(row.receipt.changedPaths) !== canonical(row.files.map(file => file.path))) return false;
    try { const record = store.load(scope, control.expectedHeadRunId);
      return record.snapshot.sessionId === sessionId && sha256(canonical(record)) === control.sourceDigest;
    } catch { return false; }
  }
  if (!row.binding.scope || !scope || row.sessionId !== sessionId || canonical(row.binding.scope) !== canonical(scope)) return false;
  let record;
  try { record = store.load(scope, row.binding.runId); } catch { return false; }
  if (!record || record.snapshot.sessionId !== sessionId || record.snapshot.buildId !== row.binding.buildId) return false;
  const intent = record.intents.find(item => item.operationKey === row.binding.operationKey && item.kind === 'tool');
  const index = intent?.payload.calls?.findIndex(call => call.callId === row.binding.callId && call.name === row.binding.toolName) ?? -1;
  if (index < 0 || intent.claimedFence !== row.binding.executionFence
    || record.snapshot.turnId !== row.binding.turnId
    || !record.configuration.tools.some(tool => tool.name === row.binding.toolName && tool.workspaceCheckpointPolicy === WORKSPACE_CHECKPOINT_POLICY)) return false;
  const successful = result => result?.status === 'ok' && result.content?.checkpoint_id === row.id;
  if (record.receipts.some(receipt => receipt.operationKey === row.binding.operationKey && receipt.status === 'committed'
    && successful(receipt.result.results?.[index]))) return true;
  if (index !== 0 || intent.payload.calls.length !== 1
    || !record.configuration.tools.some(tool => tool.name === row.binding.toolName && tool.recoveryPolicy === 'receipt-observation/v1')) return false;
  return record.receipts.some(receipt => {
    const query = record.intents.find(item => item.operationKey === receipt.operationKey && item.kind === 'tool_receipt');
    return receipt.status === 'committed' && query?.payload.originalOperationKey === row.binding.operationKey
      && query.payload.originalClaimedFence === row.binding.executionFence && query.payload.callId === row.binding.callId
      && receipt.result.contract === 'agentkit.tool-receipt-observation/v1'
      && receipt.result.originalOperationKey === row.binding.operationKey && receipt.result.callId === row.binding.callId
      && successful(receipt.result.result);
  });
}
