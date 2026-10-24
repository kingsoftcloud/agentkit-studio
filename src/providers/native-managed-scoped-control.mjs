/** Durable delivery of a Server control to its original A2A scope. This queue
 * never submits Native root cancellation or retries an unknown remote effect;
 * the original A2A control journal owns its own effect admission/reconciliation. */
import { randomUUID } from 'node:crypto';
import { canonical, copy, invariant, parseNativeJson, terminal } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeKernelFactId } from './native-kernel-events.mjs';

export const MANAGED_NATIVE_SCOPED_CONTROL = 'agentkit.managed-native-scoped-control/v1';
export function createManagedNativeScopedControls({ db, guard, transaction, append, lookup, control, clock, lifetime, wake }) {
  invariant(control === undefined || typeof control?.prepare === 'function' && typeof control?.execute === 'function',
    'NATIVE_KERNEL_CONFIGURATION_INVALID');
  db.exec(`CREATE TABLE IF NOT EXISTS managed_scoped_controls (command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    run_id TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', result TEXT, owner_id TEXT,
    owner_until INTEGER NOT NULL DEFAULT 0)`);
  const owner = randomUUID(), work = new Map();
  let closed = false;
  const row = id => db.prepare('SELECT * FROM managed_scoped_controls WHERE command_id=?').get(id);
  function current(data) {
    guard();
    const value = lookup(data.command.session_id, data.runId), snapshot = value.record?.snapshot;
    invariant(value && snapshot && !terminal(snapshot.phase) && value.configDigest === data.configDigest
      && canonical(value.scope) === canonical(data.scope), 'NATIVE_MANAGED_SCOPE_UNAVAILABLE');
    return value;
  }
  async function prepare(command, runId) {
    invariant(control, 'NATIVE_MANAGED_SCOPE_UNSUPPORTED');
    const value = lookup(command.session_id, runId);
    const data = { contract: MANAGED_NATIVE_SCOPED_CONTROL, command: copy(command), runId,
      scope: copy(value.scope), configDigest: value.configDigest };
    current(data);
    const target = await control.prepare({ command: copy(command), run: copy(value), signal: lifetime.signal });
    current(data);
    invariant(target && typeof target === 'object' && target.scopeId === command.payload.scope_id
      && Buffer.byteLength(canonical(target)) <= 1024 * 1024, 'NATIVE_MANAGED_SCOPE_NOT_FOUND');
    return { ...data, target: copy(target) };
  }
  // Called in the same transaction as command admission/receipt/fact.
  function admit(command, data, authorization) {
    current(data);
    db.prepare('INSERT INTO managed_scoped_controls(command_id,session_id,run_id,data) VALUES (?,?,?,?)')
      .run(command.command_id, command.session_id, data.runId, canonical({ ...data, actor: authorization.subjectRef }));
    db.prepare("UPDATE managed_commands SET state='delivered' WHERE command_id=?").run(command.command_id);
  }
  async function deliver(found) {
    const stop = new AbortController(), signal = AbortSignal.any([lifetime.signal, stop.signal]);
    const data = parseNativeJson(found.data);
    let timer;
    const assertCurrent = () => {
      signal.throwIfAborted(); current(data);
      const saved = row(found.command_id);
      invariant(!closed && saved?.state === 'queued' && saved.owner_id === owner && saved.owner_until > clock(),
        'NATIVE_MANAGED_SCOPE_AUTHORITY_LOST');
      return true;
    };
    try {
      assertCurrent();
      timer = setInterval(() => {
        try { transaction(() => {
          assertCurrent();
          db.prepare('UPDATE managed_scoped_controls SET owner_until=? WHERE command_id=? AND owner_id=?')
            .run(clock() + 2000, found.command_id, owner);
        }); } catch (error) { stop.abort(error); }
      }, 100);
      let abort;
      const retired = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
      let result;
      try { result = await Promise.race([Promise.resolve().then(() => { assertCurrent();
        return control.execute({ command: copy(data.command), target: copy(data.target), actor: data.actor,
          run: copy(current(data)), signal, assertCurrent }); }), retired]); }
      finally { signal.removeEventListener('abort', abort); }
      assertCurrent();
      transaction(() => { assertCurrent();
        db.prepare("UPDATE managed_scoped_controls SET state='delivered',result=?,owner_until=0 WHERE command_id=? AND owner_id=?")
          .run(canonical(result ?? null), found.command_id, owner); });
      wake();
    } catch (error) {
      if (!signal.aborted && !closed) {
        // These errors precede delivery or denote permanent authority loss.
        // Retrying transport/business errors uses the SAME original A2A command
        // identity, whose private journal refuses uncertain effect resends.
        const permanent = ['NATIVE_MANAGED_SCOPE_UNAVAILABLE', 'NATIVE_MANAGED_SCOPE_NOT_FOUND',
          'NATIVE_MANAGED_SCOPE_TARGET_CHANGED', 'STUDIO_NATIVE_A2A_PRESET_CHANGED', 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE',
          'studio_native_recovery_preset_changed', 'studio_native_recovery_identity_mismatch', 'stored_configuration_mismatch',
          'studio_native_recovery_binding_invalid', 'studio_native_recovery_binding_missing',
          'A2A_CONTROL_PERMISSION_DENIED', 'A2A_CONTROL_IDEMPOTENCY_CONFLICT', 'A2A_CALL_IDENTITY_CONFLICT', 'A2A_CALL_NOT_FOUND'].includes(error?.code);
        transaction(() => {
          if (row(found.command_id)?.owner_id !== owner) return;
          db.prepare('UPDATE managed_scoped_controls SET state=?,owner_until=?,result=? WHERE command_id=? AND owner_id=?')
            .run(permanent ? 'rejected' : 'queued', permanent ? 0 : clock() + 1000,
              canonical({ error: permanent ? 'native_child_scope_unavailable' : 'native_scope_delivery_pending' }), found.command_id, owner);
          if (permanent) append(found.session_id, [{ event_id: nativeKernelFactId(found.command_id, 'scoped-delivery-rejected'),
            family: 'control', family_version: 1, event_type: 'control.command_rejected', run_id: found.run_id,
            payload: { command_id: found.command_id, reason: 'native_child_scope_unavailable' } }], data.command);
        });
      }
    } finally {
      clearInterval(timer); stop.abort(new Error('Scoped control attempt retired'));
      if (!closed && !lifetime.signal.aborted) transaction(() => db.prepare('UPDATE managed_scoped_controls SET owner_id=NULL WHERE command_id=? AND owner_id=?')
        .run(found.command_id, owner));
    }
  }
  function drain() {
    if (closed || !control) return;
    guard();
    for (const found of db.prepare("SELECT * FROM managed_scoped_controls WHERE state='queued' AND owner_until<=? ORDER BY rowid").all(clock())) {
      if (work.has(found.command_id)) continue;
      const claimed = transaction(() => db.prepare("UPDATE managed_scoped_controls SET owner_id=?,owner_until=? WHERE command_id=? AND state='queued' AND owner_until<=?")
        .run(owner, clock() + 2000, found.command_id, clock()).changes);
      if (!claimed) continue;
      const task = deliver(found); work.set(found.command_id, task);
      void task.finally(() => work.delete(found.command_id)).catch(() => {});
    }
  }
  return Object.freeze({ prepare, admit, drain, supported: Boolean(control),
    async close() { closed = true; await Promise.allSettled([...work.values()]); } });
}
