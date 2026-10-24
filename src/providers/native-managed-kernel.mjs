/** Durable Server command receiver over the existing TypeScript NativeKernel.
 * No DSH loop, local permit issuer or Python process is involved. Local SQLite
 * is a single-machine store, not evidence of a shared hosted SQL deployment. */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeKernel, canonical, configure, copy, invariant, parseNativeJson, terminal } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { privateDirectory, privateFile, createPrivate } from '../../packages/agentkit-harness/src/native/local-command-state.mjs';
import { nativeKernelFactId, projectNativeKernelEvent } from './native-kernel-events.mjs';

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

export function createManagedNativeKernel({ directory, target, permitVerifier, resolveBinding, authorizeInteraction, assertCurrent,
  queueLimit = 100, clock = Date.now, autoStart = true, beforeCommit, beforeProjection } = {}) {
  invariant(text(directory) && object(target) && text(target.tenantId) && text(target.agentInstanceId)
    && typeof permitVerifier?.verify === 'function' && typeof resolveBinding === 'function' && typeof assertCurrent === 'function'
    && Number.isSafeInteger(queueLimit) && queueLimit > 0, 'NATIVE_KERNEL_CONFIGURATION_INVALID');
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
  const lifetime = new AbortController(), active = new Map(), kernels = new Map(), failures = new Map();
  let closed = false, closing, timer, generation = 0;
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
    });
  }
  function projectAll() { for (const row of db.prepare('SELECT * FROM managed_runs ORDER BY rowid').all()) project(row); }
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
    const prior = transaction(() => {
      consumeNonce(authorization, command, false); const value = existing(command, authorization);
      if (value) consumeNonce(authorization, command); return value;
    });
    if (prior) { wake(); return prior; }
    if (!supported.has(command.command_type) || command.payload.scope_id != null
      || command.command_type === 'resume' && (command.payload.target.kind !== 'run' || command.payload.input != null)
      || command.command_type === 'enqueue' && ['legacy_history', 'execution_grant_id', 'execution_grant_attempt_epoch', 'execution_policy_ref', 'teams_context_ref']
        .some(key => command.payload[key] != null)) return rejection(command, 'native_control_unsupported', 'unsupported');
    let binding, interactionDigest;
    try {
      if (command.command_type === 'submit_interaction') {
        const row = runRow(command.payload.run_id);
        if (!row || row.session_id !== command.session_id) return rejection(command, 'native_run_not_found');
        let pending;
        try { pending = runStore.load(parseNativeJson(row.scope), row.run_id).snapshot.pendingInteraction; }
        catch (error) { if (error.code !== 'run_not_found') throw error; }
        if (!pending || typeof authorizeInteraction !== 'function') return rejection(command, 'native_interaction_authority_unavailable');
        const authorized = await authorizeInteraction({ command: copy(command), authorization, pending: copy(pending) }); guard();
        if (authorized !== true) return rejection(command, 'native_interaction_authority_invalid');
        interactionDigest = hash(pending);
      }
      if (command.command_type === 'enqueue') {
        binding = await resolveBinding({ command: copy(command), recovery: false }); guard();
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
          runId = command.command_type === 'resume' ? command.payload.target.id : command.payload.run_id;
          if (!runId) runId = db.prepare('SELECT run_id FROM managed_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(command.session_id)?.run_id;
          const row = runId && runRow(runId);
          if (!row || row.session_id !== command.session_id) return rejection(command, 'native_run_not_found');
          try {
            if (terminal(runStore.load(parseNativeJson(row.scope), runId).snapshot.phase)) return rejection(command, 'native_run_terminal');
          } catch (error) { if (error.code !== 'run_not_found') throw error; }
          if (command.command_type === 'submit_interaction') {
            const snapshot = runStore.load(parseNativeJson(row.scope), runId).snapshot, pending = snapshot.pendingInteraction;
            if (snapshot.phase !== 'awaiting_interaction' || !pending || hash(pending) !== interactionDigest || pending.interactionId !== command.payload.interaction_id
              || command.payload.expected_revision != null && command.payload.expected_revision !== 1
              || command.payload.action != null && command.payload.action !== 'submit'
              || !['approve', 'reject'].includes(command.payload.response)) return rejection(command, 'native_interaction_conflict');
          }
        }
        const seq = db.prepare('SELECT COUNT(*) AS n FROM managed_commands WHERE session_id=?').get(command.session_id).n + 1;
        const result = { schema_version: 1, command_id: command.command_id, status: 'accepted', message_id: randomUUID(), run_id: runId, accepted_seq: seq };
        db.prepare('INSERT INTO managed_commands(command_id,session_id,idem,digest,subject,data,receipt) VALUES (?,?,?,?,?,?,?)')
          .run(command.command_id, command.session_id, command.idempotency_key, businessDigest(command), authorization.subjectRef, canonical(command), canonical(result));
        append(command.session_id, [{ event_id: nativeKernelFactId(command.command_id, 'admission'), family: 'control', family_version: 1,
          event_type: 'control.command_accepted', payload: { command_id: command.command_id, message_id: result.message_id,
            accepted_seq: seq, status: 'accepted', command_type: command.command_type } }], command);
        return result;
      });
      if (accepted.status === 'accepted') applyControls(command.session_id);
      wake(); return accepted;
    } finally { await binding?.release?.(); }
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
    return new Proxy(port, { get(target, key) {
      if (key === name) return invoke;
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  async function drive(sessionId) {
    for (;;) {
      guard(); applyControls(sessionId);
      const row = db.prepare("SELECT * FROM managed_commands WHERE session_id=? AND state='accepted' ORDER BY rowid").all(sessionId)
        .find(row => parseNativeJson(row.data).command_type === 'enqueue');
      if (!row) return;
      const command = parseNativeJson(row.data), id = parseNativeJson(row.receipt).run_id, run = runRow(id), scope = parseNativeJson(run.scope);
      const resolved = await resolveBinding({ command: copy(command), recovery: true });
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
          ports.context = new Proxy(ports.context, { get(target, key) {
            if (key === 'tokens') return tokens;
            const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
          } });
        }
        const kernel = new NativeKernel({ store: runStore, ports, owner, digest: hash,
          onCheckpoint: async snapshot => { guard(); await beforeProjection?.(copy(snapshot)); guard(); project(run); } });
        kernels.set(id, kernel);
        try {
          kernel.start({ scope, runId: id, sessionId, turnId: command.command_id, buildId: run.build_id,
            parentRunId: null, taskChainId: id }, parseNativeJson(run.config));
          applyControls(sessionId);
          const snapshot = await kernel.runUntilIdle(scope, id); guard(); project(run);
          failures.delete(sessionId);
          if (!terminal(snapshot.phase)) return;
          transaction(() => db.prepare("UPDATE managed_commands SET state='settled' WHERE command_id=?").run(row.command_id));
        } finally { if (kernels.get(id) === kernel) kernels.delete(id); }
      } finally { await resolved?.release?.(); }
    }
  }
  function start(sessionId) {
    if (active.has(sessionId)) return active.get(sessionId);
    const startedGeneration = generation;
    const work = drive(sessionId).catch(error => {
      failures.set(sessionId, ['NATIVE_KERNEL_BINDING_CHANGED', 'NATIVE_KERNEL_AUTHORITY_LOST', 'lease_busy', 'stale_fence'].includes(error.code)
        ? error.code : 'NATIVE_KERNEL_WORKER_FAILED'); throw error;
    })
      .finally(() => { active.delete(sessionId); if (generation !== startedGeneration) schedule(); });
    active.set(sessionId, work); void work.catch(() => {}); return work;
  }
  function schedule() {
    if (!autoStart || closed || timer) return;
    timer = setTimeout(() => { timer = undefined; if (closed) return;
      try { guard(); for (const row of db.prepare("SELECT DISTINCT session_id FROM managed_commands WHERE state='accepted'").all()) void start(row.session_id).catch(() => {}); }
      catch { /* Explicit status/drain reports authority failure. */ }
    }, 0);
  }
  function wake() { generation++; schedule(); }
  async function drain(sessionId) { guard(); return start(sessionId); }
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
  catch (error) { runStore.close(); db.close(); throw error; }
  return Object.freeze({ contract: MANAGED_NATIVE_KERNEL_CONTRACT, receive, drain, events,
    capabilities: Object.freeze({ storage: 'single-machine/sqlite/v1', commands: Object.freeze([...supported]),
      inject: false, scopedInterrupt: false, resumeTargets: Object.freeze(['run']), structuredInput: false,
      approval: typeof authorizeInteraction === 'function', executionGrants: false }),
    async getStatus(query, permit) {
      const { request } = await authenticate(query, permit, 'get_status');
      check(text(request.session_id)); projectAll();
      const rows = db.prepare('SELECT * FROM managed_runs WHERE session_id=? ORDER BY rowid').all(request.session_id);
      return { contract: MANAGED_NATIVE_KERNEL_CONTRACT, runs: rows.map(row => {
        let phase = 'pending'; try { phase = runStore.load(parseNativeJson(row.scope), row.run_id).snapshot.phase; }
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
      closed = true; clearTimeout(timer); lifetime.abort(new Error('Native owner closed'));
      closing = Promise.allSettled([...active.values()]).then(() => { runStore.close(); db.close(); });
      return closing;
    },
  });
}
