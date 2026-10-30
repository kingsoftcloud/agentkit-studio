import { createSqliteSessionInbox } from './sqlite-session-inbox.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deliveryJournalHead, matchesDeliveryJournal, sessionDeliveryEntries, deliveryStateFromEntries,
  DELIVERY_SNAPSHOT_FIELDS } from './session-delivery-journal.mjs';
import { toolContext } from '@kingsoftcloud/agentkit-harness-core/tool-context';
import { NATIVE_RUN_OBSERVATION, NATIVE_COMMIT_PROJECTION, projectNativeRunObservation,
  advanceNativeRunControlObservation, advanceNativeRunCommitObservation } from './run-observation.mjs';
import { TransactionalRunStore, canonical, invariant, scopeKey, runKey, parseNativeJson,
  TOOL_AUTHORITY_SNAPSHOT_FIELDS, TOOL_AUTHORITY_CONFIGURATION_FIELDS,
  projectLedgerCommitState, applyLedgerCommitChanges, workspaceTouchEvidence } from '@kingsoftcloud/agentkit-harness-core';

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
        const hadOpenIndex = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_open_intents'").get());
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
          CREATE TABLE IF NOT EXISTS native_run_observations (
            run_key TEXT PRIMARY KEY REFERENCES native_runs(key), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS native_delivery_heads (
            run_key TEXT PRIMARY KEY REFERENCES native_runs(key), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS native_delivery_items (
            run_key TEXT NOT NULL REFERENCES native_runs(key), collection TEXT NOT NULL,
            item_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_key,collection,item_key));
          CREATE TABLE IF NOT EXISTS native_open_intents (
            run_key TEXT NOT NULL REFERENCES native_runs(key), item_key TEXT NOT NULL,
            PRIMARY KEY(run_key,item_key));
          CREATE TRIGGER IF NOT EXISTS native_intent_open AFTER INSERT ON native_items
            WHEN NEW.collection='intents' BEGIN
              INSERT OR IGNORE INTO native_open_intents SELECT NEW.run_key,NEW.item_key
                WHERE NOT EXISTS (SELECT 1 FROM native_items WHERE run_key=NEW.run_key
                  AND collection='receipts' AND item_key=NEW.item_key);
            END;
          CREATE TRIGGER IF NOT EXISTS native_intent_settled AFTER INSERT ON native_items
            WHEN NEW.collection='receipts' BEGIN
              DELETE FROM native_open_intents WHERE run_key=NEW.run_key AND item_key=NEW.item_key;
            END;
        `);
        // Derived key index; triggers also cover older schema-compatible
        // writers. No historical payload, event or identity is rewritten.
        if (!hadOpenIndex) db.exec(`INSERT INTO native_open_intents
          SELECT i.run_key,i.item_key FROM native_items i WHERE i.collection='intents'
          AND NOT EXISTS (SELECT 1 FROM native_items r WHERE r.run_key=i.run_key
            AND r.collection='receipts' AND r.item_key=i.item_key)`);
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
    let inbox;
    try { inbox = createSqliteSessionInbox(db, open); }
    catch (error) { db.close(); throw error; }
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
    const readControl = key => {
      const row = db.prepare('SELECT data FROM native_runs WHERE key=?').get(key);
      if (!row) return null;
      const { configuration, snapshot, lease, fence, projections } = parseNativeJson(row.data);
      const pending = snapshot.pendingIntent === null ? null : db.prepare(`SELECT data FROM native_items
        WHERE run_key=? AND collection='intents' AND item_key=?`).get(key, snapshot.pendingIntent);
      const receipt = snapshot.pendingIntent === null ? null : db.prepare(`SELECT 1 FROM native_items
        WHERE run_key=? AND collection='receipts' AND item_key=?`).get(key, snapshot.pendingIntent);
      const commands = db.prepare(`SELECT data FROM native_items WHERE run_key=? AND collection='commands' ORDER BY rowid`)
        .all(key).map(item => parseNativeJson(item.data));
      return { configuration, snapshot, lease, fence, projections, commands,
        pendingIntent: pending ? parseNativeJson(pending.data) : null, pendingIntentHasReceipt: Boolean(receipt) };
    };
    const readCommit = (key, batch) => {
      const row = db.prepare('SELECT data FROM native_runs WHERE key=?').get(key);
      if (!row) return null;
      const metadata = parseNativeJson(row.data);
      const intents = new Map(db.prepare(`SELECT i.item_key,i.data FROM native_open_intents o
        JOIN native_items i ON i.run_key=o.run_key AND i.collection='intents' AND i.item_key=o.item_key
        WHERE o.run_key=?`)
        .all(key).map(row => [row.item_key, parseNativeJson(row.data)]));
      const keys = new Set([...batch.intents, ...batch.receipts].map(item => item.operationKey));
      const intentAt = db.prepare("SELECT data FROM native_items WHERE run_key=? AND collection='intents' AND item_key=?");
      for (const operationKey of keys) if (!intents.has(operationKey)) {
        const found = intentAt.get(key, operationKey);
        if (found) intents.set(operationKey, parseNativeJson(found.data));
      }
      const receiptAt = db.prepare("SELECT 1 FROM native_items WHERE run_key=? AND collection='receipts' AND item_key=?");
      const existingReceiptKeys = [...new Set([...keys, ...intents.keys()])].filter(operationKey => receiptAt.get(key, operationKey));
      const eventAt = db.prepare('SELECT 1 FROM native_events WHERE event_id=?');
      const duplicate = db.prepare("SELECT data FROM native_items WHERE run_key=? AND collection='commits' AND item_key=?")
        .get(key, batch.commitId);
      const commands = db.prepare(`SELECT data FROM native_items WHERE run_key=? AND collection='commands'
        AND json_extract(data,'$.consumed')=0 ORDER BY rowid`).all(key).map(row => parseNativeJson(row.data));
      return { ...metadata, commands, intents: [...intents.values()], existingReceiptKeys,
        existingEventIds: batch.events.filter(event => eventAt.get(event.eventId)).map(event => event.eventId),
        duplicateCommit: duplicate ? parseNativeJson(duplicate.data) : null };
    };
    const deliveryHead = key => {
      const row = db.prepare('SELECT data FROM native_delivery_heads WHERE run_key=?').get(key);
      return row ? parseNativeJson(row.data) : null;
    };
    const writeDeliveryHead = (key, snapshot) => db.prepare(`INSERT INTO native_delivery_heads VALUES (?,?)
      ON CONFLICT(run_key) DO UPDATE SET data=excluded.data`).run(key, canonical(deliveryJournalHead(snapshot)));
    const appendDelivery = (key, evidence, snapshot) => {
      const insert = db.prepare(`INSERT INTO native_delivery_items VALUES (?,?,?,?)
        ON CONFLICT(run_key,collection,item_key) DO UPDATE SET data=CASE
          WHEN native_delivery_items.collection='tools'
            OR native_delivery_items.collection='outcomes' AND native_delivery_items.data='"not_dispatched"'
          THEN native_delivery_items.data ELSE excluded.data END`);
      for (const row of sessionDeliveryEntries(evidence)) insert.run(key, row.collection, row.key, canonical(row.data));
      writeDeliveryHead(key, snapshot);
    };
    const rebuildDelivery = (key, record) => {
      db.prepare('DELETE FROM native_delivery_items WHERE run_key=?').run(key);
      appendDelivery(key, record, record.snapshot);
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
      if (!previous) inbox.consume(record.snapshot);
      db.prepare(`INSERT INTO native_run_observations VALUES (?,?)
        ON CONFLICT(run_key) DO UPDATE SET data=excluded.data`).run(key, canonical(projectNativeRunObservation(record)));
      rebuildDelivery(key, record);
      beforeCommit?.({ key, record });
    };
    super({
      enqueueSessionInjection: inbox.enqueueSessionInjection,
      pendingSessionInjections: inbox.pendingSessionInjections,
      workspaceTouchEvidence: key => {
        open(); db.exec('BEGIN');
        try {
          const row = db.prepare(`SELECT json_object('scope',json_extract(data,'$.snapshot.scope'),
            'runId',json_extract(data,'$.snapshot.runId'),'sessionId',json_extract(data,'$.snapshot.sessionId'),
            'revision',json_extract(data,'$.snapshot.revision'),'eventSeq',json_extract(data,'$.snapshot.eventSeq'),
            'instructionScopes',json_extract(data,'$.snapshot.context.instructionScopes')) AS data
            FROM native_runs WHERE key=?`).get(key);
          let view = null;
          if (row) {
            const identity = parseNativeJson(row.data);
            // The existing (run_key,seq) primary key bounds both the reverse
            // boundary lookup and the subsequent committed-event suffix.
            const after = db.prepare(`SELECT seq FROM native_events WHERE run_key=? AND seq<=?
              AND json_extract(data,'$.kind')='model.completed' ORDER BY seq DESC LIMIT 1`).get(key, identity.eventSeq)?.seq ?? 0;
            const observations = db.prepare(`SELECT seq, json_extract(data,'$.payload.name') AS toolName,
              CASE WHEN json_type(data,'$.payload.content.path')='text' THEN json_extract(data,'$.payload.content.path') END AS path,
              (SELECT json_group_array(target) FROM (SELECT CASE WHEN item.type='object' THEN
                CASE WHEN json_type(item.value,'$.path')='text' THEN json_extract(item.value,'$.path') END END AS target
                FROM json_each(CASE WHEN json_type(e.data,'$.payload.content.written')='array'
                  THEN json_extract(e.data,'$.payload.content.written') ELSE '[]' END) item) WHERE target IS NOT NULL) AS writtenPaths,
              (SELECT json_group_array(item.value) FROM json_each(CASE WHEN json_type(e.data,'$.payload.content.changed_paths')='array'
                THEN json_extract(e.data,'$.payload.content.changed_paths') ELSE '[]' END) item WHERE item.type='text') AS changedPaths
              FROM native_events e WHERE run_key=? AND seq>? AND seq<=?
                AND json_extract(data,'$.kind')='tool.completed' AND json_extract(data,'$.payload.status')='ok'
                AND json_type(data,'$.payload.name')='text' AND length(trim(json_extract(data,'$.payload.name')))>0 ORDER BY seq`)
              .all(key, after, identity.eventSeq).map(item => ({ seq: item.seq, toolName: item.toolName,
                ...(item.path === null ? {} : { path: item.path }), writtenPaths: parseNativeJson(item.writtenPaths),
                changedPaths: parseNativeJson(item.changedPaths) }));
            view = workspaceTouchEvidence(identity, after, observations, identity.instructionScopes ?? undefined);
          }
          db.exec('COMMIT'); return view;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      commitFingerprint,
      sessionHead,
      ...(!beforeCommit ? { updateCommit: (key, batch, change) => {
        open(); db.exec('BEGIN IMMEDIATE');
        try {
          const current = readCommit(key, batch);
          const row = db.prepare('SELECT data FROM native_run_observations WHERE run_key=?').get(key);
          const observation = row ? parseNativeJson(row.data) : null;
          // Reconciliation/operator review may inspect complete historical
          // uncertainty. Old observation formats rebuild once, never guess.
          const exceptional = !current || ['interrupted', 'awaiting_reconciliation', 'reconciling_tool']
            .some(phase => current.snapshot.phase === phase || batch.snapshot.phase === phase);
          const compatible = observation?.contract === NATIVE_RUN_OBSERVATION
            && observation.commitProjection?.contract === NATIVE_COMMIT_PROJECTION
            && Array.isArray(observation.commitProjection?.tools?.calls)
            && Array.isArray(observation.facts?.toolOutcomes)
            && observation.snapshot.revision === current?.snapshot.revision
            && observation.snapshot.eventSeq === current?.snapshot.eventSeq
            && observation.snapshot.configDigest === current?.snapshot.configDigest
            && observation.snapshot.runId === current?.snapshot.runId
            && observation.snapshot.sessionId === current?.snapshot.sessionId
            && canonical(observation.snapshot.scope) === canonical(current?.snapshot.scope);
          if (exceptional || !compatible || !matchesDeliveryJournal(deliveryHead(key), current.snapshot)) {
            const previous = read(key), result = change(previous ? projectLedgerCommitState(previous, batch) : null);
            if (result.changes) persist(key, previous, applyLedgerCommitChanges(previous, result.changes));
            db.exec('COMMIT'); return result.value;
          }
          const { changes, value } = change(current);
          if (changes) {
            const { commands, intents, existingReceiptKeys, existingEventIds, duplicateCommit, ...metadata } = current;
            db.prepare('UPDATE native_runs SET data=? WHERE key=?').run(canonical({ ...metadata, snapshot: changes.snapshot }), key);
            const eventInsert = db.prepare('INSERT INTO native_events VALUES (?,?,?,?)');
            for (const event of changes.events) eventInsert.run(key, event.seq, event.eventId, canonical(event));
            const itemInsert = db.prepare('INSERT INTO native_items VALUES (?,?,?,?)');
            for (const [collection, items] of [['intents', changes.intents], ['receipts', changes.receipts], ['commits', [changes.commit]]])
              for (const item of items) itemInsert.run(key, collection, collections[collection](item), canonical(item));
            const commandUpdate = db.prepare("UPDATE native_items SET data=? WHERE run_key=? AND collection='commands' AND item_key=?");
            for (const row of changes.commands) commandUpdate.run(canonical(row), key, row.command.commandId);
            const advanced = advanceNativeRunCommitObservation(observation, current, changes);
            db.prepare('UPDATE native_run_observations SET data=? WHERE run_key=?').run(canonical(advanced), key);
            appendDelivery(key, { events: changes.events, receipts: changes.receipts,
              intents: [...current.intents, ...changes.intents] }, changes.snapshot);
          }
          db.exec('COMMIT'); return value;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } } : {}),
      controlState: key => {
        open(); db.exec('BEGIN');
        try { const value = readControl(key); db.exec('COMMIT'); return value; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      // Control-plane writes use the same shared Core validators as the full
      // backend, but never deserialize or replace historical effect results.
      // Fault-injection hooks intentionally retain the full transaction path.
      ...(!beforeCommit ? { updateControl: (key, change) => {
        open(); db.exec('BEGIN IMMEDIATE');
        try {
          const current = readControl(key), { changes, value } = change(current);
          invariant(current, 'run_not_found');
          if (changes.claim || changes.commands || changes.projections) {
            const presentationCurrent = matchesDeliveryJournal(deliveryHead(key), current.snapshot);
            const cached = db.prepare('SELECT data FROM native_run_observations WHERE run_key=?').get(key);
            let observation = cached ? parseNativeJson(cached.data) : null;
            if (!observation || observation.contract !== NATIVE_RUN_OBSERVATION
              || observation.commitProjection?.contract !== NATIVE_COMMIT_PROJECTION
              || !Array.isArray(observation.commitProjection?.tools?.calls) || !Array.isArray(observation.facts?.toolOutcomes)
              || observation.snapshot.revision !== current.snapshot.revision
              || observation.snapshot.eventSeq !== current.snapshot.eventSeq
              || observation.snapshot.configDigest !== current.snapshot.configDigest
              || observation.snapshot.runId !== current.snapshot.runId
              || observation.snapshot.sessionId !== current.snapshot.sessionId
              || canonical(observation.snapshot.scope) !== canonical(current.snapshot.scope))
              observation = projectNativeRunObservation(read(key));
            if (changes.claim) {
              const { snapshot, intent } = changes.claim;
              db.prepare("UPDATE native_runs SET data=json_set(data,'$.snapshot',json(?)) WHERE key=?")
                .run(canonical(snapshot), key);
              const result = db.prepare(`UPDATE native_items SET data=?
                WHERE run_key=? AND collection='intents' AND item_key=?`).run(canonical(intent), key, intent.operationKey);
              invariant(result.changes === 1, 'pending_intent_missing');
            }
            if (changes.commands) {
              const previous = new Map(current.commands.map(row => [row.command.commandId, canonical(row)]));
              for (const row of changes.commands) {
                const data = canonical(row), id = row.command.commandId;
                if (previous.get(id) !== data) db.prepare(`INSERT INTO native_items VALUES (?,?,?,?)
                  ON CONFLICT(run_key,collection,item_key) DO UPDATE SET data=excluded.data`).run(key, 'commands', id, data);
              }
            }
            if (changes.projections) db.prepare("UPDATE native_runs SET data=json_set(data,'$.projections',json(?)) WHERE key=?")
              .run(canonical(changes.projections), key);
            const updated = advanceNativeRunControlObservation(observation, current, changes);
            db.prepare(`INSERT INTO native_run_observations VALUES (?,?)
              ON CONFLICT(run_key) DO UPDATE SET data=excluded.data`).run(key, canonical(updated));
            if (presentationCurrent) writeDeliveryHead(key, changes.claim?.snapshot ?? current.snapshot);
          }
          db.exec('COMMIT'); return value;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } } : {}),
      sessionHeadView: (scope, sessionId) => {
        open();
        const row = db.prepare(`SELECT json_object(
          'scope',json_extract(data,'$.snapshot.scope'), 'runId',json_extract(data,'$.snapshot.runId'),
          'sessionId',json_extract(data,'$.snapshot.sessionId'), 'phase',json_extract(data,'$.snapshot.phase'),
          'revision',json_extract(data,'$.snapshot.revision'), 'eventSeq',json_extract(data,'$.snapshot.eventSeq'),
          'backgroundCommands',json_extract(data,'$.snapshot.backgroundCommands'), 'lease',json_extract(data,'$.lease')) AS head
          FROM native_runs WHERE json_extract(data,'$.snapshot.scope')=? AND json_extract(data,'$.snapshot.sessionId')=?
          ORDER BY rowid DESC LIMIT 1`).get(canonical(scope), sessionId);
        return row ? parseNativeJson(row.head) : null;
      },
      projectionCursors: key => {
        open();
        const row = db.prepare("SELECT json_extract(data,'$.projections') AS cursors FROM native_runs WHERE key=?").get(key);
        return row ? parseNativeJson(row.cursors) : null;
      },
      authority: key => {
        open(); db.exec('BEGIN');
        try {
          const row = db.prepare('SELECT data FROM native_runs WHERE key=?').get(key);
          let view = null;
          if (row) {
            const { configuration, snapshot, lease, fence } = parseNativeJson(row.data);
            const pending = snapshot.pendingIntent === null ? null : db.prepare(`SELECT data FROM native_items
              WHERE run_key=? AND collection='intents' AND item_key=?`).get(key, snapshot.pendingIntent);
            view = { configuration, snapshot, lease, fence, pendingIntent: pending ? parseNativeJson(pending.data) : null };
          }
          db.exec('COMMIT'); return view;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      toolAuthority: key => {
        open(); db.exec('BEGIN');
        try {
          // Static Core-owned field lists are the authority contract. SQLite
          // projects these fields before Node parses/copies any JSON, so old
          // screenshots, model transcripts and receipts stay outside this path.
          const fields = (names, path, operation = 'json_extract') => names.map(name => `'${name}',${operation}(data,'$.${path}.${name}')`).join(',');
          const row = db.prepare(`SELECT json_object(
            'snapshot',json_object(${fields(TOOL_AUTHORITY_SNAPSHOT_FIELDS, 'snapshot')}),
            'configuration',json_object(${fields(TOOL_AUTHORITY_CONFIGURATION_FIELDS, 'configuration')}),
            'splitModelObservation',json(CASE WHEN json_type(data,'$.configuration.modelSurface')='object' THEN 'true' ELSE 'false' END),
            'presence',json_object('snapshot',json_object(${fields(TOOL_AUTHORITY_SNAPSHOT_FIELDS, 'snapshot', 'json_type')}),
              'configuration',json_object(${fields(TOOL_AUTHORITY_CONFIGURATION_FIELDS, 'configuration', 'json_type')})),
            'lease',json_extract(data,'$.lease'),'fence',json_extract(data,'$.fence')) AS data
            FROM native_runs WHERE key=?`).get(key);
          let view = null;
          if (row) {
            view = parseNativeJson(row.data);
            for (const section of ['snapshot', 'configuration']) for (const [field, type] of Object.entries(view.presence[section]))
              if (type === null) delete view[section][field];
            delete view.presence;
            const pending = view.snapshot.phase === 'executing_tools' && view.snapshot.pendingIntent
              ? db.prepare("SELECT data FROM native_items WHERE run_key=? AND collection='intents' AND item_key=?")
                .get(key, view.snapshot.pendingIntent) : null;
            const declared = view.snapshot.sourceReadQuote ? db.prepare(`SELECT m.value AS data FROM native_runs r,
              json_each(r.data,'$.snapshot.messages') m WHERE r.key=? AND json_extract(m.value,'$.role')='assistant'
              AND json_array_length(json_extract(m.value,'$.toolCalls'))>0 ORDER BY cast(m.key AS INTEGER) DESC LIMIT 1`).get(key) : null;
            view.pendingIntent = pending ? parseNativeJson(pending.data) : null;
            view.sourceReadMessage = declared ? parseNativeJson(declared.data) : null;
          }
          db.exec('COMMIT'); return view;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      // A lease update changes only the owned run header. Keeping this path
      // independent of the event/receipt journal prevents heartbeat cost from
      // growing with the length of the conversation. Fault-injection callers
      // retain the full update path and its beforeCommit hook.
      ...(!beforeCommit ? { updateLease: (key, change) => {
        open(); db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare(`SELECT json_extract(data,'$.lease') AS lease,
            json_extract(data,'$.fence') AS fence, json_extract(data,'$.resourceRetirementReview') AS retirement FROM native_runs WHERE key=?`).get(key);
          const { record, value } = change(row ? { lease: row.lease === null ? null : parseNativeJson(row.lease), fence: row.fence,
            ...(row.retirement === null ? {} : {resourceRetirementReview:parseNativeJson(row.retirement)}) } : null);
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
    /** A presentation-only read: current transcript, display events and exact
     * unresolved closures. Historical raw tool bodies never enter this view. */
    this.sessionDeliveryState = (scope, runId) => {
      open(); const key = runKey(scope, runId);
      const header = () => {
        const fields = (operation) => DELIVERY_SNAPSHOT_FIELDS.map(name => `'${name}',${operation}(data,'$.snapshot.${name}')`).join(',');
        const row = db.prepare(`SELECT json_object(${fields('json_extract')}) AS snapshot,
          json_object(${fields('json_type')}) AS presence, json_extract(data,'$.configuration') AS configuration,
          json_extract(data,'$.projections') AS projections FROM native_runs WHERE key=?`).get(key);
        invariant(row, 'run_not_found');
        const snapshot = parseNativeJson(row.snapshot), presence = parseNativeJson(row.presence);
        for (const [name, type] of Object.entries(presence)) if (type === null) delete snapshot[name];
        invariant(snapshot.runId === runId && canonical(snapshot.scope) === canonical(scope), 'delivery_identity_mismatch');
        return { snapshot, configuration: parseNativeJson(row.configuration), projections: parseNativeJson(row.projections) };
      };
      db.exec('BEGIN');
      try {
        let current = header();
        if (!matchesDeliveryJournal(deliveryHead(key), current.snapshot)) {
          db.exec('ROLLBACK'); db.exec('BEGIN IMMEDIATE'); current = header();
          // A compatible older writer or a missing/foreign cache rebuilds
          // once from its own authoritative ledger, without rewriting it.
          if (!matchesDeliveryJournal(deliveryHead(key), current.snapshot)) rebuildDelivery(key, read(key));
        }
        const entries = db.prepare('SELECT collection,item_key,data FROM native_delivery_items WHERE run_key=? ORDER BY rowid')
          .all(key).map(row => ({ collection: row.collection, key: row.item_key, data: parseNativeJson(row.data) }));
        const closure = (_callId, reference) => {
          let intent = null, receipt = null;
          if (reference) {
            intent = db.prepare("SELECT json_extract(data,'$.status') AS status FROM native_items WHERE run_key=? AND collection='intents' AND item_key=?")
              .get(key, reference.operationKey);
            const path = `$.result.results[${reference.index}]`;
            receipt = db.prepare(`SELECT json_extract(data,'$.status') AS status, json_type(data,?) AS observed,
              json_extract(data,?) AS resultStatus, json_extract(data,?) AS context,
              json_quote(json_extract(data,?)) AS content FROM native_items
              WHERE run_key=? AND collection='receipts' AND item_key=?`)
              .get(path, path + '.status', path + '.context', path + '.content', key, reference.operationKey);
          }
          if (receipt?.status === 'committed' && receipt.observed === 'object') return {
            context: receipt.context === null ? { content: canonical(parseNativeJson(receipt.content)) } : toolContext(parseNativeJson(receipt.context)),
            isError: receipt.resultStatus !== 'ok' };
          const unknown = intent?.status === 'running' && (!receipt || receipt.status === 'uncertain');
          return { context: { content: canonical({ status: unknown ? 'uncertain' : 'not_dispatched',
            reason: unknown ? 'effect_outcome_unknown' : current.snapshot.reason ?? 'run_ended' }) }, isError: true };
        };
        const view = deliveryStateFromEntries(current, entries, closure);
        db.exec('COMMIT'); return view;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    // Host-only recovery discovery. The caller supplies its trusted principal;
    // a deleted mutable Agent draft must not hide a committed background Run.
    // Return only scope identities, never configurations, inputs or receipts.
    this.observation = (scope, runId) => {
      open();
      const key = runKey(scope, runId);
      db.exec('BEGIN');
      try {
        const readHead = () => db.prepare(`SELECT json_extract(data,'$.snapshot.revision') AS revision,
          json_extract(data,'$.snapshot.eventSeq') AS eventSeq, json_extract(data,'$.snapshot.configDigest') AS configDigest,
          json_extract(data,'$.snapshot.sessionId') AS sessionId, json_extract(data,'$.lease') AS lease,
          json_extract(data,'$.fence') AS fence, json_extract(data,'$.projections') AS projections
          FROM native_runs WHERE key=?`).get(key);
        let head = readHead();
        invariant(head, 'run_not_found');
        const row = db.prepare('SELECT data FROM native_run_observations WHERE run_key=?').get(key);
        let view = row ? parseNativeJson(row.data) : null;
        if (!view || view.contract !== NATIVE_RUN_OBSERVATION || view.commitProjection?.contract !== NATIVE_COMMIT_PROJECTION
          || !Array.isArray(view.commitProjection?.tools?.calls) || !Array.isArray(view.facts?.toolOutcomes) || view.snapshot.revision !== head.revision
          || view.snapshot.eventSeq !== head.eventSeq || view.snapshot.configDigest !== head.configDigest) {
          // One transactional, lazy migration for old ledgers. Subsequent reads
          // do not touch any event, intent, receipt, transcript or image data.
          db.exec('ROLLBACK'); db.exec('BEGIN IMMEDIATE'); head = readHead();
          invariant(head, 'run_not_found');
          view = projectNativeRunObservation(read(key));
          db.prepare(`INSERT INTO native_run_observations VALUES (?,?)
            ON CONFLICT(run_key) DO UPDATE SET data=excluded.data`).run(key, canonical(view));
        }
        invariant(canonical(view.snapshot.scope) === canonical(scope) && view.snapshot.runId === runId
          && view.snapshot.sessionId === head.sessionId, 'observation_identity_mismatch');
        // Lease heartbeats and delivery acknowledgments can change without a
        // snapshot revision. Read those live facts from the authoritative header.
        view.lease = head.lease === null ? null : parseNativeJson(head.lease);
        view.fence = head.fence; view.projections = parseNativeJson(head.projections);
        db.exec('COMMIT'); return view;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    this.sessionToolOutcomes = (scope, sessionId) => {
      open(); scopeKey(scope);
      invariant(typeof sessionId === 'string' && sessionId.trim(), 'invalid_session_id');
      // Old ledgers lazily build each missing Run view once. The steady-state
      // session query touches only materialized identities, never tool outputs.
      const missing = db.prepare(`SELECT json_extract(r.data,'$.snapshot.runId') AS runId
        FROM native_runs r LEFT JOIN native_run_observations v ON v.run_key=r.key
        WHERE json_extract(r.data,'$.snapshot.scope')=? AND json_extract(r.data,'$.snapshot.sessionId')=?
          AND (v.data IS NULL OR json_extract(v.data,'$.contract')<>?
            OR coalesce(json_extract(v.data,'$.commitProjection.contract'),'')<>?
            OR coalesce(json_type(v.data,'$.commitProjection.tools.calls'),'null')<>'array'
            OR coalesce(json_type(v.data,'$.facts.toolOutcomes'),'null')<>'array'
            OR json_extract(v.data,'$.snapshot.revision')<>json_extract(r.data,'$.snapshot.revision')
            OR json_extract(v.data,'$.snapshot.eventSeq')<>json_extract(r.data,'$.snapshot.eventSeq')
            OR json_extract(v.data,'$.snapshot.configDigest')<>json_extract(r.data,'$.snapshot.configDigest')
            OR json_extract(v.data,'$.snapshot.scope')<>json_extract(r.data,'$.snapshot.scope')
            OR json_extract(v.data,'$.snapshot.sessionId')<>json_extract(r.data,'$.snapshot.sessionId')
            OR json_extract(v.data,'$.snapshot.runId')<>json_extract(r.data,'$.snapshot.runId'))`)
        .all(canonical(scope), sessionId, NATIVE_RUN_OBSERVATION, NATIVE_COMMIT_PROJECTION);
      for (const { runId } of missing) this.observation(scope, runId);
      return db.prepare(`SELECT json_extract(v.data,'$.snapshot.runId') AS runId,
          json_extract(v.data,'$.snapshot.turnId') AS turnId, json_extract(c.value,'$.callId') AS callId,
          json_extract(c.value,'$.status') AS status
        FROM native_runs r JOIN native_run_observations v ON v.run_key=r.key
          JOIN json_each(v.data,'$.facts.toolOutcomes') c
        WHERE json_extract(r.data,'$.snapshot.scope')=? AND json_extract(r.data,'$.snapshot.sessionId')=?
          AND json_extract(v.data,'$.snapshot.scope')=json_extract(r.data,'$.snapshot.scope')
          AND json_extract(v.data,'$.snapshot.sessionId')=json_extract(r.data,'$.snapshot.sessionId')
          AND json_extract(v.data,'$.snapshot.runId')=json_extract(r.data,'$.snapshot.runId')
          AND json_extract(c.value,'$.status') IN ('uncertain','not_dispatched')
        ORDER BY r.rowid,callId`).all(canonical(scope), sessionId).map(row => ({ ...row }));
    };
    this.uncertainToolCalls = (scope, sessionId) => this.sessionToolOutcomes(scope, sessionId)
      .filter(row => row.status === 'uncertain').map(({ status, ...row }) => row);
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
