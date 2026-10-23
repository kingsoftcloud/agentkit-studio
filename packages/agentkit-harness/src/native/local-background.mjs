// Lifecycle substrate for Host-authorized commands, independent of disposable
// tool workers. Command/workspace policy and tool approvals are caller duties.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fsyncSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localControlSettings, resolveLocalProcessLauncher } from './local-process.mjs';
import { LOCAL_BACKGROUND_CONTRACT, START_GRACE_MS, TERMINAL, LocalCommandError,
  check, createPrivate, delay, digest, lockUntil, openPrivate, privateDirectory, privateFile,
  readAll, readRecord, readWindow, syncDirectory, tryLock, unknownRecord, validId, writeRecord } from './local-command-state.mjs';

export { LOCAL_BACKGROUND_CONTRACT, LocalCommandError };
const supervisor = fileURLToPath(new URL('./local-background-supervisor.mjs', import.meta.url));
const inside = (path, root) => path === root || path.startsWith(root + sep);
const workerEnvironment = Object.freeze({ PATH: '/bin:/usr/bin', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1' });
const deadline = () => performance.now() + START_GRACE_MS;

export function commandRequest({ command, cwd, env, timeoutMs, settings = {} }) {
  settings = localControlSettings(settings);
  check(typeof command === 'string' && command.length > 0 && !command.includes('\0')
    && typeof cwd === 'string' && cwd.length > 0 && !cwd.includes('\0'), 'invalid_background_command');
  check(env && typeof env === 'object' && !Array.isArray(env) && Object.entries(env).every(([name, value]) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === 'string' && !value.includes('\0')), 'invalid_background_command_environment');
  timeoutMs ??= settings.wallSeconds * 1000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'invalid_background_command_timeout');
  const request = { command, cwd: resolve(cwd), env: Object.fromEntries(Object.entries(env)), timeoutMs, settings };
  check(Buffer.byteLength(JSON.stringify(request)) <= 1024 * 1024, 'background_command_request_too_large');
  return request;
}

export class LocalBackgroundCommand {
  constructor(directory, owner, commandId) {
    this.directory = directory; this.owner = owner; this.commandId = commandId;
    readRecord(directory, owner, commandId); Object.freeze(this);
  }
  get processId() {
    const record = readRecord(this.directory, this.owner, this.commandId);
    check(Number.isSafeInteger(record.supervisorPid) && record.supervisorPid > 0, 'background_supervisor_identity_unavailable');
    return record.supervisorPid; // Diagnostic locator only. Never used to cancel.
  }
  readOutput({ stdoutCursor = 0, stderrCursor = 0, maxBytes = 65536 } = {}) {
    check(Number.isSafeInteger(maxBytes) && maxBytes >= 4 && maxBytes <= 65536, 'invalid_background_output_window');
    privateDirectory(this.directory);
    const release = tryLock(join(this.directory, 'supervisor.sqlite'));
    let record;
    try {
      // Read the record while the ownership probe is held, so a final commit
      // cannot be mistaken for a lost supervisor using an older snapshot.
      record = readRecord(this.directory, this.owner, this.commandId);
      if (release && !TERMINAL.has(record.status)
        && (record.status !== 'starting' || Date.now() - record.createdAt >= START_GRACE_MS))
        record = { ...record, status: 'unknown', exitCode: null, evidenceIncomplete: true, outcomeReason: 'supervisor_lost' };
    } finally { release?.(); }
    const stdout = readWindow(join(this.directory, 'stdout'), stdoutCursor, maxBytes);
    const stderr = readWindow(join(this.directory, 'stderr'), stderrCursor, maxBytes);
    return { status: record.status, stdout: stdout.text, stderr: stderr.text,
      stdoutCursor: stdout.cursor, stderrCursor: stderr.cursor, exitCode: TERMINAL.has(record.status) ? record.exitCode : null,
      cancelRequested: privateFile(join(this.directory, 'cancel'), true) !== null,
      outputMayBeTruncated: record.outputLimitExceeded === true || stdout.hasMore || stderr.hasMore,
      evidenceIncomplete: record.evidenceIncomplete === true, observedExitCode: record.observedExitCode ?? null,
      outcomeReason: record.outcomeReason ?? '' };
  }
  requestCancel() {
    if (!TERMINAL.has(this.readOutput().status)) {
      const fd = openPrivate(join(this.directory, 'cancel'), constants.O_WRONLY | constants.O_CREAT);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(this.directory);
    }
    return this.readOutput();
  }
  async wait({ timeoutMs = null, signal } = {}) {
    check(timeoutMs === null || Number.isFinite(timeoutMs) && timeoutMs >= 0, 'invalid_background_wait_timeout');
    const until = timeoutMs === null ? Infinity : performance.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted(); const output = this.readOutput();
      if (TERMINAL.has(output.status)) {
        check(output.status !== 'unknown', 'background_command_outcome_unknown');
        const stdout = readAll(join(this.directory, 'stdout')), stderr = readAll(join(this.directory, 'stderr'));
        const record = readRecord(this.directory, this.owner, this.commandId);
        return { ...output, stdout, stderr, stdoutCursor: Buffer.byteLength(stdout), stderrCursor: Buffer.byteLength(stderr),
          outputMayBeTruncated: record.outputLimitExceeded === true };
      }
      check(performance.now() < until, 'background_command_still_running'); await delay(20);
    }
  }
  async kill() {
    this.requestCancel();
    try { return (await this.wait({ timeoutMs: 3000 })).status === 'canceled'; }
    catch (error) { if (error instanceof LocalCommandError) return false; throw error; }
  }
}

export class LocalCommandStore {
  constructor({ stateRoot, workspaceRoot, sessionId }) {
    check(process.platform === 'darwin' || process.platform === 'linux', 'unsupported_local_background_platform');
    check(typeof stateRoot === 'string' && !!stateRoot && typeof workspaceRoot === 'string' && !!workspaceRoot
      && typeof sessionId === 'string' && !!sessionId.trim(), 'invalid_background_command_scope');
    const root = resolve(stateRoot === '~' ? homedir() : stateRoot.startsWith('~/') ? join(homedir(), stateRoot.slice(2)) : stateRoot);
    const workspace = realpathSync(workspaceRoot);
    check(!inside(root, workspace), 'background_state_inside_workspace');
    privateDirectory(root, true); privateDirectory(join(root, 'commands'), true);
    this.owner = digest([workspace, 'local_process', sessionId]); this.directory = join(root, 'commands', this.owner); this.sessionId = sessionId;
    privateDirectory(this.directory, true); Object.freeze(this);
  }
  commandId(operationKey) {
    check(typeof operationKey === 'string' && !!operationKey.trim(), 'invalid_background_operation_key');
    // The format is private/versioned; no historical Python data is imported.
    return digest([this.owner, operationKey]);
  }
  connect(commandId) {
    check(validId(commandId), 'invalid_background_command_identity');
    return new LocalBackgroundCommand(join(this.directory, commandId), this.owner, commandId);
  }
  async start({ operationKey = randomUUID(), assertCurrent = () => true, ...input }) {
    check(typeof assertCurrent === 'function', 'background_command_guard_invalid');
    const guard = () => {
      const allowed = assertCurrent();
      if (allowed && typeof allowed.then === 'function') Promise.resolve(allowed).catch(() => {});
      check(allowed === true, 'background_command_authority_lost');
    };
    const request = commandRequest(input), commandId = this.commandId(operationKey), requestDigest = digest(request);
    const release = await lockUntil(join(this.directory, 'launch.sqlite'), deadline());
    let handle;
    try {
      guard();
      const directory = join(this.directory, commandId);
      if (existsSync(directory)) {
        handle = this.connect(commandId);
        check(readRecord(directory, this.owner, commandId).requestDigest === requestDigest, 'background_operation_arguments_changed');
        return handle; // An existing/unknown operation is never launched again.
      }
      resolveLocalProcessLauncher(); // New effects require a verified launcher.
      const record = { schemaVersion: LOCAL_BACKGROUND_CONTRACT, owner: this.owner, commandId, requestDigest,
        status: 'starting', createdAt: Date.now(), timeoutMs: request.timeoutMs, exitCode: null };
      // A killed preparer may leave a private temporary directory, but cannot
      // expose a half-created command handle. Only the complete, durable
      // directory is published; there is no spawn before this publication.
      const preparing = join(this.directory, `.preparing-${randomUUID()}`);
      try {
        privateDirectory(preparing, true);
        for (const file of ['stdout', 'stderr', 'supervisor.sqlite']) createPrivate(join(preparing, file));
        writeRecord(preparing, record);
        renameSync(preparing, directory); syncDirectory(dirname(directory));
      } finally { if (existsSync(preparing)) rmSync(preparing, { recursive: true, force: true }); }
      // Intent is durable BEFORE the first spawn.
      handle = this.connect(commandId);
      guard();
      let child;
      try {
        child = spawn(process.execPath, [supervisor, directory, this.owner, commandId], {
          detached: true, cwd: directory, env: workerEnvironment, stdio: ['pipe', 'ignore', 'ignore'],
        });
      } catch {
        unknownRecord(directory, record, 'supervisor_launch_failed'); return handle;
      }
      child.once('error', () => {
        // A spawn error proves no child was created; a pipe failure does not.
        let unlock;
        try {
          unlock = tryLock(join(directory, 'supervisor.sqlite'));
          const current = readRecord(directory, this.owner, commandId);
          if (unlock && current.status === 'starting') unknownRecord(directory, current, 'supervisor_launch_failed');
        } catch { /* existing durable intent remains recoverably unknown */ }
        finally { unlock?.(); }
      });
      child.stdin.on('error', () => { /* return the stable locator; never retry */ });
      // Secrets travel only through the private stdin pipe, never argv/record.
      child.stdin.end(JSON.stringify(request)); child.unref();
    } finally { release(); }
    const until = performance.now() + START_GRACE_MS;
    while (readRecord(handle.directory, this.owner, commandId).status === 'starting' && performance.now() < until) await delay(20);
    return handle;
  }
}

/** Reader for createBackgroundCommandPort's canonical, owned launch receipts.
 * This performs no launch/cancel/record transition and never selects a backend
 * from the environment. A missing supervisor is a derived unknown outcome.
 */
export function createLocalBackgroundReader(store) {
  check(store instanceof LocalCommandStore, 'invalid_local_background_store');
  return Object.freeze(async request => {
    request.signal.throwIfAborted();
    check(request.sessionId === store.sessionId && request.ref
      && request.ref.taskId === store.commandId(request.ref.operationKey), 'background_reader_owner_mismatch');
    check(request.waitSeconds === 0, 'background_observation_must_not_wait');
    const result = store.connect(request.ref.taskId).readOutput({ stdoutCursor: request.stdoutCursor,
      stderrCursor: request.stderrCursor, maxBytes: request.maxBytes });
    request.signal.throwIfAborted(); return result;
  });
}
