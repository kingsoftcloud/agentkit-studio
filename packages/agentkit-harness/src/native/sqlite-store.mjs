import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TransactionalRunStore, canonical, invariant, scopeKey, parseNativeJson } from '../../../agentkit-harness-core/dist/index.mjs';

const collections = {
  intents: item => item.operationKey,
  receipts: item => item.operationKey,
  commands: item => item.command.commandId,
  commits: item => item.commitId,
};

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
        if (!versions.length) db.prepare('INSERT INTO native_schema VALUES (?)').run(1);
        else invariant(versions.length === 1 && versions[0].version === 1, 'unsupported_native_schema');
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
    super({
      sessionHead,
      get: key => {
        open(); db.exec('BEGIN');
        try { const value = read(key); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
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
          const { events, intents, receipts, commands, commits, ...metadata } = record;
          db.prepare('INSERT INTO native_runs(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(key, canonical(metadata));
          invariant(events.length >= (previous?.events.length ?? 0), 'events_immutable');
          for (const event of events.slice(previous?.events.length ?? 0)) {
            db.prepare('INSERT INTO native_events VALUES (?,?,?,?)').run(key, event.seq, event.eventId, canonical(event));
          }
          for (const [collection, identify] of Object.entries(collections)) {
            const old = new Map((previous?.[collection] ?? []).map(item => [identify(item), canonical(item)]));
            invariant(record[collection].length >= old.size, 'ledger_items_immutable');
            for (const item of record[collection]) {
              const id = identify(item), data = canonical(item);
              if (old.get(id) === data) continue;
              db.prepare('INSERT INTO native_items VALUES (?,?,?,?) ON CONFLICT(run_key,collection,item_key) DO UPDATE SET data=excluded.data').run(key, collection, id, data);
            }
          }
          beforeCommit?.({ key, record });
          db.exec('COMMIT'); return value;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    });
    this.close = () => { if (!closed) { db.close(); closed = true; } };
  }
}
