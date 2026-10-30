/**
 * Durable SQLite Host job/cursor store for Native memory-extraction dispatch.
 *
 * A storage primitive only — no executor, scheduler, or agent loop. The Host
 * dispatcher owns execution; this store persists the immutable prepared Native
 * auxiliary-run identity/config/source and the per-stream extraction cursor.
 *
 * The principal is the exact canonical {scope, sessionId} pair; a job's stream
 * key is sha256(canonical({scope, sessionId})). Multi-process mutation safety
 * uses BEGIN IMMEDIATE on every write with a busy_timeout wait — there is no
 * single-owner lock, so multiple Host processes can share the file.
 *
 * Immutable prepared identity/config/source are persisted exactly once at
 * enqueue and never regenerated from a later Memory manifest. A divergent
 * duplicate under the same jobId is rejected (native_memory_job_conflict); an
 * identical duplicate returns the existing record. A new queued job supersedes
 * older queued jobs in its stream (mark superseded) but never an active
 * running job.
 *
 * Cursor authority: enqueue rejects when the stream cursor != expectedCursor
 * (native_memory_job_cursor_conflict). On a success/no-op finish the current
 * cursor must equal the job's expectedCursor and is transactionally advanced
 * to boundaryId; error/aborted never advance. claim/renew/finish require the
 * exact live lease (owner+fence, unexpired) else native_memory_job_lease_lost;
 * a stale expectedCursor on claim marks the job superseded.
 *
 * No credentials are stored.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { canonical, invariant, scopeKey } from '@kingsoftcloud/agentkit-harness-core';

const SCHEMA_VERSION = 1;
const JOBS = 'native_memory_extraction_jobs';
const CURSORS = 'native_memory_extraction_cursors';
const NATIVE_AUXILIARY_RUN = 'agentkit.native-auxiliary-run/v1';

const VALID_STATUS = new Set(['queued', 'running', 'success', 'no-op', 'error', 'aborted', 'superseded']);
const FINISHABLE = new Set(['success', 'no-op', 'error', 'aborted']);
const TERMINAL = new Set(['success', 'no-op', 'error', 'aborted', 'superseded']);

const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const streamKeyOf = (scope, sessionId) => sha256(canonical({ scope, sessionId }));

function assertBoundedString(value, max, code) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= max, code);
}
function assertPositiveInt(value, code) {
  invariant(Number.isSafeInteger(value) && value > 0, code);
}
function assertNow(value, code) {
  invariant(Number.isSafeInteger(value) && value >= 0, code);
}
function assertPlainObject(value, code) {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), code);
}

function parseLease(stored) {
  if (stored === null || stored === undefined) return null;
  const lease = JSON.parse(stored);
  return { owner: lease.owner, fence: lease.fence, expiresAt: lease.expiresAt };
}

export class StudioNativeMemoryExtractionStore {
  constructor(filename) {
    invariant(typeof filename === 'string' && filename.trim(), 'native_memory_store_filename_invalid');
    const dbPath = resolve(filename);
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this._db = new DatabaseSync(dbPath);
    this._db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS ${JOBS} (
        job_id TEXT PRIMARY KEY NOT NULL,
        stream_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        expected_cursor TEXT,
        boundary_id TEXT NOT NULL,
        source_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        source TEXT NOT NULL,
        prepared TEXT NOT NULL,
        manifest TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        lease TEXT,
        fence INTEGER NOT NULL DEFAULT 0,
        usage TEXT,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_stream ON ${JOBS}(stream_key);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON ${JOBS}(status);
      CREATE TABLE IF NOT EXISTS ${CURSORS} (
        stream_key TEXT PRIMARY KEY NOT NULL,
        cursor TEXT,
        updated_at INTEGER NOT NULL,
        schema_version INTEGER NOT NULL
      );
    `);
    this._verify();
    this._closed = false;
  }

  _verify() {
    const db = this._db;
    const jobs = db.prepare(`SELECT * FROM ${JOBS}`).all();
    for (const row of jobs) {
      invariant(row.schema_version === SCHEMA_VERSION, 'native_memory_store_schema_unsupported');
      invariant(VALID_STATUS.has(row.status), 'native_memory_store_corrupt_status');
      assertBoundedString(row.job_id, 256, 'native_memory_store_corrupt_job_id');
      assertBoundedString(row.stream_key, 128, 'native_memory_store_corrupt_stream_key');
      assertBoundedString(row.scope, 4096, 'native_memory_store_corrupt_scope');
      assertBoundedString(row.session_id, 256, 'native_memory_store_corrupt_session');
      invariant(row.expected_cursor === null || (typeof row.expected_cursor === 'string' && row.expected_cursor.length > 0), 'native_memory_store_corrupt_expected_cursor');
      assertBoundedString(row.boundary_id, 256, 'native_memory_store_corrupt_boundary_id');
      assertBoundedString(row.source_digest, 256, 'native_memory_store_corrupt_source_digest');
      assertBoundedString(row.policy_digest, 256, 'native_memory_store_corrupt_policy_digest');
      invariant(typeof row.source === 'string' && row.source.length > 0, 'native_memory_store_corrupt_source');
      invariant(typeof row.prepared === 'string' && row.prepared.length > 0, 'native_memory_store_corrupt_prepared');
      invariant(typeof row.manifest === 'string' && row.manifest.length > 0, 'native_memory_store_corrupt_manifest');
      assertBoundedString(row.payload_digest, 128, 'native_memory_store_corrupt_payload_digest');
      invariant(Number.isSafeInteger(row.fence) && row.fence >= 0, 'native_memory_store_corrupt_fence');
      invariant(row.lease === null || (typeof row.lease === 'string' && row.lease.length > 0), 'native_memory_store_corrupt_lease');
      invariant(row.usage === null || (typeof row.usage === 'string' && row.usage.length > 0), 'native_memory_store_corrupt_usage');
      invariant(row.error_code === null || (typeof row.error_code === 'string' && row.error_code.length > 0 && row.error_code.length <= 128), 'native_memory_store_corrupt_error_code');
      invariant(Number.isSafeInteger(row.created_at) && row.created_at >= 0, 'native_memory_store_corrupt_created_at');
      invariant(Number.isSafeInteger(row.updated_at) && row.updated_at >= 0, 'native_memory_store_corrupt_updated_at');
      const scopeObj = JSON.parse(row.scope);
      invariant(row.stream_key === streamKeyOf(scopeObj, row.session_id), 'native_memory_store_corrupt_stream_key_mismatch');
      const recomputed = sha256(canonical({
        scope: scopeObj, sessionId: row.session_id, expectedCursor: row.expected_cursor,
        boundaryId: row.boundary_id, sourceDigest: row.source_digest, policyDigest: row.policy_digest,
        source: JSON.parse(row.source), prepared: JSON.parse(row.prepared), manifest: JSON.parse(row.manifest),
      }));
      invariant(row.payload_digest === recomputed, 'native_memory_store_corrupt_payload_digest_mismatch');
      if (row.lease !== null) {
        const lease = JSON.parse(row.lease);
        invariant(typeof lease.owner === 'string' && lease.owner.length > 0 && Number.isSafeInteger(lease.fence) && lease.fence > 0 && Number.isSafeInteger(lease.expiresAt), 'native_memory_store_corrupt_lease_shape');
      }
    }
    const cursors = db.prepare(`SELECT * FROM ${CURSORS}`).all();
    for (const row of cursors) {
      invariant(row.schema_version === SCHEMA_VERSION, 'native_memory_store_schema_unsupported');
      assertBoundedString(row.stream_key, 128, 'native_memory_store_corrupt_cursor_stream_key');
      invariant(row.cursor === null || (typeof row.cursor === 'string' && row.cursor.length > 0), 'native_memory_store_corrupt_cursor');
      invariant(Number.isSafeInteger(row.updated_at) && row.updated_at >= 0, 'native_memory_store_corrupt_cursor_updated_at');
    }
  }

  _checkClosed() {
    invariant(!this._closed, 'native_memory_store_closed');
  }

  _record(row) {
    return {
      jobId: row.job_id,
      scope: JSON.parse(row.scope),
      sessionId: row.session_id,
      expectedCursor: row.expected_cursor,
      boundaryId: row.boundary_id,
      sourceDigest: row.source_digest,
      policyDigest: row.policy_digest,
      source: JSON.parse(row.source),
      prepared: JSON.parse(row.prepared),
      manifest: JSON.parse(row.manifest),
      status: row.status,
      lease: parseLease(row.lease),
      fence: row.fence,
      usage: row.usage === null ? null : JSON.parse(row.usage),
      errorCode: row.error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  enqueue(input) {
    this._checkClosed();
    assertPlainObject(input, 'native_memory_input_invalid');
    const { jobId, scope, sessionId, expectedCursor, boundaryId, sourceDigest, policyDigest, source, prepared, manifest } = input;
    assertBoundedString(jobId, 256, 'native_memory_job_id_invalid');
    assertPlainObject(scope, 'native_memory_scope_invalid');
    scopeKey(scope);
    assertBoundedString(sessionId, 256, 'native_memory_session_id_invalid');
    invariant(expectedCursor === null || (typeof expectedCursor === 'string' && expectedCursor.length > 0), 'native_memory_expected_cursor_invalid');
    assertBoundedString(boundaryId, 256, 'native_memory_boundary_id_invalid');
    assertBoundedString(sourceDigest, 256, 'native_memory_source_digest_invalid');
    assertBoundedString(policyDigest, 256, 'native_memory_policy_digest_invalid');
    assertPlainObject(source, 'native_memory_source_invalid');
    assertPlainObject(prepared, 'native_memory_prepared_invalid');
    assertPlainObject(manifest, 'native_memory_manifest_invalid');
    invariant(prepared.contract === NATIVE_AUXILIARY_RUN, 'native_memory_prepared_contract_invalid');
    assertPlainObject(prepared.identity, 'native_memory_identity_invalid');
    invariant(prepared.identity.runId === jobId, 'native_memory_identity_run_id_mismatch');
    invariant(canonical(prepared.identity.scope) === canonical(scope), 'native_memory_identity_scope_mismatch');
    assertBoundedString(prepared.identity.sessionId, 256, 'native_memory_identity_session_id_invalid');
    invariant(prepared.identity.sessionId !== sessionId, 'native_memory_identity_session_collision');
    assertPlainObject(source.parent, 'native_memory_source_parent_invalid');
    invariant(source.parent.sessionId === sessionId, 'native_memory_source_parent_session_mismatch');
    invariant(canonical(source.parent.scope) === canonical(scope), 'native_memory_source_parent_scope_mismatch');

    const streamKey = streamKeyOf(scope, sessionId);
    const payloadDigest = sha256(canonical({ scope, sessionId, expectedCursor, boundaryId, sourceDigest, policyDigest, source, prepared, manifest }));
    const scopeCanonical = canonical(scope);
    const ts = Date.now();
    const db = this._db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId);
      if (existing) {
        invariant(existing.payload_digest === payloadDigest, 'native_memory_job_conflict');
        db.exec('COMMIT');
        return this._record(existing);
      }
      const cur = db.prepare(`SELECT cursor FROM ${CURSORS} WHERE stream_key = ?`).get(streamKey);
      const currentCursor = cur ? cur.cursor : null;
      invariant(currentCursor === expectedCursor, 'native_memory_job_cursor_conflict');
      db.prepare(`UPDATE ${JOBS} SET status = 'superseded', lease = NULL, updated_at = ? WHERE stream_key = ? AND status = 'queued'`).run(ts, streamKey);
      db.prepare(`INSERT INTO ${JOBS} (job_id, stream_key, scope, session_id, expected_cursor, boundary_id, source_digest, policy_digest, source, prepared, manifest, payload_digest, status, lease, fence, usage, error_code, created_at, updated_at, schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?, ?, ?)`)
        .run(jobId, streamKey, scopeCanonical, sessionId, expectedCursor, boundaryId, sourceDigest, policyDigest, canonical(source), canonical(prepared), canonical(manifest), payloadDigest, ts, ts, SCHEMA_VERSION);
      db.exec('COMMIT');
      return this._record(db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  get(jobId) {
    this._checkClosed();
    assertBoundedString(jobId, 256, 'native_memory_job_id_invalid');
    const row = this._db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId);
    return row ? this._record(row) : null;
  }

  list({ scope, sessionId, statuses } = {}) {
    this._checkClosed();
    const where = [];
    const params = [];
    if (scope !== undefined && scope !== null) {
      assertPlainObject(scope, 'native_memory_scope_invalid');
      scopeKey(scope);
      where.push('scope = ?');
      params.push(canonical(scope));
    }
    if (sessionId !== undefined && sessionId !== null) {
      assertBoundedString(sessionId, 256, 'native_memory_session_id_invalid');
      where.push('session_id = ?');
      params.push(sessionId);
    }
    if (statuses !== undefined && statuses !== null) {
      invariant(Array.isArray(statuses) && statuses.length > 0, 'native_memory_statuses_invalid');
      for (const status of statuses) invariant(VALID_STATUS.has(status), 'native_memory_status_invalid');
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    let sql = `SELECT * FROM ${JOBS}`;
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at ASC, job_id ASC';
    return this._db.prepare(sql).all(...params).map(row => this._record(row));
  }

  getCursor({ scope, sessionId } = {}) {
    this._checkClosed();
    assertPlainObject(scope, 'native_memory_scope_invalid');
    scopeKey(scope);
    assertBoundedString(sessionId, 256, 'native_memory_session_id_invalid');
    const streamKey = streamKeyOf(scope, sessionId);
    const row = this._db.prepare(`SELECT cursor FROM ${CURSORS} WHERE stream_key = ?`).get(streamKey);
    return row ? row.cursor : null;
  }

  claim(jobId, { owner, now, leaseMs } = {}) {
    this._checkClosed();
    assertBoundedString(jobId, 256, 'native_memory_job_id_invalid');
    assertBoundedString(owner, 256, 'native_memory_owner_invalid');
    assertNow(now, 'native_memory_now_invalid');
    assertPositiveInt(leaseMs, 'native_memory_lease_ms_invalid');
    const db = this._db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId);
      if (!row) { db.exec('COMMIT'); return null; }
      if (TERMINAL.has(row.status)) { db.exec('COMMIT'); return null; }
      let claimable = false;
      if (row.status === 'queued') claimable = true;
      else if (row.status === 'running') {
        const lease = parseLease(row.lease);
        if (lease && lease.expiresAt <= now) claimable = true;
      }
      if (!claimable) { db.exec('COMMIT'); return null; }
      const runners = db.prepare(`SELECT lease FROM ${JOBS} WHERE stream_key = ? AND status = 'running' AND job_id != ?`).all(row.stream_key, jobId);
      let liveOther = false;
      for (const other of runners) {
        const lease = parseLease(other.lease);
        if (lease && lease.expiresAt > now) { liveOther = true; break; }
      }
      if (liveOther) { db.exec('COMMIT'); return null; }
      const cur = db.prepare(`SELECT cursor FROM ${CURSORS} WHERE stream_key = ?`).get(row.stream_key);
      const currentCursor = cur ? cur.cursor : null;
      if (currentCursor !== row.expected_cursor) {
        db.prepare(`UPDATE ${JOBS} SET status = 'superseded', lease = NULL, updated_at = ? WHERE job_id = ?`).run(now, jobId);
        db.exec('COMMIT');
        return null;
      }
      const newFence = row.fence + 1;
      const lease = { owner, fence: newFence, expiresAt: now + leaseMs };
      db.prepare(`UPDATE ${JOBS} SET status = 'running', lease = ?, fence = ?, updated_at = ? WHERE job_id = ?`)
        .run(canonical(lease), newFence, now, jobId);
      db.exec('COMMIT');
      return this._record(db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  renew(jobId, { lease, now, leaseMs } = {}) {
    this._checkClosed();
    assertBoundedString(jobId, 256, 'native_memory_job_id_invalid');
    assertPlainObject(lease, 'native_memory_lease_invalid');
    assertBoundedString(lease.owner, 256, 'native_memory_lease_owner_invalid');
    assertPositiveInt(lease.fence, 'native_memory_lease_fence_invalid');
    assertNow(now, 'native_memory_now_invalid');
    assertPositiveInt(leaseMs, 'native_memory_lease_ms_invalid');
    const db = this._db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId);
      invariant(row, 'native_memory_job_lease_lost');
      const live = parseLease(row.lease);
      invariant(live && row.status === 'running' && live.owner === lease.owner && live.fence === lease.fence && live.expiresAt > now, 'native_memory_job_lease_lost');
      const renewed = { owner: live.owner, fence: live.fence, expiresAt: now + leaseMs };
      db.prepare(`UPDATE ${JOBS} SET lease = ?, updated_at = ? WHERE job_id = ?`).run(canonical(renewed), now, jobId);
      db.exec('COMMIT');
      return this._record(db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  finish(jobId, { lease, now, status, usage = null, errorCode = null } = {}) {
    this._checkClosed();
    assertBoundedString(jobId, 256, 'native_memory_job_id_invalid');
    assertPlainObject(lease, 'native_memory_lease_invalid');
    assertBoundedString(lease.owner, 256, 'native_memory_lease_owner_invalid');
    assertPositiveInt(lease.fence, 'native_memory_lease_fence_invalid');
    assertNow(now, 'native_memory_now_invalid');
    invariant(FINISHABLE.has(status), 'native_memory_finish_status_invalid');
    invariant(usage === null || (typeof usage === 'object' && !Array.isArray(usage)), 'native_memory_usage_invalid');
    invariant(errorCode === null || (typeof errorCode === 'string' && errorCode.length > 0 && errorCode.length <= 128), 'native_memory_error_code_invalid');
    const db = this._db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId);
      invariant(row, 'native_memory_job_lease_lost');
      const live = parseLease(row.lease);
      invariant(live && row.status === 'running' && live.owner === lease.owner && live.fence === lease.fence && live.expiresAt > now, 'native_memory_job_lease_lost');
      if (status === 'success' || status === 'no-op') {
        const cur = db.prepare(`SELECT cursor FROM ${CURSORS} WHERE stream_key = ?`).get(row.stream_key);
        const currentCursor = cur ? cur.cursor : null;
        invariant(currentCursor === row.expected_cursor, 'native_memory_job_cursor_conflict');
        const existing = db.prepare(`SELECT 1 FROM ${CURSORS} WHERE stream_key = ?`).get(row.stream_key);
        if (existing) {
          db.prepare(`UPDATE ${CURSORS} SET cursor = ?, updated_at = ? WHERE stream_key = ?`).run(row.boundary_id, now, row.stream_key);
        } else {
          db.prepare(`INSERT INTO ${CURSORS} (stream_key, cursor, updated_at, schema_version) VALUES (?, ?, ?, ?)`).run(row.stream_key, row.boundary_id, now, SCHEMA_VERSION);
        }
      }
      db.prepare(`UPDATE ${JOBS} SET status = ?, usage = ?, error_code = ?, lease = NULL, updated_at = ? WHERE job_id = ?`)
        .run(status, usage === null ? null : canonical(usage), errorCode, now, jobId);
      db.exec('COMMIT');
      return this._record(db.prepare(`SELECT * FROM ${JOBS} WHERE job_id = ?`).get(jobId));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try { this._db.close(); } catch {}
  }
}
