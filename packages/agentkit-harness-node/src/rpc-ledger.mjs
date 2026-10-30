// Durable JSON-RPC requestId idempotency ledger for the Native RPC entry.
//
// The RPC protocol promises that a requestId is idempotent across process
// restarts: a retried requestId must NOT re-run its task (an unknown side
// effect may already have happened), and a requestId reused with different
// parameters is a conflict that is rejected. That guarantee cannot live in
// memory alone — a crash loses it — so it is persisted in a dedicated SQLite
// file separate from the run store (the run store schema is owned by
// SqliteRunStore and must not be poked from here).
//
// Each row maps requestId -> { method, paramsDigest, runKey?, response?, status }.
// status is 'pending' while the method is in flight and 'completed' once its
// response has been stored. A crash between recordPending and complete leaves a
// 'pending' row; a retry after restart sees it and returns in-progress state
// WITHOUT re-executing the method. Conflicting parameters for the same
// requestId raise 'request_id_conflict'.
//
// This module depends only on node:sqlite and node:fs — never on the core
// package — so it can be unit-tested in isolation. The params digest is the
// SHA-256 of stable-key JSON { method, params }; it only needs to detect a
// different payload for the same requestId, not match the kernel's canonical
// form.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

export function digestRequest(method, params) {
  return createHash('sha256').update(stable({ method, params: params ?? null })).digest('hex');
}

/** Durable requestId ledger. One process owns one instance. */
export class RpcRequestLedger {
  constructor(filename, { now = Date.now } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this._db = new DatabaseSync(filename);
    this._now = now;
    let closed = false;
    this._open = () => { if (closed) throw new Error('ledger_closed'); };
    try {
      this._db.exec(`
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS rpc_requests (
          request_id TEXT PRIMARY KEY,
          method TEXT NOT NULL,
          params_digest TEXT NOT NULL,
          run_key TEXT,
          response TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rpc_requests_run_key ON rpc_requests(run_key);
      `);
    } catch (error) {
      this._db.close();
      throw error;
    }
    this._stmt = {
      insert: this._db.prepare('INSERT INTO rpc_requests VALUES (?,?,?,?,?,?,?,?)'),
      select: this._db.prepare('SELECT * FROM rpc_requests WHERE request_id=?'),
      selectByRunKey: this._db.prepare('SELECT * FROM rpc_requests WHERE run_key=? LIMIT 1'),
      complete: this._db.prepare('UPDATE rpc_requests SET response=?, run_key=COALESCE(?,run_key), status=?, updated_at=? WHERE request_id=?'),
    };
    this.close = () => { if (!closed) { this._db.close(); closed = true; } };
  }

  /**
   * Record a pending requestId, or return the existing entry.
   * Returns { state: 'new' | 'pending' | 'completed', runKey?, response? }.
   * Throws on a params/method conflict (same requestId, different digest).
   */
  recordPending(requestId, method, paramsDigest, runKey = null) {
    if (!requestId || typeof requestId !== 'string')
      throw new Error('invalid_request_id');
    this._open();
    this._db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this._stmt.select.get(requestId);
      if (existing) {
        if (existing.method !== method || existing.params_digest !== paramsDigest) {
          this._db.exec('ROLLBACK');
          const conflict = new Error('request_id_conflict');
          conflict.code = 'request_id_conflict';
          conflict.requestId = requestId;
          conflict.existingMethod = existing.method;
          throw conflict;
        }
        this._db.exec('COMMIT');
        return {
          state: existing.status,
          runKey: existing.run_key,
          response: existing.response ? JSON.parse(existing.response) : null,
        };
      }
      const now = this._now();
      this._stmt.insert.run(requestId, method, paramsDigest, runKey, null, 'pending', now, now);
      this._db.exec('COMMIT');
      return { state: 'new' };
    } catch (error) {
      try { this._db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  /** Mark a requestId completed with its response. Optionally fix the runKey. */
  complete(requestId, response, runKey = null) {
    this._open();
    const now = this._now();
    const changes = this._stmt.complete.run(JSON.stringify(response ?? null), runKey, 'completed', now, requestId);
    if (changes.changes === 0) throw new Error('request_id_unknown');
  }

  lookup(requestId) {
    this._open();
    const row = this._stmt.select.get(requestId);
    if (!row) return null;
    return { method: row.method, paramsDigest: row.params_digest, runKey: row.run_key,
      response: row.response ? JSON.parse(row.response) : null, status: row.status };
  }

  /** Reverse lookup by runKey, used by the driver to find the requestId to complete. */
  lookupByRunKey(runKey) {
    this._open();
    const row = this._stmt.selectByRunKey.get(runKey);
    if (!row) return null;
    return { requestId: row.request_id, method: row.method, paramsDigest: row.params_digest,
      runKey: row.run_key, response: row.response ? JSON.parse(row.response) : null, status: row.status };
  }
}
