// Host-owned durable background commands for the E2B sandbox backend (Node port).
//
// Reference: ksadk/sandbox/e2b_background.py @355059d. Mirrors the Node local-background
// contract (owner/scope/session/workspace isolation, UTF-8 byte cursors, terminal
// states, unknown+evidenceIncomplete) for a REMOTE sandbox whose command outlives
// any single client. A detached supervisor (a fork child, not a Python subprocess)
// holds a cross-process lock and appends output to host files; a new host process
// reads the same files and checks the lock for liveness.
//
// Production wires the installed E2B SDK via a strictly injected transport interface.
// The reference's unverified remote-replay promises
// are NOT claimed here: a reconnect gap is conservatively unknown+evidenceIncomplete.
//
// Authority is synchronous === true; cleanup awaits a resolved === true.
// No new launch/stop/model/ask on read. The started backend decides the backend.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { copy } from '@kingsoftcloud/agentkit-harness-core';
import { LOCAL_BACKGROUND_CONTRACT, TERMINAL, LocalCommandError, check, createPrivate,
  digest, lockUntil, privateDirectory, readAll, readWindow, syncDirectory,
  tryLock, unknownRecord, validId, writeRecord, delay, readE2BRecord, atomicPrivate } from './e2b-command-state.mjs';

export const E2B_BACKGROUND_CONTRACT = 'agentkit.e2b-background-command/v1';
export const RECOVERY_CLAIM_TTL_MS = 30000;
// Public deterministic locators let the Host persist a task before SDK entry.
export const e2bCommandOwner = (workspaceRoot, sessionId) => digest([realpathSync(workspaceRoot), 'e2b', sessionId]);
export function e2bCommandId(owner, operationKey) {
  check(typeof operationKey === 'string' && !!operationKey.trim(), 'invalid_background_operation_key');
  return digest([owner, operationKey]);
}
const supervisor = new URL('./e2b-background-supervisor.mjs', import.meta.url).href;
const validSandboxId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// A strict confirmed-true: the value must be exactly true, not a truthy Promise.
const isConfirmed = value => {
  if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
  return value === true;
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
};

const commandRequest = ({ command, cwd = null, env = null, timeoutSeconds }) => {
  check(typeof command === 'string' && !!command.trim(), 'invalid_background_command');
  check(cwd === null || typeof cwd === 'string', 'invalid_background_command');
  check(env === null || (typeof env === 'object' && !Array.isArray(env)
    && Object.entries(env).every(([k, v]) => typeof k === 'string' && typeof v === 'string')), 'invalid_background_command');
  check(Number.isSafeInteger(timeoutSeconds) && timeoutSeconds >= 0, 'invalid_background_command');
  return { command, cwd, env, timeoutSeconds };
};

/** One host-owned handle to a remote E2B background command. commandId is the only
 * identity exposed to the model/native layer; the remote pid stays internal. Output
 * is read from host files via UTF-8 cursors. Liveness is cross-process: the detached
 * supervisor holds supervisor.sqlite for its life. */
export class E2BBackgroundCommand {
  constructor(store, directory, { commandId }) {
    check(store instanceof E2BCommandStore, 'invalid_e2b_background_store');
    this._store = store; this.directory = directory; this.commandId = commandId;
    readE2BRecord(directory, store.owner, commandId); // Refuse a handle from another session/root.
    Object.freeze(this);
  }
  _record() { return readE2BRecord(this.directory, this._store.owner, this.commandId); }
  get timeoutSeconds() { return Math.floor(this._record().timeoutMs / 1000); }
  get processId() {
    const pid = this._record().supervisorPid;
    check(Number.isSafeInteger(pid) && pid > 0, 'background_supervisor_identity_unavailable');
    return pid; // Diagnostic locator only; never used to signal.
  }
  readOutput({ stdoutCursor = 0, stderrCursor = 0, maxBytes = 65536 } = {}) {
    check(Number.isSafeInteger(maxBytes) && maxBytes >= 4 && maxBytes <= 65536, 'invalid_background_output_window');
    // tryLock returns a release fn iff the lock was FREE (acquired) = no live
    // supervisor; null iff a live supervisor holds it. Probe and release immediately.
    const probe = tryLock(join(this.directory, 'supervisor.sqlite'));
    let record;
    try {
      record = this._record();
      if (probe && !TERMINAL.has(record.status)) {
        if (record.status !== 'starting' || record.supervisorPid !== undefined || Date.now() - record.createdAt > 5000)
          record = { ...record, status: 'unknown', exitCode: null, evidenceIncomplete: true, outcomeReason: 'supervisor_lost' };
      }
    } finally { if (probe) probe(); }
    const stdout = readWindow(join(this.directory, 'stdout'), stdoutCursor, maxBytes);
    const stderr = readWindow(join(this.directory, 'stderr'), stderrCursor, maxBytes);
    return { status: record.status, stdout: stdout.text, stderr: stderr.text,
      stdoutCursor: stdout.cursor, stderrCursor: stderr.cursor,
      exitCode: TERMINAL.has(record.status) ? record.exitCode : null,
      cancelRequested: existsSync(join(this.directory, 'cancel')),
      outputMayBeTruncated: stdout.hasMore || stderr.hasMore,
      evidenceIncomplete: record.evidenceIncomplete === true, observedExitCode: record.observedExitCode ?? null,
      outcomeReason: record.outcomeReason ?? '' };
  }
  requestCancel() {
    const output = this.readOutput();
    if (!TERMINAL.has(output.status)) createPrivate(join(this.directory, 'cancel'));
    return this.readOutput();
  }
  async wait({ timeoutMs } = {}) {
    const started = performance.now();
    let output;
    while (!TERMINAL.has((output = this.readOutput()).status)) {
      if (Number.isSafeInteger(timeoutMs) && performance.now() - started >= timeoutMs)
        throw new LocalCommandError('background_command_still_running');
      await delay(50);
    }
    check(output.status !== 'unknown', 'background_command_outcome_unknown');
    return { stdout: readAll(join(this.directory, 'stdout')), stderr: readAll(join(this.directory, 'stderr')),
      exitCode: output.exitCode };
  }
}

/** Host-owned command records for one session, backed by detached supervisors that
 * drive an injected remote transport. The frozen sandbox.json (sandboxId + owner)
 * is the authority for read/stop/recover; a foreign-owned sandbox is refused.
 *
 * Authority contract: `authority` is a STRICT synchronous predicate returning
 * exactly `true` (not a truthy Promise) to confirm authority over an existing
 * sandbox. `killSandbox` may be asynchronous; cleanup requires its resolved
 * value to equal `true`. `authority === null` means NO authority is proven:
 * recover/close refuse with zero side effects.
 *
 * `launchAuthorized` (default true) is the outer host's declaration that this store
 * may launch a first command (the first launch has no existing sandbox to prove
 * authority over; the outer host authorizes it). Without it, start() refuses. */
export class E2BCommandStore {
  constructor({ stateRoot, workspaceRoot, sessionId, transport = null, transportModule = null,
    transportConfig = null, authority = null, killSandbox = null, launchAuthorized = true,
    sandboxId = null }) {
    check(process.platform === 'darwin' || process.platform === 'linux', 'unsupported_e2b_background_platform');
    check(typeof stateRoot === 'string' && !!stateRoot && typeof workspaceRoot === 'string' && !!workspaceRoot
      && typeof sessionId === 'string' && !!sessionId.trim(), 'invalid_background_command_scope');
    check((transport && typeof transport.start === 'function' && typeof transport.reconnect === 'function'
      && typeof transport.kill === 'function') || typeof transportModule === 'string', 'invalid_e2b_background_transport');
    check(authority === null || typeof authority === 'function', 'invalid_e2b_background_authority');
    check(killSandbox === null || typeof killSandbox === 'function', 'invalid_e2b_background_kill_sandbox');
    check(sandboxId === null || validSandboxId(sandboxId), 'invalid_e2b_background_sandbox_id');
    check(typeof launchAuthorized === 'boolean', 'invalid_e2b_launch_authority');
    // Resolve stateRoot through the filesystem. The workspace-containment check
    // runs BEFORE any directory creation so a stateRoot inside the workspace is
    // rejected with zero side effects. resolve() does not follow symlinks;
    // privateDirectory validates ancestors (no symlink) and creates the root.
    const resolved = resolve(stateRoot === '~' ? homedir() : stateRoot.startsWith('~/') ? join(homedir(), stateRoot.slice(2)) : stateRoot);
    const workspace = realpathSync(workspaceRoot);
    // Pre-creation check on the resolved path: reject root === workspace or root
    // inside workspace (a stateRoot inside the workspace is never created).
    check(resolved !== workspace && !resolved.startsWith(workspace + '/'), 'background_state_inside_workspace');
    privateDirectory(dirname(resolved), false);
    privateDirectory(resolved, true); // create the root (0o700, no symlink ancestors)
    const root = realpathSync(resolved);
    // Post-creation realpath check: a symlink in the resolved path that landed
    // inside the workspace is still rejected.
    check(root !== workspace && !root.startsWith(workspace + '/'), 'background_state_inside_workspace');
    this.owner = e2bCommandOwner(workspace, sessionId);
    this.directory = join(root, 'commands', this.owner);
    this._sandboxRoot = join(root, 'sandboxes', this.owner);
    this.sessionId = sessionId;
    this._transport = transport; this._transportModule = transportModule; this._transportConfig = freeze(copy(transportConfig));
    this._authority = authority; this._killSandbox = killSandbox;
    this._launchAuthorized = !!launchAuthorized;
    this._boundSandboxId = sandboxId; // proven by owner.ensure before store creation
    privateDirectory(this.directory, true); privateDirectory(this._sandboxRoot, true);
    if (sandboxId !== null) {
      const release = tryLock(join(this._sandboxRoot, 'binding.sqlite'));
      check(release, 'e2b_background_binding_busy');
      try {
        if (this._hasSandboxState()) {
          const frozen = this._frozenSandbox();
          check(frozen?.owner === this.owner && frozen.sandboxId === sandboxId, 'e2b_background_binding_changed');
        } else {
          atomicPrivate(this._sandboxFile(), JSON.stringify({ sandboxId, owner: this.owner, createdAt: Date.now() }) + '\n');
        }
      } finally { release(); }
    }
    Object.freeze(this);
  }
  commandId(operationKey) {
    return e2bCommandId(this.owner, operationKey);
  }
  connect(commandId) {
    check(validId(commandId), 'invalid_background_command_identity');
    const directory = join(this.directory, commandId);
    check(existsSync(join(directory, 'record.json')), 'background_command_not_owned');
    return new E2BBackgroundCommand(this, directory, { commandId });
  }
  _sandboxFile() { return join(this._sandboxRoot, 'sandbox.json'); }
  _hasSandboxState() { return existsSync(this._sandboxFile()); }
  _frozenSandbox() {
    if (!this._hasSandboxState()) return null;
    try { const record = JSON.parse(readAll(this._sandboxFile())); return record && typeof record === 'object' ? record : null; }
    catch { return null; }
  }
  _authorityProven() {
    // The frozen sandbox.json owner must match this session's owner key, AND a
    // host-supplied authority predicate must return EXACTLY true (strict, not a
    // truthy Promise). authority === null → not proven → refuse. This is the gate
    // for operations that TOUCH an existing sandbox (recover/close).
    const frozen = this._frozenSandbox();
    if (frozen === null) return false;
    if (frozen.owner !== this.owner || !validSandboxId(frozen.sandboxId)
      || this._boundSandboxId !== null && frozen.sandboxId !== this._boundSandboxId) return false;
    const sealed = digest(frozen);
    try {
      return this._authority !== null && isConfirmed(this._authority(frozen))
        && digest(frozen) === sealed && digest(this._frozenSandbox()) === sealed;
    } catch { return false; }
  }
  _assertAuthority() {
    // A genuine first launch (no sandbox.json) is allowed only if the outer host
    // declared launchAuthorized (the first launch has no existing sandbox to prove
    // authority over). An existing sandbox requires proven authority.
    if (!this._hasSandboxState()) {
      check(this._launchAuthorized, 'e2b_background_launch_not_authorized');
      return;
    }
    check(this._authorityProven(), 'e2b_background_authority_unprovable');
  }
  recordSandboxIdForTask(taskId) {
    if (!validId(taskId)) return null;
    const directory = join(this.directory, taskId);
    if (!existsSync(join(directory, 'record.json'))) return null;
    try { const rec = readE2BRecord(directory, this.owner, taskId); return rec.sandboxId && validSandboxId(rec.sandboxId) ? rec.sandboxId : null; }
    catch { return null; }
  }
  connectOrRecover(commandId) {
    const handle = this.connect(commandId);
    const record = handle._record();
    if (TERMINAL.has(record.status)) return handle; // terminal → no authority needed
    if (!record.pid || !record.sandboxId) return handle;
    this._assertAuthority(); // recovery touches an existing sandbox
    // tryLock: release fn = free (supervisor dead) → recover; null = held (alive).
    const probe = tryLock(join(handle.directory, 'supervisor.sqlite'));
    if (probe) { probe(); return this.recover(commandId); }
    return handle; // supervisor alive
  }
  async start({ operationKey = randomUUID(), assertCurrent = () => true, ...input }) {
    check(typeof assertCurrent === 'function', 'e2b_background_guard_invalid');
    const request = commandRequest(input), commandId = this.commandId(operationKey), requestDigest = digest(request);
    const release = await lockUntil(join(this.directory, 'launch.sqlite'), performance.now() + 5000);
    try {
      check(isConfirmed(assertCurrent()), 'e2b_background_authority_lost');
      this._assertAuthority();
      const directory = join(this.directory, commandId);
      if (existsSync(directory)) {
        const handle = this.connect(commandId);
        check(readE2BRecord(directory, this.owner, commandId).requestDigest === requestDigest, 'background_operation_arguments_changed');
        return handle; // An existing/unknown operation is never launched again.
      }
      const record = { schemaVersion: LOCAL_BACKGROUND_CONTRACT, owner: this.owner, commandId, requestDigest,
        status: 'starting', createdAt: Date.now(), timeoutMs: request.timeoutSeconds * 1000, exitCode: null,
        backend: 'e2b', generation: 0 };
      const preparing = join(this.directory, `.preparing-${randomUUID()}`);
      try {
        privateDirectory(preparing, true);
        for (const file of ['stdout', 'stderr', 'supervisor.sqlite']) createPrivate(join(preparing, file));
        writeRecord(preparing, record);
        renameSync(preparing, directory); syncDirectory(dirname(directory));
      } finally { if (existsSync(preparing)) rmSync(preparing, { recursive: true, force: true }); }
      const handle = this.connect(commandId);
      check(isConfirmed(assertCurrent()), 'e2b_background_authority_lost');
      this._spawnSupervisor(handle, { mode: 'start', generation: 0, request });
      return handle;
    } finally { release(); }
  }
  async recover(commandId) {
    const handle = this.connect(commandId);
    let record = handle._record();
    if (TERMINAL.has(record.status)) return handle;
    if (!record.pid || !record.sandboxId) return handle; // Cannot reconnect without a remote identity.
    check(this._authorityProven(), 'e2b_background_authority_unprovable');
    const release = await lockUntil(join(handle.directory, 'recover.sqlite'), performance.now() + 5000);
    try {
      record = handle._record();
      if (TERMINAL.has(record.status)) return handle;
      const probe = tryLock(join(handle.directory, 'supervisor.sqlite'));
      if (probe) probe();
      else return handle; // live supervisor owns it; nothing to recover.
      const claimedGen = record.recoveryClaimGeneration;
      if (Number.isSafeInteger(claimedGen)) {
        const claimAge = Date.now() - (record.recoveryClaimAt ?? 0);
        if (claimAge < RECOVERY_CLAIM_TTL_MS) return handle; // durable claim prevents a second spawn
        record.staleClaimFloor = claimedGen;
        delete record.recoveryClaimGeneration; delete record.recoveryClaimAt;
      }
      const priorGen = record.generation ?? 0, priorClaim = record.recoveryClaimGeneration ?? 0, staleFloor = record.staleClaimFloor ?? 0;
      const generation = Math.max(priorGen, priorClaim, staleFloor) + 1;
      record.recoveryClaimGeneration = generation; record.recoveryClaimAt = Date.now();
      delete record.staleClaimFloor;
      writeRecord(handle.directory, record);
      this._spawnSupervisor(handle, { mode: 'reconnect', generation, request: null });
      return handle;
    } finally { release(); }
  }
  _spawnSupervisor(handle, { mode, generation, request }) {
    // The frozen sandboxId: prefer the proven bound sandboxId from owner.ensure
    // (set at store construction); fall back to sandbox.json if it exists. This
    // ensures the first launch (no sandbox.json yet) still passes a trusted
    // sandboxId to transport.start — the real SDK forbids a null sandboxId.
    const frozen = this._frozenSandbox();
    const fromJson = frozen && frozen.owner === this.owner && validSandboxId(frozen.sandboxId) ? frozen.sandboxId : null;
    const frozenSandboxId = this._boundSandboxId ?? fromJson;
    const config = { mode, directory: handle.directory, sandboxRoot: this._sandboxRoot, owner: this.owner,
      commandId: handle.commandId, generation, request, frozenSandboxId,
      transportModule: this._transportModule, transportConfig: this._transportConfig };
    // In-process transport (tests): run the supervisor directly with the injected
    // transport, so a closure-based fake transport works. Production uses the
    // detached child with a transportModule the child imports.
    if (this._transport) {
      config.transport = this._transport;
      import('./e2b-background-supervisor.mjs').then(({ supervise }) =>
        supervise(config, this._transport).catch(() => {
          // Generation-fenced fallback: only settle unknown if this supervisor is
          // still current. A newer reclaim or terminal must not be clobbered.
          try {
            const dir = handle.directory, owner = this.owner, cid = handle.commandId, gen = config.generation ?? 0;
            const rec = readE2BRecord(dir, owner, cid);
            if (!['completed', 'failed', 'canceled', 'timed_out', 'output_limit', 'unknown'].includes(rec.status)
              && (rec.generation ?? 0) <= gen
              && !(Number.isSafeInteger(rec.recoveryClaimGeneration) && rec.recoveryClaimGeneration > gen))
              unknownRecord(dir, rec, 'supervisor_in_process_failed');
          } catch {}
        }));
      return;
    }
    let child;
    try {
      child = spawn(process.execPath, ['--input-type=module', '-e',
        `import(${JSON.stringify(supervisor)}).then(m => m.runSupervisor()).catch(() => process.exit(1))`],
        { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    } catch { unknownRecord(handle.directory, handle._record(), 'supervisor_launch_failed'); return; }
    child.once('error', () => { const probe = tryLock(join(handle.directory, 'supervisor.sqlite'));
      try { if (probe) { probe(); const current = handle._record(); if (current.status === 'starting') unknownRecord(handle.directory, current, 'supervisor_launch_failed'); } }
      catch {} finally { /* probe already released if acquired */ } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(config)); child.unref();
  }
  async close() {
    // Kill the persistent sandbox. ASYNC contract: killSandbox may be sync or
    // async (returning a Promise<boolean>); close() awaits it and checks the
    // RESOLVED value === true. A Promise itself (truthy) is never accepted — it
    // must resolve to exactly true. authority remains a strict synchronous ===true
    // predicate. Zero side effects without proven authority.
    if (this._killSandbox === null) return false;
    const frozen = this._frozenSandbox();
    if (!frozen || frozen.owner !== this.owner || !validSandboxId(frozen.sandboxId)) return false;
    const sealed = digest(frozen);
    if (!this._authorityProven() || digest(this._frozenSandbox()) !== sealed) return false;
    try { return await Promise.resolve(this._killSandbox(frozen.sandboxId)) === true; }
    catch { return false; }
  }
}

/** Reader for createBackgroundCommandPort's canonical, owned launch receipts.
 * No launch/cancel/record transition; never selects a backend from the environment. */
export function createE2BBackgroundReader(store) {
  check(store instanceof E2BCommandStore, 'invalid_e2b_background_store');
  return Object.freeze(async request => {
    request.signal.throwIfAborted();
    check(request.sessionId === store.sessionId, 'background_reader_owner_mismatch');
    check(request.ref?.taskId === store.commandId(request.ref?.operationKey), 'background_reader_operation_mismatch');
    check(request.waitSeconds === 0, 'background_observation_must_not_wait');
    const result = store.connect(request.ref.taskId).readOutput({ stdoutCursor: request.stdoutCursor,
      stderrCursor: request.stderrCursor, maxBytes: request.maxBytes });
    request.signal.throwIfAborted(); return result;
  });
}
