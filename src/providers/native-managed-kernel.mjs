/** Durable Server command receiver over the existing TypeScript NativeKernel.
 * No DSH loop, local permit issuer or Python process is involved. Local SQLite
 * is a single-machine store, not evidence of a shared hosted SQL deployment. */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeKernel, canonical, configure, copy, invariant, parseNativeJson, scopeKey, terminal } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeChildHistory } from '../../packages/agentkit-harness/src/native/child-history.mjs';
import { privateDirectory, privateFile, createPrivate } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';
import { nativeKernelFactId, projectNativeKernelEvent } from './native-kernel-events.mjs';
import { createManagedNativeInteractions } from './native-managed-interaction.mjs';
import { createManagedNativeScopedControls } from './native-managed-scoped-control.mjs';
import { createManagedNativeExecutionGrants, managedExecutionGrantId } from './native-managed-execution-grants.mjs';

export const MANAGED_NATIVE_KERNEL_CONTRACT = 'agentkit.managed-native-kernel/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() && value.length <= 4096 && !value.includes('\0');
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value);
const sourceKinds = new Set(['studio', 'responses', 'agui', 'a2a', 'parent_agent', 'scheduler', 'workflow', 'channel', 'system']);
const supported = new Set(['enqueue', 'interrupt', 'pause', 'resume', 'steer', 'submit_interaction']);
const check = condition => invariant(condition, 'NATIVE_KERNEL_COMMAND_INVALID');
function commandView(value) {
  const command = copy(value);
  check(object(command) && command.schema_version === 1 && uuid(command.command_id) && text(command.idempotency_key)
    && text(command.tenant_id) && text(command.agent_instance_id) && text(command.session_id)
    && object(command.payload) && text(command.authorization_ref) && text(command.submitted_at)
    && Number.isFinite(Date.parse(command.submitted_at)) && object(command.source)
    && sourceKinds.has(command.source.kind) && typeof command.source.ref === 'string');
  command.command_id = command.command_id.toLowerCase();
  check(['enqueue', 'interrupt', 'pause', 'resume', 'steer', 'inject', 'submit_interaction'].includes(command.command_type));
  if (command.command_type === 'enqueue') check(Object.hasOwn(command.payload, 'content'));
  if (command.command_type === 'steer') check(typeof command.payload.content === 'string' && command.payload.content.trim());
  if (command.command_type === 'submit_interaction') check(text(command.payload.run_id) && text(command.payload.interaction_id)
    && text(command.payload.token_ref) && Object.hasOwn(command.payload, 'response'));
  if (command.command_type === 'resume') check(object(command.payload.target)
    && ['run', 'checkpoint', 'continuation'].includes(command.payload.target.kind) && text(command.payload.target.id));
  if (command.payload.run_id !== undefined && command.payload.run_id !== null) check(text(command.payload.run_id));
  if (command.payload.scope_id !== undefined && command.payload.scope_id !== null) check(text(command.payload.scope_id));
  return command;
}
function businessDigest(command) {
  const value = copy(command); delete value.command_id; delete value.submitted_at; delete value.authorization_ref;
  delete value.source.ref; delete value.payload.session_context;
  if (value.command_type === 'submit_interaction') delete value.payload.token_ref;
  return hash(value);
}
export function managedNativeRunId(command) {
  // Same stable original-command lookup used by execution_grant_run_id in the
  // reference. JSON's ASCII escaping matters for non-ASCII session identifiers.
  const parts = [command.tenant_id, command.agent_instance_id, command.session_id, command.command_id.toLowerCase()];
  const encoded = JSON.stringify(parts).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const bytes = createHash('sha1').update(Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex'))
    .update('ksadk:execution-grant:' + encoded).digest();
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const rejection = (command, code, status = 'rejected') => ({ schema_version: 1, command_id: command.command_id,
  status, error: { code, message: code, retryable: status === 'queue_full', details: {} } });

export function createManagedNativeKernel({ directory, target, permitVerifier, resolveBinding, authorizeInteraction, scopedControl, assertCurrent,
  queueLimit = 100, clock = Date.now, monotonic, autoStart = true, beforeCommit, beforeProjection, onWorkerError } = {}) {
  invariant(text(directory) && object(target) && text(target.tenantId) && text(target.agentInstanceId)
    && typeof permitVerifier?.verify === 'function' && typeof resolveBinding === 'function' && typeof assertCurrent === 'function'
    && Number.isSafeInteger(queueLimit) && queueLimit > 0 && typeof autoStart === 'boolean'
    && (onWorkerError === undefined || typeof onWorkerError === 'function')
    && (monotonic === undefined || typeof monotonic === 'function')
    && (scopedControl === undefined || typeof scopedControl?.prepare === 'function' && typeof scopedControl?.execute === 'function'),
  'NATIVE_KERNEL_CONFIGURATION_INVALID');
  const bindingTarget = copy(target), verifyPermit = permitVerifier.verify, owner = `native-server-${randomUUID()}`;
  const initialAuthority = assertCurrent();
  if (initialAuthority && typeof initialAuthority.then === 'function') void Promise.resolve(initialAuthority).catch(() => {});
  invariant(initialAuthority === true, 'NATIVE_KERNEL_AUTHORITY_LOST');
  privateDirectory(directory, true);
  for (const filename of ['commands.sqlite', 'runs.sqlite']) {
    const path = join(directory, filename);
    if (!privateFile(path, true)) {
      try { createPrivate(path); } catch (error) { if (error.code !== 'EEXIST') throw error; privateFile(path); }
    }
    for (const suffix of ['-wal', '-shm', '-journal']) privateFile(path + suffix, true);
  }
  const db = new DatabaseSync(join(directory, 'commands.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS managed_schema (version INTEGER PRIMARY KEY)');
      const versions = db.prepare('SELECT version FROM managed_schema').all();
      invariant(!versions.length || versions.length === 1 && versions[0].version === 1, 'NATIVE_KERNEL_SCHEMA_UNSUPPORTED');
      if (!versions.length) db.prepare('INSERT INTO managed_schema VALUES (1)').run();
      db.exec(`CREATE TABLE IF NOT EXISTS managed_binding (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS managed_nonces (nonce TEXT PRIMARY KEY, command_id TEXT NOT NULL, idem TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS managed_commands (command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      idem TEXT NOT NULL, digest TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL, receipt TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'accepted', UNIQUE(session_id,idem));
    CREATE TABLE IF NOT EXISTS managed_runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command_id TEXT NOT NULL,
      scope TEXT NOT NULL, config TEXT NOT NULL, build_id TEXT NOT NULL, native_cursor INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS managed_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      event_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,seq));`);
      db.prepare('INSERT OR IGNORE INTO managed_binding VALUES (1,?)').run(canonical(bindingTarget));
      invariant(db.prepare('SELECT data FROM managed_binding WHERE id=1').get().data === canonical(bindingTarget), 'NATIVE_KERNEL_TARGET_CHANGED');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }
  let runStore;
  try { runStore = new SqliteRunStore(join(directory, 'runs.sqlite')); }
  catch (error) { db.close(); throw error; }
  const lifetime = new AbortController(), active = new Map(), kernels = new Map(), failures = new Map(), wakeWaiters = new Set(), executing = new Set();
  let closed = false, closing, timer, retryTimer, generation = 0, schedulingEnabled = autoStart;
  const retryAfter = new Map();
  function guard() {
    invariant(!closed && !lifetime.signal.aborted && permitVerifier.verify === verifyPermit, 'NATIVE_KERNEL_AUTHORITY_LOST');
    const result = assertCurrent();
    if (result && typeof result.then === 'function') void Promise.resolve(result).catch(() => {});
    invariant(result === true, 'NATIVE_KERNEL_AUTHORITY_LOST'); return true;
  }
  const transaction = change => {
    guard(); db.exec('BEGIN IMMEDIATE');
    try { const result = change(); guard(); beforeCommit?.(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const runRow = id => db.prepare('SELECT * FROM managed_runs WHERE run_id=?').get(id);
  const commandRow = id => db.prepare('SELECT * FROM managed_commands WHERE command_id=?').get(id);
  const grants = createManagedNativeExecutionGrants({ db, guard, transaction, target: bindingTarget, clock, monotonic, hash, wake: schedule,
    readRun(id) {
      const row = runRow(id); if (!row) return null;
      try { return runStore.load(parseNativeJson(row.scope), id); }
      catch (error) { if (error.code === 'run_not_found') return null; throw error; }
    } });
  function append(sessionId, facts, command) {
    let seq = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM managed_events WHERE session_id=?').get(sessionId).seq;
    for (const fact of facts) {
      const existing = db.prepare('SELECT data FROM managed_events WHERE event_id=?').get(fact.event_id);
      if (existing) continue;
      const value = { schema_version: 1, session_id: sessionId, seq: ++seq, timestamp: new Date(clock()).toISOString(),
        causation_id: command.command_id, correlation_id: command.correlation_id ?? null, actor_ref: null, ...fact };
      if (value.family === 'runtime') {
        value.payload = { ...value.payload, event_id: value.event_id, seq: value.seq, timestamp: Date.parse(value.timestamp) / 1000,
          source: { framework: 'ksadk', native_event_id: value.event_id, native_run_id: value.run_id,
            metadata: { implementation: MANAGED_NATIVE_KERNEL_CONTRACT } } };
        value.actor_ref = 'ksadk';
      } else if (value.family === 'interaction') {
        value.payload = { schema_version: 1, event_type: value.event_type, tenant_id: command.tenant_id,
          agent_instance_id: command.agent_instance_id, session_id: sessionId, run_id: value.run_id,
          timestamp: value.timestamp, ...value.payload };
      }
      db.prepare('INSERT INTO managed_events VALUES (?,?,?,?)').run(sessionId, value.seq, value.event_id, canonical(value));
    }
  }
  function project(row) {
    guard();
    let record;
    try { record = runStore.load(parseNativeJson(row.scope), row.run_id); }
    catch (error) { if (error.code === 'run_not_found') return; throw error; }
    transaction(() => {
      const current = runRow(row.run_id), command = parseNativeJson(commandRow(row.command_id).data);
      for (const event of record.events.filter(event => event.seq > current.native_cursor)) {
        append(row.session_id, projectNativeKernelEvent(event, { scopeId: row.run_id, commandId: row.command_id }), command);
        db.prepare('UPDATE managed_runs SET native_cursor=? WHERE run_id=?').run(event.seq, row.run_id);
      }
      interactions.settle(row, record, command);
    });
  }
  const interactions = createManagedNativeInteractions({ db, guard, transaction, append, hash, clock, lifetime,
    lookup(query) {
      const inspected = inspectSession(query);
      invariant(inspected?.record, 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE');
      const source = query.sourceRunId === query.runId ? inspected.record
        : readChildRecord({ ...query, childRunId: query.sourceRunId });
      return { root: inspected.record, source, command: parseNativeJson(commandRow(inspected.commandId).data) };
    } });
  const scopedControls = createManagedNativeScopedControls({ db, guard, transaction, append, clock, lifetime, wake, control: scopedControl,
    lookup(sessionId, runId) {
      const run = runRow(runId);
      invariant(run && run.session_id === sessionId, 'NATIVE_MANAGED_SCOPE_NOT_FOUND');
      return inspectSession({ scope: parseNativeJson(run.scope), sessionId, runId });
    } });
  const scopedTimer = setInterval(() => {
    if (schedulingEnabled && !closed) try {
      scopedControls.drain();
      // Observe cross-connection grant changes without resolving bindings or
      // repeatedly trying a suspended FIFO head. No persisted expiry is an anchor.
      for (const sessionId of grants.readySessions()) if (!active.has(sessionId)
        && (!failures.has(sessionId) || failures.get(sessionId).startsWith('execution_grant_'))) schedule();
    } catch { /* A later trusted recovery retries the original durable delivery. */ }
  }, 100);
  scopedTimer.unref?.();
  function projectAll() { for (const row of db.prepare('SELECT * FROM managed_runs ORDER BY rowid').all()) project(row); }
  async function waitForCommand(version, snapshot, signal, changed) {
    const scoped = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    guard(); scoped.throwIfAborted(); if (generation !== version || changed?.()) return;
    await new Promise((resolve, reject) => {
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(scoped.reason); };
      const cleanup = () => { clearInterval(poll); wakeWaiters.delete(wake); scoped.removeEventListener('abort', abort); };
      // The HTTP receiver and Session owner may be different local processes.
      // A paused Run has no Native heartbeat, so observe its durable command
      // queue without executing effects or relying on an in-memory wakeup.
      const poll = setInterval(() => {
        try {
          guard(); const current = runStore.load(snapshot.scope, snapshot.runId);
          if (changed ? changed(current) : current.snapshot.revision !== snapshot.revision || current.commands.some(row => !row.consumed)) wake();
        } catch (error) { cleanup(); reject(error); }
      }, 100);
      wakeWaiters.add(wake); scoped.addEventListener('abort', abort, { once: true });
      if (scoped.aborted) abort(); else if (generation !== version) wake();
    });
  }
  function bindingRequest(command, run, stage) {
    return { command: copy(command), recovery: stage === 'execute', stage,
      runId: run?.run_id ?? managedNativeRunId(command), signal: lifetime.signal, store: runStore,
      admission: run ? { scope: parseNativeJson(run.scope), buildId: run.build_id,
        configuration: parseNativeJson(run.config) } : null };
  }
  function resolveOwnedBinding(request) {
    guard();
    // A binding lookup is Host-owned, never HTTP-owned. Retirement must stop
    // waiting even if a credential/resource provider ignores its signal. A
    // late resource cannot become execution authority and is released instead.
    return new Promise((resolve, reject) => {
      let settled = false;
      const stop = () => { settled = true; reject(lifetime.signal.reason ?? new Error('Native owner closed')); };
      lifetime.signal.addEventListener('abort', stop, { once: true });
      Promise.resolve().then(() => { guard(); return resolveBinding(request); }).then(binding => {
        if (settled) {
          void Promise.resolve().then(() => binding?.release?.({ scope: binding.scope === undefined ? undefined : copy(binding.scope), sessionId: request.command.session_id,
            runId: request.runId, stage: request.stage, signal: request.signal, reason: 'owner_retired' })).catch(() => {});
          return;
        }
        settled = true; lifetime.signal.removeEventListener('abort', stop); resolve(binding);
      }, error => {
        if (settled) return;
        settled = true; lifetime.signal.removeEventListener('abort', stop); reject(error);
      });
    });
  }
  const receipt = (row, command, duplicate = false) => ({ ...parseNativeJson(row.receipt), command_id: command.command_id,
    ...(duplicate ? { status: 'duplicate' } : {}) });
  async function authenticate(raw, permit, operation) {
    guard(); const request = copy(raw), authorization = await verifyPermit.call(permitVerifier, copy(permit), request, operation); guard();
    invariant(request.tenant_id === bindingTarget.tenantId && request.agent_instance_id === bindingTarget.agentInstanceId,
      'NATIVE_KERNEL_PERMIT_INVALID');
    return { request, authorization };
  }
  function existing(command, authorization) {
    const byId = commandRow(command.command_id), byKey = db.prepare('SELECT * FROM managed_commands WHERE session_id=? AND idem=?')
      .get(command.session_id, command.idempotency_key);
    if (byId && (byId.session_id !== command.session_id || byId.idem !== command.idempotency_key))
      return rejection(command, 'command_id_conflict');
    const row = byKey ?? byId;
    if (!row) return null;
    if (row.digest !== businessDigest(command) || row.subject !== authorization.subjectRef) return rejection(command, 'idempotency_conflict');
    return receipt(row, command, true);
  }
  function consumeNonce(authorization, command, write = true) {
    const prior = db.prepare('SELECT * FROM managed_nonces WHERE nonce=?').get(authorization.nonce);
    invariant(!prior || prior.command_id === command.command_id && prior.idem === command.idempotency_key, 'NATIVE_KERNEL_NONCE_REUSED');
    if (write) db.prepare('INSERT OR IGNORE INTO managed_nonces VALUES (?,?,?)').run(authorization.nonce, command.command_id, command.idempotency_key);
  }
  async function receive(raw, permit) {
    const attempt = copy(permit), command = commandView(raw), { authorization } = await authenticate(command, attempt, command.command_type);
    managedExecutionGrantId(command);
    const prior = transaction(() => {
      consumeNonce(authorization, command, false); const value = existing(command, authorization);
      if (value) consumeNonce(authorization, command); return value;
    });
    if (prior) {
      // A delivered control's duplicate is a read-only confirmation. Waking
      // the idle owner here would withdraw a later, unrelated consent wait.
      const queued = db.prepare('SELECT state FROM managed_commands WHERE session_id=? AND idem=?')
        .get(command.session_id, command.idempotency_key);
      if (prior.status === 'duplicate' && queued?.state === 'accepted') wake();
      return prior;
    }
    const scoped = command.command_type === 'interrupt' && command.payload.scope_id != null;
    if (!supported.has(command.command_type) || command.payload.scope_id != null && (!scoped || !scopedControls.supported)
      || command.command_type === 'resume' && (command.payload.target.kind !== 'run' || command.payload.input != null)
      || command.command_type === 'enqueue' && ['legacy_history', 'execution_policy_ref', 'teams_context_ref']
        .some(key => command.payload[key] != null)) return rejection(command, 'native_control_unsupported', 'unsupported');
    let binding, interactionDigest, managedInteraction, scopedTarget, admitted = false;
    try {
      if (scoped) {
        const selected = command.payload.run_id ?? db.prepare("SELECT r.run_id FROM managed_runs r JOIN managed_commands c ON r.command_id=c.command_id WHERE r.session_id=? AND c.state='accepted' ORDER BY r.rowid LIMIT 1")
          .get(command.session_id)?.run_id;
        try { scopedTarget = await scopedControls.prepare(command, selected); }
        catch (error) { if (['NATIVE_MANAGED_SCOPE_NOT_FOUND', 'NATIVE_MANAGED_SCOPE_UNAVAILABLE'].includes(error.code))
          return rejection(command, 'native_child_scope_not_found'); throw error; }
      }
      if (command.command_type === 'submit_interaction') {
        const row = runRow(command.payload.run_id);
        if (!row || row.session_id !== command.session_id) return rejection(command, 'native_run_not_found');
        let pending = interactions.pending(command);
        managedInteraction = pending;
        try { pending = runStore.load(parseNativeJson(row.scope), row.run_id).snapshot.pendingInteraction; }
        catch (error) { if (error.code !== 'run_not_found') throw error; }
        pending = managedInteraction ?? pending;
        if (!pending || typeof authorizeInteraction !== 'function') return rejection(command, 'native_interaction_authority_unavailable');
        const authorized = await authorizeInteraction({ command: copy(command), authorization, pending: copy(pending) }); guard();
        if (authorized !== true) return rejection(command, 'native_interaction_authority_invalid');
        interactionDigest = hash(pending);
      }
      if (command.command_type === 'enqueue') {
        const grantError = transaction(() => grants.commandError(command));
        if (grantError) return rejection(command, grantError);
        binding = await resolveOwnedBinding(bindingRequest(command, null, 'admit')); guard();
        check(object(binding) && object(binding.scope) && binding.scope.tenantId === command.tenant_id
          && binding.scope.agentId === command.agent_instance_id && text(binding.buildId) && object(binding.ports));
        binding = { ...binding, configuration: configure(binding.configuration) };
        check(Array.isArray(binding.configuration.inputMessages) && binding.configuration.inputMessages.length > 0);
      }
      // Binding/resource lookup may await network I/O. Expired or revoked Server
      // authority cannot enter the admission transaction after that delay.
      await authenticate(command, attempt, command.command_type);
      const accepted = transaction(() => {
        consumeNonce(authorization, command); const duplicate = existing(command, authorization); if (duplicate) return duplicate;
        let runId;
        if (binding) {
          const grantError = grants.commandError(command); if (grantError) return rejection(command, grantError);
          const count = db.prepare("SELECT COUNT(*) AS n FROM managed_commands WHERE session_id=? AND state='accepted'")
            .get(command.session_id).n;
          if (count >= queueLimit) return rejection(command, 'native_queue_full', 'queue_full');
          const previous = db.prepare('SELECT scope,build_id FROM managed_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(command.session_id);
          if (previous && (previous.scope !== canonical(binding.scope) || previous.build_id !== binding.buildId))
            return rejection(command, 'native_session_binding_changed');
          runId = managedNativeRunId(command);
          db.prepare('INSERT INTO managed_runs(run_id,session_id,command_id,scope,config,build_id) VALUES (?,?,?,?,?,?)')
            .run(runId, command.session_id, command.command_id, canonical(binding.scope), canonical(binding.configuration), binding.buildId);
        } else {
          runId = scopedTarget?.runId ?? (command.command_type === 'resume' ? command.payload.target.id : command.payload.run_id);
          if (!runId) runId = db.prepare('SELECT run_id FROM managed_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(command.session_id)?.run_id;
          const row = runId && runRow(runId);
          if (!row || row.session_id !== command.session_id) return rejection(command, 'native_run_not_found');
          try {
            if (terminal(runStore.load(parseNativeJson(row.scope), runId).snapshot.phase)) return rejection(command, 'native_run_terminal');
          } catch (error) { if (error.code !== 'run_not_found') throw error; }
          if (command.command_type === 'submit_interaction') {
            if (managedInteraction) {
              try { interactions.validate(command, managedInteraction); }
              catch (error) { if (['NATIVE_MANAGED_INTERACTION_CONFLICT', 'NATIVE_MANAGED_INTERACTION_UNAVAILABLE'].includes(error.code))
                return rejection(command, 'native_interaction_conflict'); throw error; }
            } else {
              const snapshot = runStore.load(parseNativeJson(row.scope), runId).snapshot, pending = snapshot.pendingInteraction;
              if (snapshot.phase !== 'awaiting_interaction' || !pending || hash(pending) !== interactionDigest || pending.interactionId !== command.payload.interaction_id
                || command.payload.expected_revision != null && command.payload.expected_revision !== 1
                || command.payload.action != null && command.payload.action !== 'submit'
                || !['approve', 'reject'].includes(command.payload.response)) return rejection(command, 'native_interaction_conflict');
            }
          }
        }
        const seq = db.prepare('SELECT COUNT(*) AS n FROM managed_commands WHERE session_id=?').get(command.session_id).n + 1;
        const result = { schema_version: 1, command_id: command.command_id, status: 'accepted', message_id: randomUUID(), run_id: runId, accepted_seq: seq };
        db.prepare('INSERT INTO managed_commands(command_id,session_id,idem,digest,subject,data,receipt) VALUES (?,?,?,?,?,?,?)')
          .run(command.command_id, command.session_id, command.idempotency_key, businessDigest(command), authorization.subjectRef, canonical(command), canonical(result));
        append(command.session_id, [{ event_id: nativeKernelFactId(command.command_id, 'admission'), family: 'control', family_version: 1,
          event_type: 'control.command_accepted', run_id: runId, payload: { command_id: command.command_id, message_id: result.message_id,
            accepted_seq: seq, status: 'accepted', command_type: command.command_type } }], command);
        if (managedInteraction) interactions.resolve(command, managedInteraction, authorization);
        if (scopedTarget) scopedControls.admit(command, scopedTarget, authorization);
        return result;
      });
      admitted = accepted.status === 'accepted';
      if (admitted) {
        applyControls(command.session_id); scopedControls.drain();
        // A scoped control owns an independent delivery queue. Do not retire
        // an unrelated pending question before cancellation is durable in its
        // original A2A journal; delivery wakes the original receipt waiter.
        if (!scopedTarget) wake();
      }
      return accepted;
    } finally { await binding?.release?.({ scope: binding.scope === undefined ? undefined : copy(binding.scope), sessionId: command.session_id,
      runId: managedNativeRunId(command), stage: 'admit', admitted, signal: lifetime.signal }); }
  }
  function nativeCommand(command) {
    const payload = command.payload;
    return { commandId: command.command_id, kind: ({ interrupt: 'cancel' })[command.command_type] ?? command.command_type,
      payload: command.command_type === 'steer' ? { text: payload.content }
        : command.command_type === 'submit_interaction' ? { interactionId: payload.interaction_id, decision: payload.response === 'approve' ? 'allow' : 'deny' } : {} };
  }
  function applyControls(sessionId) {
    guard();
    for (const row of db.prepare("SELECT * FROM managed_commands WHERE session_id=? AND state='accepted' ORDER BY rowid").all(sessionId)) {
      const command = parseNativeJson(row.data); if (command.command_type === 'enqueue') continue;
      invariant(command.payload.scope_id == null, 'NATIVE_MANAGED_SCOPE_DELIVERY_INVALID');
      if (command.command_type === 'submit_interaction' && interactions.owns(command)) {
        transaction(() => db.prepare("UPDATE managed_commands SET state='delivered' WHERE command_id=?").run(command.command_id));
        continue;
      }
      const id = parseNativeJson(row.receipt).run_id, run = runRow(id), scope = parseNativeJson(run.scope);
      try { runStore.load(scope, id); } catch (error) { if (error.code === 'run_not_found') continue; throw error; }
      // An interrupted process may stop after enqueue but before this ACK.
      // Native's durable command identity makes replay safe in that window.
      const kernel = kernels.get(id) ?? new NativeKernel({ store: runStore, ports: {}, owner, digest: hash });
      const delivered = kernel.submit(scope, id, nativeCommand(command));
      transaction(() => {
        if (delivered.status === 'rejected') append(sessionId, [{ event_id: nativeKernelFactId(command.command_id, 'delivery-rejected'),
          family: 'control', family_version: 1, event_type: 'control.command_rejected', run_id: id,
          payload: { command_id: command.command_id, reason: 'native_control_rejected' } }], command);
        db.prepare("UPDATE managed_commands SET state='delivered' WHERE command_id=?").run(command.command_id);
      });
    }
  }
  function portView(port, replacements) {
    const read = key => {
      if (Object.hasOwn(replacements, key)) return replacements[key];
      const value = Reflect.get(port, key, port);
      return typeof value === 'function' ? value.bind(port) : value;
    };
    // Proxy invariants forbid substituting a frozen target's own method or
    // tokens property. Use a separate facade while preserving the real method
    // receiver and its private state, including non-enumerable metadata.
    return new Proxy(Object.create(Object.getPrototypeOf(port)), {
      get: (_target, key) => read(key),
      has: (_target, key) => Object.hasOwn(replacements, key) || key in port,
      ownKeys: () => [...new Set([...Reflect.ownKeys(port), ...Reflect.ownKeys(replacements)])],
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(port, key);
        if (!descriptor && !Object.hasOwn(replacements, key)) return undefined;
        return { configurable: true, enumerable: descriptor?.enumerable ?? true, writable: false, value: read(key) };
      },
    });
  }
  function ownedPort(port, name) {
    if (!port?.[name]) return port;
    const method = port[name];
    const invoke = async (request, ...args) => {
      guard(); const signal = request.signal ? AbortSignal.any([request.signal, lifetime.signal]) : lifetime.signal;
      let onAbort;
      const stopped = new Promise((_, reject) => { onAbort = () => reject(signal.reason ?? new Error('Native owner closed'));
        signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); });
      try {
        const work = Promise.resolve().then(() => { guard(); return method.call(port, { ...request, signal }, ...args); });
        return await Promise.race([work, stopped]);
      } finally { signal.removeEventListener('abort', onAbort); }
    };
    return portView(port, { [name]: invoke });
  }
  async function drive(sessionId) {
    for (;;) {
      guard(); applyControls(sessionId);
      const row = db.prepare("SELECT * FROM managed_commands WHERE session_id=? AND state='accepted' ORDER BY rowid").all(sessionId)
        .find(row => parseNativeJson(row.data).command_type === 'enqueue');
      if (!row) return;
      const command = parseNativeJson(row.data), id = parseNativeJson(row.receipt).run_id, run = runRow(id), scope = parseNativeJson(run.scope);
      // Durable start qualification is serialized with revocation/admission.
      // It precedes even asynchronous execution resource lookup, and survives
      // a lost start ACK without changing the original Native Run identity.
      if (!grants.qualify(row)) continue;
      const resolved = await resolveOwnedBinding(bindingRequest(command, run, 'execute'));
      try {
        guard();
        invariant(hash(configure(resolved.configuration)) === hash(parseNativeJson(run.config))
          && canonical(resolved.scope) === run.scope && resolved.buildId === run.build_id, 'NATIVE_KERNEL_BINDING_CHANGED');
        const ports = { ...resolved.ports };
        for (const [port, methods] of Object.entries({ model: ['generate'], tools: ['execute', 'observeReceipt'], workspace: ['observe'],
          input: ['prepare'], context: ['readSource', 'prepare'], verification: ['verify'], hooks: ['invoke'],
          artifacts: ['write', 'read', 'search'], children: ['collect', 'reconcile', 'readyChildren', 'wakeControl', 'interruptedReceipts'],
          background: ['observe'], browser: ['recoverSessions'] })) {
          for (const method of methods) ports[port] = ownedPort(ports[port], method);
        }
        if (ports.context?.tokens) {
          const tokens = ownedPort(ownedPort(ports.context.tokens, 'countRequest'), 'countText');
          ports.context = portView(ports.context, { tokens });
        }
        let deliverCheckpoint, deliverStream;
        const kernel = new NativeKernel({ store: runStore, ports, owner, digest: hash,
          onStream: (identity, event, record) => { guard(); deliverStream?.(identity, event, record); },
          onCheckpoint: async snapshot => { guard(); await deliverCheckpoint?.(copy(snapshot));
            guard(); await beforeProjection?.(copy(snapshot)); guard(); project(run); } });
        kernels.set(id, kernel);
        try {
          let parentRunId;
          try { parentRunId = runStore.load(scope, id).snapshot.parentRunId; }
          catch (error) { if (error.code !== 'run_not_found') throw error;
            parentRunId = runStore.sessionHead(scope, sessionId)?.runId ?? null; }
          const identity = { scope, runId: id, sessionId, turnId: command.command_id, buildId: run.build_id,
            parentRunId, taskChainId: id };
          let executed = false, boundaryOpen = true, snapshot;
          const execute = async ({ signal, replayOnly = false, cancelOnly = false, onCheckpoint, onStream, onActive, onIdle } = {}) => {
            guard(); invariant(boundaryOpen && !executed, 'NATIVE_KERNEL_EXECUTION_REENTERED'); executed = true;
            invariant(!cancelOnly || signal?.aborted && !replayOnly, 'NATIVE_KERNEL_CANCEL_SIGNAL_REQUIRED');
            if (replayOnly) {
              snapshot = runStore.load(scope, id).snapshot;
              invariant(terminal(snapshot.phase), 'NATIVE_KERNEL_OWNER_TERMINAL_MISMATCH'); project(run); return copy(snapshot);
            }
            invariant(onCheckpoint === undefined || typeof onCheckpoint === 'function', 'NATIVE_KERNEL_EXECUTION_CALLBACK_INVALID');
            invariant(onStream === undefined || typeof onStream === 'function', 'NATIVE_KERNEL_EXECUTION_CALLBACK_INVALID');
            invariant(onActive === undefined || typeof onActive === 'function', 'NATIVE_KERNEL_EXECUTION_CALLBACK_INVALID');
            invariant(onIdle === undefined || typeof onIdle === 'function', 'NATIVE_KERNEL_EXECUTION_CALLBACK_INVALID');
            deliverCheckpoint = onCheckpoint;
            deliverStream = onStream;
            executing.add(id);
            kernel.start(identity, parseNativeJson(run.config));
            const cancel = () => {
              if (closed || lifetime.signal.aborted) return;
              kernel.submit(scope, id, { commandId: `${id}:host-session-cancel`, kind: 'cancel', payload: {} }); wake();
            };
            signal?.addEventListener('abort', cancel, { once: true });
            let releaseControls;
            try {
              if (signal?.aborted) cancel();
              releaseControls = onActive?.({ kernel, scope: copy(scope), sessionId, runId: id, wake });
              invariant(releaseControls === undefined || typeof releaseControls === 'function', 'NATIVE_KERNEL_EXECUTION_CALLBACK_INVALID');
              for (;;) {
                guard(); const version = generation; applyControls(sessionId);
                snapshot = await kernel.runUntilIdle(scope, id); guard(); project(run);
                if (terminal(snapshot.phase) || !resolved.withExecution) return copy(snapshot);
                if (onIdle && snapshot.phase === 'awaiting_reconciliation') {
                  const idle = new AbortController(), scoped = AbortSignal.any([lifetime.signal, idle.signal, ...(signal ? [signal] : [])]);
                  const fence = runStore.load(scope, id).fence;
                  const changed = (current = runStore.load(scope, id)) => generation !== version
                    || current.fence !== fence || current.snapshot.revision !== snapshot.revision
                    || current.commands.some(row => !row.consumed)
                    || Boolean(db.prepare("SELECT 1 FROM managed_commands WHERE session_id=? AND state='accepted' AND json_extract(data,'$.command_type')!='enqueue' AND json_extract(receipt,'$.run_id')=? LIMIT 1").get(sessionId, id));
                  try {
                    if (changed()) continue;
                    const waiting = waitForCommand(version, snapshot, idle.signal, changed);
                    const answer = Promise.resolve().then(() => { scoped.throwIfAborted();
                      return onIdle(copy(snapshot), { signal: scoped, assertCurrent() {
                        guard(); scoped.throwIfAborted(); invariant(!changed(), 'NATIVE_KERNEL_IDLE_AUTHORITY_LOST'); return true;
                      } }); }).then(command => ({ command }));
                    const result = await Promise.race([answer, waiting.then(() => ({ woken: true }))]);
                    guard();
                    if (result.woken || changed()) continue;
                    scoped.throwIfAborted();
                    if (result.command) {
                      // The Host may request the separately fenced read of this
                      // original receipt. It cannot approve or resume a Server
                      // interaction, create input, or re-run the original tool.
                      invariant(result.command.kind === 'reconcile_tool'
                        && result.command.payload?.originalOperationKey === snapshot.toolReconciliation?.operationKey,
                      'NATIVE_KERNEL_IDLE_COMMAND_INVALID');
                      const receipt = kernel.submit(scope, id, result.command);
                      invariant(receipt.status !== 'rejected', 'NATIVE_KERNEL_IDLE_COMMAND_INVALID');
                    } else await waiting;
                  } catch (error) { guard(); if (!changed()) throw error; }
                  finally { idle.abort(new Error('Native idle attempt retired')); }
                  continue;
                }
                // A whole-Session owner stays open through pause/approval.
                // Only this Native kernel consumes the durable next command.
                await waitForCommand(version, snapshot);
              }
            } finally { try { if (typeof releaseControls === 'function') releaseControls(); }
              finally { signal?.removeEventListener('abort', cancel); } }
          };
          invariant(resolved.withExecution === undefined || typeof resolved.withExecution === 'function', 'NATIVE_KERNEL_BINDING_CHANGED');
          if (resolved.withExecution) {
            let result;
            try { result = await resolved.withExecution({ identity: copy(identity), configuration: parseNativeJson(run.config),
              signal: lifetime.signal, execute }); }
            finally { boundaryOpen = false; }
            guard(); invariant(executed && snapshot && canonical(result) === canonical(snapshot), 'NATIVE_KERNEL_EXECUTION_RESULT_INVALID');
          } else await execute();
          failures.delete(sessionId);
          if (!terminal(snapshot.phase)) return;
          transaction(() => db.prepare("UPDATE managed_commands SET state='settled' WHERE command_id=?").run(row.command_id));
        } finally { executing.delete(id); if (kernels.get(id) === kernel) kernels.delete(id); }
      } finally { await resolved?.release?.({ scope: copy(scope), sessionId, runId: id, stage: 'execute', signal: lifetime.signal }); }
    }
  }
  function start(sessionId) {
    if (active.has(sessionId)) return active.get(sessionId);
    retryAfter.delete(sessionId);
    const startedGeneration = generation;
    const work = drive(sessionId).catch(error => {
      // Trusted Host diagnostics only. An observer cannot replace the error,
      // retry work, or authorize any Native effect by throwing/rejecting.
      try { Promise.resolve(onWorkerError?.({ sessionId, error })).catch(() => {}); } catch {}
      failures.set(sessionId, error.code?.startsWith('execution_grant_') ? error.code : ['NATIVE_KERNEL_BINDING_CHANGED', 'NATIVE_KERNEL_AUTHORITY_LOST', 'lease_busy', 'stale_fence'].includes(error.code)
        ? error.code : 'NATIVE_KERNEL_WORKER_FAILED');
      if (error.code === 'lease_busy' && schedulingEnabled && !closed) {
        // A cold Host can be ready before the killed process's durable lease
        // expires. Wait for that boundary; a status read or replacement user
        // command must not be needed to wake the original accepted command.
        let expiresAt = Date.now() + 1000;
        try {
          const row = db.prepare("SELECT r.* FROM managed_runs r JOIN managed_commands c ON r.command_id=c.command_id WHERE c.session_id=? AND c.state='accepted' ORDER BY c.rowid LIMIT 1").get(sessionId);
          if (row) expiresAt = runStore.load(parseNativeJson(row.scope), row.run_id).lease?.expiresAt ?? expiresAt;
        } catch { /* Keep bounded retry; original error remains authoritative. */ }
        retryAfter.set(sessionId, Date.now() + Math.max(50, Math.min(60000, expiresAt - Date.now() + 25)));
      }
      throw error;
    })
      .finally(() => { active.delete(sessionId); planRetry(); if (generation !== startedGeneration) schedule(); });
    active.set(sessionId, work); void work.catch(() => {}); return work;
  }
  function planRetry() {
    clearTimeout(retryTimer); retryTimer = undefined;
    if (!schedulingEnabled || closed || !retryAfter.size) return;
    let next = Infinity;
    for (const deadline of retryAfter.values()) next = Math.min(next, deadline);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed) return;
      try {
        guard();
        for (const [sessionId, deadline] of retryAfter) if (deadline <= Date.now()) {
          retryAfter.delete(sessionId); void start(sessionId).catch(() => {});
        }
        planRetry();
      } catch { /* Authority failure is visible through explicit status/drain. */ }
    }, Math.max(0, next - Date.now()));
  }
  function schedule() {
    if (!schedulingEnabled || closed || timer) return;
    timer = setTimeout(() => { timer = undefined; if (closed) return;
      try { guard(); for (const sessionId of grants.readySessions()) void start(sessionId).catch(() => {}); }
      catch { /* Explicit status/drain reports authority failure. */ }
    }, 0);
  }
  function wake() { generation++; for (const notify of [...wakeWaiters]) notify(); schedule(); }
  async function drain(sessionId) { guard(); scopedControls.drain(); return start(sessionId); }
  // Trusted Host-only reads. Unlike getStatus this does not project events or
  // consume a Server nonce, and it never starts an accepted command. The HTTP
  // transport deliberately does not expose this composition port.
  function inspectSession({ scope, sessionId, runId }) {
    guard(); scopeKey(scope);
    invariant(scope.tenantId === bindingTarget.tenantId && scope.agentId === bindingTarget.agentInstanceId
      && text(sessionId) && (runId === undefined || text(runId)), 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    const firstAccepted = db.prepare("SELECT r.* FROM managed_runs r JOIN managed_commands c ON r.command_id=c.command_id WHERE r.session_id=? AND c.state='accepted' ORDER BY r.rowid LIMIT 1").get(sessionId);
    const row = runId === undefined ? firstAccepted
      ?? db.prepare('SELECT * FROM managed_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId) : runRow(runId);
    if (!row) return null;
    invariant(row.session_id === sessionId && row.scope === canonical(scope), 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    const command = commandRow(row.command_id), configuration = parseNativeJson(row.config);
    invariant(command?.session_id === sessionId, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    let record = null;
    try { record = runStore.load(scope, row.run_id); }
    catch (error) { if (error.code !== 'run_not_found') throw error; }
    invariant(!record || record.snapshot.sessionId === sessionId && record.snapshot.runId === row.run_id
      && record.snapshot.turnId === row.command_id && record.snapshot.buildId === row.build_id
      && record.snapshot.configDigest === hash(configuration) && canonical(record.configuration) === row.config,
    'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    const phase = record?.snapshot.phase ?? 'admitted';
    return { contract: MANAGED_NATIVE_KERNEL_CONTRACT, scope: copy(scope), sessionId, runId: row.run_id,
      commandId: row.command_id, buildId: row.build_id, configDigest: hash(configuration),
      commandState: command.state, record, active: active.has(sessionId) && firstAccepted?.run_id === row.run_id,
      executing: executing.has(row.run_id),
      executionGrant: grants.inspect(command),
      workerError: failures.get(sessionId) ?? null,
      retryable: command.state === 'accepted' && firstAccepted?.run_id === row.run_id && !active.has(sessionId)
        && !grants.claimError(command)
        && (!record?.lease || record.lease.expiresAt <= clock())
        && !['paused', 'awaiting_interaction', 'awaiting_reconciliation', 'interrupted'].includes(phase) };
  }
  function retryAcceptedRun(query) {
    // Re-drive only the original durable admission. This cannot enqueue a
    // resume/approval/reconciliation command or override an unknown effect.
    invariant(text(query?.runId), 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    const view = inspectSession(query);
    invariant(view, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    if (view.commandState === 'settled' || view.active) return view;
    invariant(view.retryable, 'NATIVE_MANAGED_SERVER_CONTROL_REQUIRED');
    void start(query.sessionId).catch(() => {});
    return inspectSession(query);
  }
  function readChildHistory(query, { result = false, inventory = false, liveTasks } = {}) {
    const inspected = inspectSession(query);
    invariant(inspected, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    const history = createNativeChildHistory({ scope: inspected.scope, store: runStore, liveTasks });
    return history[inventory ? 'inventory' : result ? 'result' : 'list'](query);
  }
  function readChildRecord(query) {
    const inspected = inspectSession(query);
    invariant(inspected?.record, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
    const history = createNativeChildHistory({ scope: inspected.scope, store: runStore,
      liveTasks: id => {
        const kernel = kernels.get(id);
        return kernel && runStore.load(inspected.scope, id).configuration.childLifecyclePolicy === 'owned-background/v2'
          ? kernel.childTasks(inspected.scope, id) : [];
      } });
    return history.record({ ...query, runId: inspected.runId });
  }
  function facts(sessionId, after = 0) {
    guard(); invariant(text(sessionId) && Number.isSafeInteger(after) && after >= 0, 'NATIVE_KERNEL_CURSOR_INVALID');
    projectAll(); return db.prepare('SELECT data FROM managed_events WHERE session_id=? AND seq>? ORDER BY seq').all(sessionId, after)
      .map(row => parseNativeJson(row.data));
  }
  const events = Object.freeze({ async *subscribe(sessionId, after = 0, { signal } = {}) {
    let cursor = after;
    for (;;) {
      guard(); signal?.throwIfAborted();
      for (const fact of facts(sessionId, cursor)) { signal?.throwIfAborted(); guard(); cursor = fact.seq; yield fact; }
      await delay(20, undefined, { signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal });
    }
  } });
  try { guard(); projectAll(); wake(); }
  catch (error) { clearInterval(scopedTimer); runStore.close(); db.close(); throw error; }
  return Object.freeze({ contract: MANAGED_NATIVE_KERNEL_CONTRACT, receive, drain, events, inspectSession, retryAcceptedRun, readChildHistory, readChildRecord,
    executionGrants: grants.api,
    presentA2aInteraction: request => interactions.present(request),
    startRecovery() { guard(); schedulingEnabled = true; scopedControls.drain(); schedule(); },
    capabilities: Object.freeze({ storage: 'single-machine/sqlite/v1', commands: Object.freeze([...supported]),
      enqueueContentFormats: Object.freeze([...(resolveBinding.enqueueContentFormats ?? [])]),
      inject: false, scopedInterrupt: scopedControls.supported, resumeTargets: Object.freeze(['run']), structuredInput: typeof authorizeInteraction === 'function',
      approval: typeof authorizeInteraction === 'function', executionGrants: true, teamsContext: false, executionPolicy: false }),
    async getStatus(query, permit) {
      const { request } = await authenticate(query, permit, 'get_status');
      check(text(request.session_id)); projectAll();
      const rows = db.prepare('SELECT * FROM managed_runs WHERE session_id=? ORDER BY rowid').all(request.session_id);
      return { contract: MANAGED_NATIVE_KERNEL_CONTRACT, runs: rows.map(row => {
        let phase = commandRow(row.command_id).state === 'discarded' ? 'discarded' : 'pending';
        try { phase = runStore.load(parseNativeJson(row.scope), row.run_id).snapshot.phase; }
        catch (error) { if (error.code !== 'run_not_found') throw error; }
        return { runId: row.run_id, phase };
      }), workerError: failures.get(request.session_id) ?? null };
    },
    async subscribe(query, permit, options = {}) {
      const { request } = await authenticate(query, permit, 'subscribe_events');
      invariant(text(request.session_id) && Number.isSafeInteger(request.after_seq ?? 0) && (request.after_seq ?? 0) >= 0,
        'NATIVE_KERNEL_CURSOR_INVALID');
      return events.subscribe(request.session_id, request.after_seq ?? 0, options);
    },
    close() {
      if (closing) return closing;
      closed = true; clearTimeout(timer); clearTimeout(retryTimer); clearInterval(scopedTimer); retryAfter.clear(); lifetime.abort(new Error('Native owner closed'));
      closing = Promise.allSettled([...active.values(), scopedControls.close()]).then(() => { runStore.close(); db.close(); });
      return closing;
    },
  });
}
