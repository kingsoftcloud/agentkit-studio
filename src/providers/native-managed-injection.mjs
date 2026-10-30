import { canonical, copy, invariant, parseNativeJson, scopeKey, validateSessionInjection } from '@kingsoftcloud/agentkit-harness-core';

/** A command-store outbox bridges admission to the Native RunStore inbox.
 * Delivery is idempotent, never calls a binding/model port and never wakes a Run.
 */
export function createManagedNativeInjection({ db, store, guard, transaction, target }) {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_injections (
    command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL);`);
  const input = command => validateSessionInjection({ injectionId: command.command_id,
    text: command.payload.content, source: { kind: command.source.kind, ref: command.source.ref || command.command_id } });
  const deliver = sessionId => {
    guard();
    const rows = db.prepare(`SELECT i.*,c.state FROM managed_injections i JOIN managed_commands c ON c.command_id=i.command_id
      WHERE c.state='injection_pending' ${sessionId === undefined ? '' : 'AND i.session_id=?'} ORDER BY c.rowid`)
      .all(...(sessionId === undefined ? [] : [sessionId]));
    for (const row of rows) {
      guard();
      try { store.inject(parseNativeJson(row.scope), row.session_id, parseNativeJson(row.data)); }
      catch (error) {
        // A full bounded inbox must not prevent its existing data from being
        // consumed by the next turn. The accepted outbox row remains pending.
        if (error.code === 'session_inbox_full') return;
        throw error;
      }
      transaction(() => db.prepare("UPDATE managed_commands SET state='injected' WHERE command_id=? AND state='injection_pending'").run(row.command_id));
    }
  };
  return {
    input,
    scope(command, supplied) {
      const previous = db.prepare('SELECT scope FROM managed_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(command.session_id);
      const scope = supplied ?? (previous ? parseNativeJson(previous.scope) : null);
      invariant(scope?.tenantId === target.tenantId && scope.agentId === target.agentInstanceId
        && typeof scope.workspaceId === 'string' && scope.workspaceId.trim()
        && typeof scope.userId === 'string' && scope.userId.trim()
        && (!previous || canonical(scope) === previous.scope), 'NATIVE_MANAGED_INJECTION_BINDING_UNAVAILABLE');
      scopeKey(scope);
      return copy(scope);
    },
    hasCapacity(command) {
      const pending = db.prepare(`SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(i.data AS BLOB))),0) AS bytes
        FROM managed_injections i JOIN managed_commands c ON c.command_id=i.command_id
        WHERE i.session_id=? AND c.state='injection_pending'`).get(command.session_id);
      return pending.count < 1000 && pending.bytes + Buffer.byteLength(canonical(input(command))) <= 2 * 1024 * 1024;
    },
    admit(command, scope) {
      db.prepare('INSERT INTO managed_injections VALUES (?,?,?,?)')
        .run(command.command_id, command.session_id, canonical(scope), canonical(input(command)));
      db.prepare("UPDATE managed_commands SET state='injection_pending' WHERE command_id=?").run(command.command_id);
    },
    deliver,
  };
}
