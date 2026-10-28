import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TransactionalRunStore, canonical, invariant, scopeKey, parseNativeJson } from '@kingsoftcloud/agentkit-harness-core';

const collections = {
  intents: item => item.operationKey,
  receipts: item => item.operationKey,
  commands: item => item.command.commandId,
  commits: item => item.commitId,
};
const commitFingerprint = value => `sha256/v1:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

/** Dedicated Native ledger. Historical events are append-only, never rewritten. */
export class SqliteRunStore extends TransactionalRunStore {
  constructor(filename, { busyTimeoutMs = 5000, beforeCommit } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    const db = new DatabaseSync(filename);
    try {
      invariant(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0, 'invalid_busy_timeout');
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS native_schema (version INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS native_runs (key TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS native_session_heads ON native_runs(
            json_extract(data,'$.snapshot.scope'), json_extract(data,'$.snapshot.sessionId'));
          CREATE TABLE IF NOT EXISTS native_events (
            run_key TEXT NOT NULL REFERENCES native_runs(key), seq INTEGER NOT NULL,
            event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, PRIMARY KEY(run_key,seq));
          CREATE TABLE IF NOT EXISTS native_items (
            run_key TEXT NOT NULL REFERENCES native_runs(key), collection TEXT NOT NULL,
            item_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_key,collection,item_key));
        `);
        const versions = db.prepare('SELECT version FROM native_schema').all();
        if (!versions.length) db.prepare('INSERT INTO native_schema VALUES (?)').run(2);
        else invariant(versions.length === 1 && [1, 2].includes(versions[0].version), 'unsupported_native_schema');
        // Older stores duplicated the complete canonical batch in every commit
        // fingerprint. Compact these immutable identifiers atomically so a
        // long run does not repeatedly deserialize its full history. Preserve
        // the commit IDs and keep all snapshots, events and receipts intact.
        const legacy = db.prepare(`SELECT rowid,data FROM native_items WHERE collection='commits'
          AND substr(json_extract(data,'$.fingerprint'),1,1)='{'`).all();
        const compact = db.prepare('UPDATE native_items SET data=? WHERE rowid=?');
        for (const row of legacy) {
          const item = parseNativeJson(row.data);
          invariant(typeof item.fingerprint === 'string', 'invalid_commit_fingerprint');
          compact.run(canonical({ ...item, fingerprint: commitFingerprint(item.fingerprint) }), row.rowid);
        }
        if (versions.length && versions[0].version === 1) db.prepare('UPDATE native_schema SET version=2').run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) { db.close(); throw error; }

    let closed = false;
    const open = () => invariant(!closed, 'store_closed');
    const sessionHead = (scope, sessionId) => {
      open(); scopeKey(scope);
      const row = db.prepare(`SELECT data FROM native_runs
        WHERE json_extract(data,'$.snapshot.scope')=? AND json_extract(data,'$.snapshot.sessionId')=?
        ORDER BY rowid DESC LIMIT 1`).get(canonical(scope), sessionId);
      return row ? parseNativeJson(row.data).snapshot : null;
    };
    const read = key => {
      open();
      const row = db.prepare('SELECT data FROM native_runs WHERE key=?').get(key);
      if (!row) return null;
      const record = parseNativeJson(row.data);
      record.events = db.prepare('SELECT data FROM native_events WHERE run_key=? ORDER BY seq').all(key).map(item => parseNativeJson(item.data));
      for (const collection of Object.keys(collections)) record[collection] = [];
      for (const item of db.prepare('SELECT collection,data FROM native_items WHERE run_key=? ORDER BY rowid').all(key)) {
        invariant(Object.hasOwn(collections, item.collection), 'invalid_ledger_collection');
        record[item.collection].push(parseNativeJson(item.data));
      }
      return record;
    };
    const persist = (key, previous, record) => {
      const { events, intents, receipts, commands, commits, ...metadata } = record;
      db.prepare('INSERT INTO native_runs(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, canonical(metadata));
      invariant(events.length >= (previous?.events.length ?? 0), 'events_immutable');
      for (const event of events.slice(previous?.events.length ?? 0))
        db.prepare('INSERT INTO native_events VALUES (?,?,?,?)').run(key, event.seq, event.eventId, canonical(event));
      for (const [collection, identify] of Object.entries(collections)) {
        const old = new Map((previous?.[collection] ?? []).map(item => [identify(item), canonical(item)]));
        invariant(record[collection].length >= old.size, 'ledger_items_immutable');
        for (const item of record[collection]) {
          const id = identify(item), data = canonical(item);
          if (old.get(id) !== data) db.prepare('INSERT INTO native_items VALUES (?,?,?,?) ON CONFLICT(run_key,collection,item_key) DO UPDATE SET data=excluded.data')
            .run(key, collection, id, data);
        }
      }
      beforeCommit?.({ key, record });
    };
    super({
      commitFingerprint,
      sessionHead,
      // A lease update changes only the owned run header. Keeping this path
      // independent of the event/receipt journal prevents heartbeat cost from
      // growing with the length of the conversation. Fault-injection callers
      // retain the full update path and its beforeCommit hook.
      ...(!beforeCommit ? { updateLease: (key, change) => {
        open(); db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare(`SELECT json_extract(data,'$.lease') AS lease,
            json_extract(data,'$.fence') AS fence FROM native_runs WHERE key=?`).get(key);
          const { record, value } = change(row ? { lease: row.lease === null ? null : parseNativeJson(row.lease), fence: row.fence } : null);
          invariant(row, 'run_not_found');
          db.prepare(`UPDATE native_runs SET data=json_set(data,'$.lease',json(?),'$.fence',?) WHERE key=?`)
            .run(canonical(record.lease), record.fence, key);
          db.exec('COMMIT'); return value;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } } : {}),
      eventsAfter: (key, after) => {
        open(); db.exec('BEGIN');
        try {
          const exists = db.prepare('SELECT 1 AS present FROM native_runs WHERE key=?').get(key);
          const events = exists ? db.prepare('SELECT data FROM native_events WHERE run_key=? AND seq>? ORDER BY seq')
            .all(key, after).map(row => parseNativeJson(row.data)) : null;
          db.exec('COMMIT'); return events;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      commands: key => {
        open(); db.exec('BEGIN');
        try {
          const exists = db.prepare('SELECT 1 FROM native_runs WHERE key=?').get(key);
          const commands = exists ? db.prepare(`SELECT data FROM native_items
            WHERE run_key=? AND collection='commands' AND json_extract(data,'$.consumed')=0 ORDER BY rowid`)
            .all(key).map(row => parseNativeJson(row.data)) : null;
          db.exec('COMMIT'); return commands;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      get: key => {
        open(); db.exec('BEGIN');
        try { const value = read(key); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      snapshots: (scope, sessionId) => {
        open();
        return db.prepare(`SELECT json_extract(data,'$.snapshot') AS snapshot FROM native_runs
          WHERE json_extract(data,'$.snapshot.scope')=?
          ${sessionId === undefined ? '' : "AND json_extract(data,'$.snapshot.sessionId')=?"} ORDER BY rowid`)
          .all(canonical(scope), ...(sessionId === undefined ? [] : [sessionId])).map(row => parseNativeJson(row.snapshot));
      },
      heads: (scope, sessionId) => {
        open();
        return db.prepare(`SELECT json_object(
          'scope',json_extract(data,'$.snapshot.scope'), 'runId',json_extract(data,'$.snapshot.runId'),
          'sessionId',json_extract(data,'$.snapshot.sessionId'), 'phase',json_extract(data,'$.snapshot.phase'),
          'revision',json_extract(data,'$.snapshot.revision'), 'eventSeq',json_extract(data,'$.snapshot.eventSeq'),
          'backgroundCommands',json_extract(data,'$.snapshot.backgroundCommands'), 'lease',json_extract(data,'$.lease')) AS head
          FROM native_runs WHERE json_extract(data,'$.snapshot.scope')=?
          ${sessionId === undefined ? '' : "AND json_extract(data,'$.snapshot.sessionId')=?"} ORDER BY rowid`)
          .all(canonical(scope), ...(sessionId === undefined ? [] : [sessionId])).map(row => parseNativeJson(row.head));
      },
      values: () => {
        open(); db.exec('BEGIN');
        try {
          const values = db.prepare('SELECT key FROM native_runs ORDER BY rowid').all().map(row => read(row.key));
          db.exec('COMMIT'); return values;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      update: (key, change) => {
        open(); db.exec('BEGIN IMMEDIATE');
        try {
          const previous = read(key);
          const { record, value } = change(previous, sessionHead);
          persist(key, previous, record);
          db.exec('COMMIT'); return value;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      updatePair: (keys, change) => {
        open(); db.exec('BEGIN IMMEDIATE');
        try {
          const previous = keys.map(read), { records, value } = change(previous);
          keys.forEach((key, index) => persist(key, previous[index], records[index]));
          db.exec('COMMIT'); return value;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    });
    // Host-only recovery discovery. The caller supplies its trusted principal;
    // a deleted mutable Agent draft must not hide a committed background Run.
    // Return only scope identities, never configurations, inputs or receipts.
    this.uncertainToolCalls = (scope, sessionId) => {
      open(); scopeKey(scope);
      invariant(typeof sessionId === 'string' && sessionId.trim(), 'invalid_session_id');
      // Only identity/status crosses into JavaScript. The newest completed
      // observation wins; a reconciled receipt cannot be obscured by its old
      // unknown intent. Lost claims with no completed fact use their receipts.
      return db.prepare(`WITH owned AS MATERIALIZED (
          SELECT key, json_extract(data,'$.snapshot.runId') AS runId,
            json_extract(data,'$.snapshot.turnId') AS turnId FROM native_runs
          WHERE json_extract(data,'$.snapshot.scope')=? AND json_extract(data,'$.snapshot.sessionId')=?
        ), completed AS MATERIALIZED (
          SELECT o.key, o.runId, o.turnId, json_extract(e.data,'$.payload.callId') AS callId,
            json_extract(e.data,'$.payload.status') AS status,
            row_number() OVER (PARTITION BY o.key,json_extract(e.data,'$.payload.callId') ORDER BY e.seq DESC) AS rank
          FROM owned o JOIN native_events e ON e.run_key=o.key
          WHERE json_extract(e.data,'$.kind')='tool.completed'
        ), lost AS (
          SELECT o.runId, o.turnId, json_extract(c.value,'$.callId') AS callId,
            CASE WHEN json_extract(r.data,'$.status')='uncertain' THEN 'uncertain'
              ELSE json_extract(r.data,'$.result.results[' || c.key || '].status') END AS status,
            row_number() OVER (PARTITION BY o.key,json_extract(c.value,'$.callId') ORDER BY r.rowid DESC) AS rank
          FROM owned o JOIN native_items r ON r.run_key=o.key AND r.collection='receipts'
            JOIN native_items i ON i.run_key=o.key AND i.collection='intents' AND i.item_key=r.item_key
            JOIN json_each(i.data,'$.payload.calls') c
          WHERE json_extract(i.data,'$.kind')='tool' AND NOT EXISTS (
            SELECT 1 FROM completed e WHERE e.key=o.key AND e.callId=json_extract(c.value,'$.callId'))
        ) SELECT runId,turnId,callId FROM completed WHERE rank=1 AND status='uncertain'
          UNION ALL SELECT runId,turnId,callId FROM lost WHERE rank=1 AND status='uncertain'`)
        .all(canonical(scope), sessionId).map(row => ({ ...row }));
    };
    this.listScopes = principal => {
      open();
      invariant(principal && typeof principal === 'object' && !Array.isArray(principal)
        && Object.keys(principal).length === 3
        && ['tenantId', 'workspaceId', 'userId'].every(key => Object.hasOwn(principal, key)
          && typeof principal[key] === 'string' && principal[key].trim()), 'invalid_recovery_principal');
      return db.prepare(`SELECT DISTINCT json_extract(data,'$.snapshot.scope') AS scope FROM native_runs
        WHERE json_extract(data,'$.snapshot.scope.tenantId')=?
          AND json_extract(data,'$.snapshot.scope.workspaceId')=?
          AND json_extract(data,'$.snapshot.scope.userId')=? ORDER BY scope`)
        .all(principal.tenantId, principal.workspaceId, principal.userId).map(row => {
          const scope = parseNativeJson(row.scope);
          scopeKey(scope);
          invariant(['tenantId', 'workspaceId', 'userId'].every(key => scope[key] === principal[key]), 'recovery_scope_mismatch');
          return scope;
        });
    };
    this.close = () => { if (!closed) { db.close(); closed = true; } };
  }
}
