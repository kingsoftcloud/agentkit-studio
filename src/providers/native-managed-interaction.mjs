/** Managed A2A answers belong to a separate durable interaction channel.
 * They are neither Native tool approvals nor remote-operation grants. */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, copy, invariant, parseNativeJson, compileToolInput, terminal } from '@kingsoftcloud/agentkit-harness-core';
import { nativeKernelFactId } from './native-kernel-events.mjs';
import { nativeA2aReceiptWaitSource } from './native-a2a-receipt.mjs';

export const MANAGED_NATIVE_INTERACTION = 'agentkit.managed-native-a2a-interaction/v1';
const same = (a, b) => canonical(a) === canonical(b);
const unavailable = () => invariant(false, 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE');
const identity = snapshot => Object.fromEntries(['scope', 'sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
  .map(key => [key, copy(snapshot[key])]));

export function createManagedNativeInteractions({ db, guard, transaction, append, lookup, hash, clock, lifetime }) {
  db.exec(`CREATE TABLE IF NOT EXISTS managed_interactions (interaction_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL, answer TEXT, command_id TEXT,
    owner_id TEXT, owner_until INTEGER NOT NULL DEFAULT 0)`);
  const row = id => db.prepare('SELECT * FROM managed_interactions WHERE interaction_id=?').get(id);
  const closed = data => data.closed === true;
  function current(data) {
    guard();
    const { root, source } = lookup(data.query);
    invariant(same(identity(root.snapshot), data.parent) && same(identity(source.snapshot), data.source)
      && hash(root.configuration) === data.parentConfigDigest && !terminal(root.snapshot.phase)
      && !['finalizing', 'paused'].includes(root.snapshot.phase) && !root.snapshot.childTerminalPhase
      && hash(source.configuration) === data.configDigest && hash(source.snapshot) === data.checkpointDigest
      && !root.commands.some(item => !item.consumed) && !source.commands.some(item => !item.consumed)
      && nativeA2aReceiptWaitSource(source) && clock() < data.wait.deadlineAt,
    'NATIVE_MANAGED_INTERACTION_UNAVAILABLE');
    return true;
  }
  function pending(command) {
    const found = row(command.payload.interaction_id);
    if (!found || found.session_id !== command.session_id || found.run_id !== command.payload.run_id) return null;
    const data = parseNativeJson(found.data);
    if (closed(data)) return null;
    try { current(data); } catch (error) {
      if (error.code === 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE') return null;
      throw error;
    }
    if (found.answer !== null || found.owner_until <= clock()) return null;
    return copy(data.pending);
  }
  function normalize(pending, payload) {
    invariant((payload.expected_revision ?? 1) === pending.revision
      && (payload.a2a_interaction_kind === undefined || payload.a2a_interaction_kind === pending.kind),
    'NATIVE_MANAGED_INTERACTION_CONFLICT');
    const action = payload.action ?? 'submit';
    invariant((pending.kind === 'approval' ? ['approve', 'reject'] : ['submit', 'reject']).includes(action),
      'NATIVE_MANAGED_INTERACTION_CONFLICT');
    if (action !== 'submit') return { action };
    let validate;
    try { validate = compileToolInput(pending.request_schema); } catch { unavailable(); }
    // Match the original A2A continuation's UI result-envelope handling while
    // retaining the raw Server response in the durable event and answer parts.
    const raw = payload.response, value = raw && typeof raw === 'object' && !Array.isArray(raw)
      && Object.keys(raw).length === 1 && Object.hasOwn(raw, 'result') && pending.request_schema.type !== 'object' ? raw.result : raw;
    invariant(validate(value), 'NATIVE_MANAGED_INTERACTION_CONFLICT');
    return { action, parts: [{ data: copy(payload.response) }] };
  }
  // Called INSIDE the Server command admission transaction. The full answer,
  // command receipt and resolved event become durable together, before ACK.
  function validate(command, expected) {
    const found = pending(command);
    invariant(found && same(found, expected), 'NATIVE_MANAGED_INTERACTION_CONFLICT');
    return normalize(found, command.payload);
  }
  function resolve(command, expected, authorization) {
    const answer = validate(command, expected), found = expected;
    const updated = db.prepare('UPDATE managed_interactions SET answer=?,command_id=? WHERE interaction_id=? AND answer IS NULL')
      .run(canonical(answer), command.command_id, found.interactionId);
    invariant(updated.changes === 1, 'NATIVE_MANAGED_INTERACTION_CONFLICT');
    append(command.session_id, [{ event_id: nativeKernelFactId(found.interactionId, 'resolved'),
      family: 'interaction', family_version: 1, event_type: 'interaction.resolved', run_id: command.payload.run_id,
      payload: { interaction_id: found.interactionId, revision: 2, kind: found.kind,
        outcome: answer.action === 'approve' ? 'approved' : answer.action === 'reject' ? 'rejected' : 'submitted',
        response: copy(command.payload.response), actor_ref: authorization.subjectRef } }, {
      event_id: nativeKernelFactId(found.interactionId, 'running'), family: 'control', family_version: 1,
      event_type: 'control.run_transition', run_id: command.payload.run_id,
      payload: { run_id: command.payload.run_id, state: 'running' } }], command);
  }
  function owns(command) {
    const found = row(command.payload.interaction_id);
    return found && found.command_id === command.command_id && found.session_id === command.session_id
      && found.run_id === command.payload.run_id && found.answer !== null;
  }
  // Runs in the same projection transaction as the original Native terminal.
  // Shutdown/expired registration alone never fabricates a cancellation.
  function settle(run, record, command) {
    if (!terminal(record.snapshot.phase)) return;
    for (const found of db.prepare('SELECT * FROM managed_interactions WHERE run_id=? AND answer IS NULL').all(run.run_id)) {
      const data = parseNativeJson(found.data); if (closed(data)) continue;
      data.closed = true;
      db.prepare('UPDATE managed_interactions SET data=?,owner_until=0 WHERE interaction_id=?').run(canonical(data), found.interaction_id);
      const expired = clock() >= data.wait.deadlineAt;
      append(found.session_id, [{ event_id: nativeKernelFactId(found.interaction_id, expired ? 'expired' : 'cancelled'), family: 'interaction', family_version: 1,
        event_type: expired ? 'interaction.expired' : 'interaction.cancelled', run_id: run.run_id, payload: { interaction_id: found.interaction_id,
          kind: data.pending.kind, revision: 2, reason: expired ? 'interaction_deadline_exceeded' : `native_run_${record.snapshot.phase}` } }], command);
    }
  }
  async function present({ query, snapshot, wait, signal, assertCurrent, presentLocal }) {
    guard(); signal.throwIfAborted(); invariant(assertCurrent() === true, 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE');
    const { root, source, command } = lookup(query);
    const { questionDigest, ...question } = copy(wait);
    invariant(same(source.snapshot, snapshot) && wait.contract === 'agentkit.a2a-question-wait/v1'
      && hash(question) === questionDigest && ['structured_input', 'approval'].includes(wait.request?.request_type),
    'NATIVE_MANAGED_INTERACTION_UNAVAILABLE');
    const interactionId = `managed-a2a-${hash({ parent: identity(root.snapshot), source: identity(snapshot), questionDigest })}`;
    const data = { contract: MANAGED_NATIVE_INTERACTION, query: copy(query), parent: identity(root.snapshot), source: identity(snapshot),
      parentConfigDigest: hash(root.configuration), configDigest: hash(source.configuration), checkpointDigest: hash(snapshot), wait: copy(wait),
      pending: { interactionId, kind: wait.request.request_type, revision: 1,
        request_schema: copy(wait.request.schema ?? {}), nativeTarget: { ...identity(snapshot),
          operationKey: snapshot.toolReconciliation.operationKey, remoteInteractionId: wait.interactionId, questionDigest } } };
    current(data);
    transaction(() => {
      const old = row(interactionId);
      if (old) {
        // Pause/resume changes the Native checkpoint, while the original
        // remote interaction, immutable schema and answer identity stay fixed.
        const stable = value => { const result = copy(value); delete result.checkpointDigest; return result; };
        invariant(!closed(parseNativeJson(old.data)) && same(stable(parseNativeJson(old.data)), stable(data)), 'NATIVE_MANAGED_INTERACTION_CONFLICT');
        db.prepare('UPDATE managed_interactions SET data=? WHERE interaction_id=?').run(canonical(data), interactionId);
        return;
      }
      db.prepare('INSERT INTO managed_interactions(interaction_id,session_id,run_id,data) VALUES (?,?,?,?)')
        .run(interactionId, query.sessionId, query.runId, canonical(data));
      append(query.sessionId, [{ event_id: nativeKernelFactId(interactionId, 'requested'), family: 'interaction', family_version: 1,
        event_type: 'interaction.requested', run_id: query.runId, payload: { interaction_id: interactionId,
          kind: data.pending.kind, revision: 1, request: { kind: data.pending.kind,
            request_schema: data.pending.request_schema, expires_at: new Date(wait.deadlineAt).toISOString(),
            presentation: { title: data.pending.kind === 'approval' ? 'Remote approval' : 'Remote input',
              description: wait.request.prompt ?? '' } } } }, {
        event_id: nativeKernelFactId(interactionId, 'waiting'), family: 'control', family_version: 1,
        event_type: 'control.run_transition', run_id: query.runId, payload: { run_id: query.runId, state: 'waiting' } }], command);
    });
    const owner = randomUUID(), local = new AbortController();
    const scoped = AbortSignal.any([signal, lifetime.signal, local.signal]);
    let claimed = false;
    try {
      for (;;) {
        scoped.throwIfAborted(); invariant(assertCurrent() === true, 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE'); current(data);
        const found = row(interactionId);
        if (found.answer !== null) return parseNativeJson(found.answer);
        claimed = transaction(() => db.prepare(`UPDATE managed_interactions SET owner_id=?,owner_until=?
          WHERE interaction_id=? AND answer IS NULL AND (owner_until<=? OR owner_id=?)`)
          .run(owner, clock() + 2000, interactionId, clock(), owner).changes === 1);
        if (claimed) break;
        await delay(100, undefined, { signal: scoped });
      }
      let localFailure;
      // Local Studio and signed Server answers race the SAME durable record.
      // Aborted/stale UI answers cannot overwrite an accepted Server answer.
      const localWork = typeof presentLocal === 'function' ? Promise.resolve().then(() => presentLocal({ wait: copy(wait), signal: scoped }))
        .then(answer => {
          scoped.throwIfAborted(); invariant(assertCurrent() === true, 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE'); current(data);
          const normalized = normalize(data.pending, { expected_revision: 1, action: answer?.action,
            response: answer?.parts?.[0]?.data });
          transaction(() => {
            const found = row(interactionId);
            if (found.answer !== null) return;
            invariant(found.owner_id === owner && found.owner_until > clock(), 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE');
            const synthetic = { ...command, command_id: nativeKernelFactId(interactionId, 'local-answer'),
              payload: { run_id: query.runId, interaction_id: interactionId, action: normalized.action,
                response: normalized.parts?.[0]?.data ?? null } };
            resolve(synthetic, data.pending, { subjectRef: data.parent.scope.userId });
          });
        }).catch(error => { localFailure = error; }) : null;
      // Do not let a non-abortable presenter hold shutdown or a Server answer.
      void localWork;
      for (;;) {
        scoped.throwIfAborted(); invariant(assertCurrent() === true, 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE'); current(data);
        const found = row(interactionId);
        if (found.answer !== null) return parseNativeJson(found.answer);
        if (localFailure && !['A2A_QUESTION_UNAVAILABLE', 'NO_PROVIDER'].includes(localFailure.code)) throw localFailure;
        transaction(() => {
          const changed = db.prepare('UPDATE managed_interactions SET owner_until=? WHERE interaction_id=? AND owner_id=? AND answer IS NULL')
            .run(clock() + 2000, interactionId, owner).changes;
          // Another receiver can commit the answer between our local peek and
          // this renewal. That is a successful delivery, not lost ownership.
          invariant(changed === 1 || row(interactionId)?.answer != null, 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE');
        });
        await delay(100, undefined, { signal: scoped });
      }
    } finally {
      local.abort(new Error('Managed interaction attempt retired'));
      if (claimed) { try { transaction(() => db.prepare('UPDATE managed_interactions SET owner_until=0 WHERE interaction_id=? AND owner_id=?')
        .run(interactionId, owner)); } catch { /* Closed owner cannot retain live answer authority. */ } }
    }
  }
  return Object.freeze({ pending, normalize, validate, resolve, owns, present, settle });
}
