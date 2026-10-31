/**
 * Persistent watch registry for Native background completion notifications.
 *
 * Stores the minimum identity for a background command watch — never the full
 * StoredRun, messages, configuration, or receipts. The Host dispatcher
 * (createStudioNativeBackgroundDispatcher) reloads the source from the Native
 * RunStore at dispatch time; the registry only persists which watches exist and
 * their outcome state.
 *
 * A watch's key is sha256(canonical({scope, sourceRunId, taskId})). The
 * identity fields (scope, sessionId, sourceRunId, taskId, sourceConfigDigest,
 * buildId, taskChainId, hostBindingDigest, operationKey) are immutable after
 * registration and verified against the real Native record's committed launch
 * intent/receipt. Status: watching → pending_admission → admitted → discarded.
 * Only discarded is terminal; admitted stays pending for re-drive. noticeRunId
 * is monotonic (set once, never replaced).
 *
 * Cross-process owner lock via tryLock (SQLite lock file); second construction
 * is explicitly busy. Private directory, no symlinks, 0600, WAL. Corrupt or
 * unsupported schema fails hard — never resets to empty.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants, closeSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { canonical, copy, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { privateDirectory, openPrivate, tryLock } from '@kingsoftcloud/agentkit-harness-node/native/local-command-state';

const SCHEMA_VERSION = 1;
const TABLE = 'native_background_watches';
const HEX64 = /^[a-f0-9]{64}$/;

const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

const VALID_OUTCOME_STATUS = new Set(['watching', 'pending_admission', 'admitted', 'discarded']);
const REASON_WHITELIST = new Set([
  'already_notified', 'source_canceled', 'budget_exhausted', 'task_not_found',
  'binding_invalid', 'sdk_busy', 'sdk_unavailable', 'dispatch_exception',
  'dispatch_invalid_result', 'dispatch_unknown_status',
  'notice_terminal', 'command_not_terminal',
]);
function boundReason(reason) {
  if (typeof reason === 'string' && reason.length <= 64 && REASON_WHITELIST.has(reason)) return reason;
  return 'unknown';
}

/** Extract and validate the minimum watch identity from a real Native
 *  StoredRun record + BackgroundCommandRef. Verifies the source completed, has
 *  the background notification policy, the ref matches an unnotified command,
 *  and the launch intent/receipt are committed — reuses the same proof logic as
 *  background-notification.mts sourceRecord. Returns a flat, detached object. */
function extractWatch(record, ref) {
  invariant(record && typeof record === 'object' && !Array.isArray(record), 'watch_record_invalid');
  invariant(record.snapshot && typeof record.snapshot === 'object', 'watch_record_snapshot_missing');
  invariant(record.configuration && typeof record.configuration === 'object', 'watch_record_config_missing');
  const snap = record.snapshot, cfg = record.configuration;
  // Validate scope.
  invariant(snap.scope && typeof snap.scope === 'object', 'watch_scope_invalid');
  for (const k of ['tenantId', 'workspaceId', 'userId', 'agentId']) {
    invariant(typeof snap.scope[k] === 'string' && snap.scope[k].trim(), `watch_scope_${k}_invalid`);
  }
  invariant(typeof snap.sessionId === 'string' && snap.sessionId.trim(), 'watch_session_id_invalid');
  invariant(typeof snap.runId === 'string' && snap.runId.trim(), 'watch_run_id_invalid');
  invariant(typeof snap.configDigest === 'string' && snap.configDigest.trim(), 'watch_config_digest_invalid');
  invariant(typeof snap.buildId === 'string' || snap.buildId === null, 'watch_build_id_invalid');
  invariant(typeof snap.taskChainId === 'string' && snap.taskChainId.trim(), 'watch_task_chain_id_invalid');
  invariant(typeof cfg.hostBindingDigest === 'string' && cfg.hostBindingDigest.trim(), 'watch_binding_digest_invalid');
  // Validate ref.
  invariant(ref && typeof ref === 'object', 'watch_ref_invalid');
  invariant(typeof ref.taskId === 'string' && HEX64.test(ref.taskId), 'watch_ref_task_id_invalid');
  invariant(typeof ref.sourceRunId === 'string' && ref.sourceRunId === snap.runId, 'watch_ref_source_mismatch');
  invariant(typeof ref.operationKey === 'string' && ref.operationKey.trim(), 'watch_ref_opkey_invalid');
  // Verify the source completed with the background notification policy.
  invariant(snap.phase === 'completed', 'watch_source_not_completed');
  invariant(cfg.backgroundNotificationPolicy === 'completed-before-model/v1', 'watch_source_no_notification_policy');
  // Verify the ref matches an unnotified background command in the snapshot.
  const commands = snap.backgroundCommands ?? [];
  const cmd = commands.find(c => c.ref?.taskId === ref.taskId && c.ref?.sourceRunId === ref.sourceRunId);
  invariant(cmd, 'watch_command_not_found');
  invariant(!cmd.notified, 'watch_command_already_notified');
  invariant(canonical(cmd.ref) === canonical(ref), 'watch_ref_mismatch');
  // Verify the launch intent/receipt are committed (same proof as sourceRecord).
  invariant(Array.isArray(record.intents) && Array.isArray(record.receipts), 'watch_intents_missing');
  const intent = record.intents.find(r => r.operationKey === ref.operationKey);
  const receipt = record.receipts.find(r => r.operationKey === ref.operationKey);
  invariant(intent?.kind === 'tool' && receipt?.status === 'committed', 'watch_launch_unconfirmed');
  invariant(Array.isArray(intent.payload?.calls) && intent.payload.calls.length === 1, 'watch_launch_unconfirmed');
  invariant(Array.isArray(receipt.result?.results) && receipt.result.results.length === 1, 'watch_launch_unconfirmed');
  const call = intent.payload.calls[0], result = receipt.result.results[0];
  invariant(result?.status === 'ok' && canonical(result.backgroundCommandRef ?? null) === canonical(ref), 'watch_launch_unconfirmed');
  invariant(cfg.tools.some(tool => tool.name === call.name && tool.backgroundCommandPolicy === 'owned-command-launch/v1'), 'watch_launch_unconfirmed');
  // Verify config digest matches.
  invariant(sha256(canonical(cfg)) === snap.configDigest, 'watch_config_digest_mismatch');
  // Return the flat, detached minimum identity — no snapshot, messages, or receipts.
  return {
    scope: copy(snap.scope), sessionId: snap.sessionId, sourceRunId: snap.runId,
    taskId: ref.taskId, sourceConfigDigest: snap.configDigest,
    buildId: snap.buildId, taskChainId: snap.taskChainId,
    hostBindingDigest: cfg.hostBindingDigest, operationKey: ref.operationKey,
  };
}

function identityOf(watch) {
  return canonical(watch);
}

/**
 * @param {string} filename Path to the SQLite database file.
 * @returns {{register(record,ref), list({pendingOnly}?), recordOutcome(key,{status,reason,noticeRunId}), close()}}
 */
export function createNativeBackgroundWatchStore(filename) {
  invariant(typeof filename === 'string' && filename.trim(), 'watch_store_filename_invalid');
  const rawPath = resolve(filename);
  const dir = dirname(rawPath);
  // Create and validate the private directory using existing helpers (no
  // realpath bypass — privateDirectory checks for symlinks itself).
  privateDirectory(dir, true);
  const dbPath = join(dir, basename(rawPath));

  // Cross-process owner lock via tryLock. Held until close.
  const lockPath = join(dir, 'native_background_watch.lock');
  const releaseLock = tryLock(lockPath);
  if (!releaseLock) {
    throw Object.assign(new Error('watch_store_owner_busy'), { code: 'watch_store_owner_busy' });
  }

  // All database initialization is inside a try/finally so a failure after
  // the lock is acquired releases the lock — no leak.
  let db = null;
  try {
    // Open/create the data file through private-file checks.
    const fd = openPrivate(dbPath, constants.O_RDWR | constants.O_CREAT);
    closeSync(fd);
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        key TEXT PRIMARY KEY NOT NULL,
        identity TEXT NOT NULL,
        watch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'watching',
        reason TEXT,
        notice_run_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_watches_status ON ${TABLE}(status);
    `);
    // Strict schema verification: read ALL rows, verify each row's integrity
    // against the exact schema — not mere truthiness. A single corrupt row
    // fails hard — never reset to empty.
    const SCOPE_KEYS = ['tenantId', 'workspaceId', 'userId', 'agentId'];
    const allRows = db.prepare(`SELECT key, identity, watch, status, reason, notice_run_id, schema_version FROM ${TABLE}`).all();
    for (const row of allRows) {
      // Key: must be hex64.
      invariant(typeof row.key === 'string' && HEX64.test(row.key), 'watch_store_corrupt_key');
      // Identity: non-empty string.
      invariant(typeof row.identity === 'string' && row.identity.length > 0, 'watch_store_corrupt_identity');
      // Status: must be a valid outcome status.
      invariant(typeof row.status === 'string' && VALID_OUTCOME_STATUS.has(row.status), 'watch_store_corrupt_status');
      // Schema version: must match.
      invariant(row.schema_version === SCHEMA_VERSION, 'watch_store_schema_unsupported');
      // Reason: null or a bounded string.
      invariant(row.reason === null || (typeof row.reason === 'string' && row.reason.length <= 64), 'watch_store_corrupt_reason');
      // notice_run_id: null or a non-empty string.
      invariant(row.notice_run_id === null || (typeof row.notice_run_id === 'string' && row.notice_run_id.trim()), 'watch_store_corrupt_notice');
      // Watch JSON: must have the exact minimum identity shape.
      const w = JSON.parse(row.watch);
      invariant(w && typeof w === 'object' && !Array.isArray(w), 'watch_store_corrupt_watch');
      invariant(canonical(Object.keys(w).sort()) === canonical(['scope', 'sessionId', 'sourceRunId', 'taskId',
        'sourceConfigDigest', 'buildId', 'taskChainId', 'hostBindingDigest', 'operationKey'].sort()), 'watch_store_corrupt_watch_shape');
      // Scope: exactly 4 string keys.
      invariant(w.scope && typeof w.scope === 'object' && !Array.isArray(w.scope), 'watch_store_corrupt_scope');
      invariant(Object.keys(w.scope).length === 4, 'watch_store_corrupt_scope_keys');
      for (const k of SCOPE_KEYS) invariant(typeof w.scope[k] === 'string' && w.scope[k].trim(), `watch_store_corrupt_scope_${k}`);
      // sessionId, sourceRunId, operationKey: non-empty strings.
      invariant(typeof w.sessionId === 'string' && w.sessionId.trim(), 'watch_store_corrupt_session');
      invariant(typeof w.sourceRunId === 'string' && w.sourceRunId.trim(), 'watch_store_corrupt_source');
      invariant(typeof w.operationKey === 'string' && w.operationKey.trim(), 'watch_store_corrupt_opkey');
      // taskId: hex64.
      invariant(typeof w.taskId === 'string' && HEX64.test(w.taskId), 'watch_store_corrupt_taskid');
      // sourceConfigDigest, taskChainId, hostBindingDigest: non-empty strings.
      invariant(typeof w.sourceConfigDigest === 'string' && w.sourceConfigDigest.trim(), 'watch_store_corrupt_configdigest');
      invariant(typeof w.taskChainId === 'string' && w.taskChainId.trim(), 'watch_store_corrupt_taskchain');
      invariant(typeof w.hostBindingDigest === 'string' && w.hostBindingDigest.trim(), 'watch_store_corrupt_binding');
      // buildId: string or null.
      invariant(typeof w.buildId === 'string' || w.buildId === null, 'watch_store_corrupt_buildid');
      // Identity: canonical(watch) must equal the stored identity.
      invariant(canonical(w) === row.identity, 'watch_store_corrupt_identity_mismatch');
      // Key: re-computed sha256(canonical({scope, sourceRunId, taskId})) must match.
      invariant(sha256(canonical({ scope: w.scope, sourceRunId: w.sourceRunId, taskId: w.taskId })) === row.key, 'watch_store_corrupt_key_mismatch');
    }
  } catch (error) {
    try { db?.close(); } catch {}
    releaseLock();
    if (error.code?.startsWith('watch_store_')) throw error;
    if (error.code === 'watch_store_schema_unsupported') throw error;
    throw Object.assign(new Error('watch_store_corrupt'), { code: 'watch_store_corrupt', cause: error });
  }

  let closed = false;
  const now = () => Date.now();
  const checkClosed = () => { if (closed) throw Object.assign(new Error('watch_store_closed'), { code: 'watch_store_closed' }); };

  function register(record, ref) {
    checkClosed();
    const watch = extractWatch(record, ref);
    const key = sha256(canonical({ scope: watch.scope, sourceRunId: watch.sourceRunId, taskId: watch.taskId }));
    const identity = identityOf(watch);
    const watchJson = canonical(copy(watch));
    const ts = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(`SELECT identity, status FROM ${TABLE} WHERE key = ?`).get(key);
      if (existing) {
        if (existing.identity !== identity) {
          db.exec('ROLLBACK');
          throw Object.assign(new Error('watch_identity_conflict'), { code: 'watch_identity_conflict' });
        }
        db.exec('COMMIT');
        return { key, status: existing.status };
      }
      db.prepare(`INSERT INTO ${TABLE} (key, identity, watch, status, reason, notice_run_id, created_at, updated_at, schema_version)
        VALUES (?, ?, ?, 'watching', NULL, NULL, ?, ?, ?)`).run(key, identity, watchJson, ts, ts, SCHEMA_VERSION);
      db.exec('COMMIT');
      return { key, status: 'watching' };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function list({ pendingOnly = false } = {}) {
    checkClosed();
    const rows = pendingOnly
      ? db.prepare(`SELECT key, watch, status, reason, notice_run_id FROM ${TABLE} WHERE status != 'discarded' ORDER BY created_at`).all()
      : db.prepare(`SELECT key, watch, status, reason, notice_run_id FROM ${TABLE} ORDER BY created_at`).all();
    return rows.map(row => {
      const w = JSON.parse(row.watch);
      return { key: row.key, ...w, status: row.status, reason: row.reason, noticeRunId: row.notice_run_id };
    });
  }

  function recordOutcome(key, { status, reason, noticeRunId } = {}) {
    checkClosed();
    invariant(typeof key === 'string' && HEX64.test(key), 'watch_key_invalid');
    invariant(VALID_OUTCOME_STATUS.has(status), 'watch_status_invalid');
    if (noticeRunId !== undefined && noticeRunId !== null) {
      invariant(typeof noticeRunId === 'string' && noticeRunId.trim(), 'watch_notice_run_id_invalid');
    }
    const ts = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(`SELECT status, notice_run_id FROM ${TABLE} WHERE key = ?`).get(key);
      if (!existing) { db.exec('ROLLBACK'); throw Object.assign(new Error('watch_not_found'), { code: 'watch_not_found' }); }
      if (existing.notice_run_id && noticeRunId && existing.notice_run_id !== noticeRunId) {
        db.exec('ROLLBACK');
        throw Object.assign(new Error('watch_notice_run_id_immutable'), { code: 'watch_notice_run_id_immutable' });
      }
      if (existing.status === 'discarded' && status !== 'discarded') {
        db.exec('COMMIT');
        return { key, status: 'discarded' };
      }
      const boundR = reason ? boundReason(reason) : null;
      db.prepare(`UPDATE ${TABLE} SET status = ?, reason = ?, notice_run_id = COALESCE(?, notice_run_id), updated_at = ? WHERE key = ?`)
        .run(status, boundR, noticeRunId ?? null, ts, key);
      db.exec('COMMIT');
      return { key, status };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    try { db.close(); } catch {}
    try { releaseLock(); } catch {}
  }

  return { register, list, recordOutcome, close };
}
