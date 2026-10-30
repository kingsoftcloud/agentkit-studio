import { appendSessionInjection, canonical, invariant, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

/** Uses the RunStore connection: assigning inbox rows and creating a Run commit together. */
export function createSqliteSessionInbox(db, open) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_session_inbox (
    scope TEXT NOT NULL, session_id TEXT NOT NULL, injection_id TEXT NOT NULL,
    seq INTEGER NOT NULL, data TEXT NOT NULL, consumed_by TEXT,
    PRIMARY KEY(scope,session_id,injection_id), UNIQUE(scope,session_id,seq));
    CREATE INDEX IF NOT EXISTS native_session_inbox_pending ON native_session_inbox(scope,session_id,consumed_by,seq);`);
  const pending = (scope, sessionId) => db.prepare(`SELECT data FROM native_session_inbox
    WHERE scope=? AND session_id=? AND consumed_by IS NULL ORDER BY seq`)
    .all(canonical(scope), sessionId).map(row => parseNativeJson(row.data));
  return {
    pendingSessionInjections: pending,
    enqueueSessionInjection(scope, sessionId, input) {
      open(); db.exec('BEGIN IMMEDIATE');
      try {
        const key = canonical(scope);
        const duplicate = db.prepare('SELECT data,consumed_by FROM native_session_inbox WHERE scope=? AND session_id=? AND injection_id=?')
          .get(key, sessionId, input.injectionId);
        const entries = duplicate ? [{ ...parseNativeJson(duplicate.data), consumedBy: duplicate.consumed_by }] : pending(scope, sessionId);
        const nextSequence = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM native_session_inbox WHERE scope=? AND session_id=?')
          .get(key, sessionId).seq;
        const result = appendSessionInjection({ entries, nextSequence }, input);
        if (!duplicate) {
          const row = result.state.entries.at(-1);
          db.prepare('INSERT INTO native_session_inbox VALUES (?,?,?,?,?,NULL)').run(key, sessionId,
            row.injectionId, row.sequence, canonical(row));
        }
        db.exec('COMMIT'); return result.receipt;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    consume(snapshot) {
      for (const row of snapshot.sessionInjections ?? []) {
        const result = db.prepare(`UPDATE native_session_inbox SET consumed_by=?
          WHERE scope=? AND session_id=? AND injection_id=? AND seq=? AND consumed_by IS NULL`)
          .run(snapshot.runId, canonical(snapshot.scope), snapshot.sessionId, row.injectionId, row.sequence);
        invariant(result.changes === 1, 'session_injection_admission_conflict');
      }
    },
  };
}
