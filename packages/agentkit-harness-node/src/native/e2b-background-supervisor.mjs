// Detached E2B background supervisor (Node fork child).
//
// Reference: ksadk/sandbox/e2b_background.py _run_supervisor/_supervise @355059d.
// Holds supervisor.sqlite for its life, drives the injected transport (async-
// capable: start/reconnect/kill may return Promises — all are awaited), appends
// output to host files, and settles a truthful terminal status.
//
// Transport handle contract: the handle from start/reconnect is an async iterator
// yielding { stdout?, stderr? }. The terminal result is `handle.result` — which
// may be a Promise that resolves to { exitCode: number | null }. The supervisor
// subscribes to it ONCE via a non-blocking .then() callback — it NEVER awaits the
// pending result in the watcher loop, so cancel/deadline remain responsive. If the
// result Promise never resolves, cancel/timeout still fire and the outcome is
// unknown. handle.disconnect() closes the stream without killing.
//
// Transport interface (mirrors the real E2B SDK @2.58.0 shape):
//   start(command, { cwd, env, timeout }) → { pid, handle, sandboxId }
//   reconnect(pid, { sandboxId, timeout }) → handle   (sandboxId pins the EXACT sandbox)
//   kill(pid, { sandboxId }) → boolean                  (sandboxId pins the kill target)
// The sandboxId from start() is frozen in the record and passed to reconnect/kill
// so two sandboxes sharing the same pid are never confused. The production adapter
// maps these to sandbox.commands.run/connect/kill on the Sandbox identified by
// sandboxId. The supervisor does NOT fabricate SDK access — the parent supplies the
// transport.
//
// All record writes re-read the current generation AND recoveryClaimGeneration:
// a stale supervisor (older generation, or a newer claim pending) cannot append
// output or write a terminal/unknown status. A reconnect never relaunches; the
// gap is unknown+evidenceIncomplete. Cancel/timeout issue a bounded kill only for
// the proven sandbox; an unconfirmed kill is unknown, never a fake cancel.
//
// No Python/uv/venv. The transport is an injected object (in-process) or a module
// URL the detached child imports (transportModule).
import { closeSync, constants, existsSync, fsyncSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL, check, openPrivate, atomicPrivate, readE2BRecord, tryLock, unknownRecord, writeRecord } from './e2b-command-state.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const validSandboxId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const appendOutput = (path, text) => {
  const fd = openPrivate(path, constants.O_WRONLY | constants.O_APPEND);
  try {
    const bytes = Buffer.from(text, 'utf8');
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      check(count > 0, 'e2b_output_write_stalled'); offset += count;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
};
const awaitMaybe = value => Promise.resolve(value);
// Bounded await: resolve with the value, or undefined if the deadline passes.
const awaitBounded = async (promise, ms) => {
  let timer;
  try { return await Promise.race([Promise.resolve(promise), new Promise(r => { timer = setTimeout(() => r(undefined), ms); })]); }
  finally { clearTimeout(timer); }
};

/** Run the supervisor: read config from stdin, resolve the transport, supervise. */
export async function runSupervisor() {
  let config;
  try { config = JSON.parse(await readStdin()); }
  catch { process.exit(2); }
  if (!config || typeof config !== 'object') process.exit(2);
  try {
    const transport = config.transport ?? await resolveTransport(config);
    await supervise(config, transport);
  } catch (error) {
    try { fenceUnknown(config, 'supervisor_crashed'); } catch {} process.exit(1);
  }
}

async function resolveTransport(config) {
  check(typeof config.transportModule === 'string', 'e2b_background_transport_missing');
  const module = await import(config.transportModule);
  const factory = module.factory ?? module.default;
  check(typeof factory === 'function', 'e2b_background_transport_factory_missing');
  return factory(config.transportConfig || {});
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

// Check if this supervisor still owns the record: the generation must match AND no
// newer recovery claim is pending. Returns true if the supervisor is still current.
function stillCurrent(directory, owner, commandId, generation) {
  const record = readE2BRecord(directory, owner, commandId);
  if (TERMINAL.has(record.status)) return false; // already settled by someone
  if ((record.generation ?? 0) > generation) return false; // a newer reclaim won
  const claimed = record.recoveryClaimGeneration;
  if (Number.isSafeInteger(claimed) && claimed > generation) return false; // a newer claim is pending
  if ((record.generation ?? 0) !== generation && claimed !== generation) return false;
  return true;
}

// Generation-fenced unknown: only settle unknown if this supervisor is still
// current (generation matches, no newer claim, not already terminal).
function fenceUnknown(config, reason) {
  if (stillCurrent(config.directory, config.owner, config.commandId, config.generation ?? 0))
    unknownRecord(config.directory, readE2BRecord(config.directory, config.owner, config.commandId), reason);
}

// Generation-fenced write: only write if this supervisor is still current. Never
// overwrites a terminal or a newer-generation record.
function fencedWrite(directory, owner, commandId, generation, patch) {
  if (!stillCurrent(directory, owner, commandId, generation)) return false;
  const record = readE2BRecord(directory, owner, commandId);
  writeRecord(directory, { ...record, ...patch });
  return true;
}

export async function supervise(config, transport) {
  const directory = config.directory, generation = config.generation ?? 0;
  const release = tryLock(join(directory, 'supervisor.sqlite'));
  if (!release) return; // a live supervisor holds the lock
  let settled = false, stream = null;
  // safeDisconnect is declared BEFORE the try block so the finally block can access it.
  // It references `stream` (set inside the try) via closure — the let is in scope.
  const safeDisconnect = async () => {
    try { await awaitBounded(stream?.disconnect?.(), 5000); } catch {}
  };
  try {
    let record = readE2BRecord(directory, config.owner, config.commandId);
    const mode = config.mode;
    if (TERMINAL.has(record.status)) return;
    const recordGen = record.generation ?? 0;
    if (mode === 'reconnect') {
      const claimed = record.recoveryClaimGeneration;
      if (Number.isSafeInteger(claimed) && claimed !== generation) return;
      else if (!Number.isSafeInteger(claimed) && recordGen > generation) return;
      if (!fencedWrite(directory, config.owner, config.commandId, generation,
        { generation, supervisorPid: process.pid, recoveryClaimGeneration: undefined, recoveryClaimAt: undefined })) return;
    } else {
      if (recordGen > generation) return;
      if (!fencedWrite(directory, config.owner, config.commandId, generation,
        { generation, supervisorPid: process.pid })) return;
    }
    record = readE2BRecord(directory, config.owner, config.commandId);
    const appendOnly = mode === 'reconnect';
    // append is generation-fenced: re-read the record before each append; reject if
    // terminal, a newer generation, or a newer claim exists. A stale owner's late
    // async events cannot append after a newer reclaim or a terminal settlement.
    const append = (path, text) => {
      if (settled) return;
      if (!stillCurrent(directory, config.owner, config.commandId, generation)) { settled = true; return; }
      appendOutput(path, text);
    };
    let pid, sandboxId;
    if (mode === 'start') {
      // Pass the frozen sandboxId so the transport reuses the existing sandbox
      // (one sandbox per session). If frozenSandboxId is set and the transport
      // returns a DIFFERENT sandboxId, the original ownership must not be
      // overwritten — the command outcome is unknown.
      const startOpts = { cwd: config.request.cwd, env: config.request.env,
        timeout: config.request.timeoutSeconds, sandboxId: config.frozenSandboxId };
      const started = await awaitBounded(transport.start(config.request.command, startOpts), 10000);
      if (!started || !Number.isSafeInteger(started.pid) || started.pid <= 0) {
        fencedWrite(directory, config.owner, config.commandId, generation,
          { status: 'unknown', exitCode: null, evidenceIncomplete: true, completedAt: Date.now(), outcomeReason: 'transport_start_failed' });
        return;
      }
      pid = started.pid; stream = started.handle; sandboxId = started.sandboxId;
      check(validSandboxId(sandboxId), 'e2b_background_no_sandbox_id');
      // If a frozen sandboxId exists and the transport returned a different one,
      // the command cannot be attributed to the original sandbox — settle unknown
      // and do NOT overwrite sandbox.json.
      if (config.frozenSandboxId && config.frozenSandboxId !== sandboxId) {
        fencedWrite(directory, config.owner, config.commandId, generation,
          { status: 'unknown', exitCode: null, evidenceIncomplete: true, completedAt: Date.now(),
            outcomeReason: 'sandbox_id_mismatch' });
        return;
      }
      if (!fencedWrite(directory, config.owner, config.commandId, generation,
        { status: 'running', pid, sandboxId, startedAt: Date.now() })) return;
      // Only write sandbox.json if this is the first launch (no frozen sandboxId).
      // A subsequent start with the same frozen sandboxId must not overwrite it.
      if (!config.frozenSandboxId)
        atomicPrivate(join(config.sandboxRoot, 'sandbox.json'), JSON.stringify({ sandboxId, owner: config.owner,
          createdAt: Date.now() }) + '\n');
    } else {
      pid = record.pid;
      sandboxId = record.sandboxId; // CRITICAL: set sandboxId for safeKill in reconnect mode
      // Compute the REMAINING timeout (not the full original) so the SDK connect
      // does not get a fresh budget. A reconnect must not reset the deadline.
      const elapsed = record.startedAt ? Date.now() - record.startedAt : 0;
      const remainingTimeoutMs = Math.max(0, (record.timeoutMs ?? 0) - elapsed);
      stream = await awaitBounded(transport.reconnect(pid, { sandboxId: record.sandboxId,
        timeout: Math.floor(remainingTimeoutMs / 1000) }), 10000);
      if (!fencedWrite(directory, config.owner, config.commandId, generation,
        { recoveredAt: Date.now(), reconnectGap: true })) return;
    }
    record = readE2BRecord(directory, config.owner, config.commandId);
    const timeoutMs = record.timeoutMs ?? 0;
    let remainingMs;
    if (!timeoutMs) remainingMs = null;
    else if (mode === 'start') remainingMs = timeoutMs;
    else { const startedAt = record.startedAt ?? 0; remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt)); }

    let cancelRequested = false, timeoutRequested = false, killSucceeded = false, streamError = false;
    const cancelPath = join(directory, 'cancel');
    let resolvedResult = null;
    // Track the result value we have subscribed to, so a new Promise assigned to
    // handle.result AFTER start (a late assignment) is detected and subscribed.
    let subscribedResult = undefined;

    // Subscribe to handle.result if it is set and we have not yet subscribed to
    // THIS value. A Promise gets a non-blocking .then() callback; a plain value is
    // stored directly. This handles both start-time and late assignments.
    const subscribeResult = () => {
      if (!stream || stream.result === undefined || stream.result === null) return;
      if (subscribedResult === stream.result) return; // already subscribed to this exact value
      subscribedResult = stream.result;
      const r = stream.result;
      if (typeof r === 'object' && r !== null && typeof r.then === 'function')
        r.then(v => { if (resolvedResult === null) resolvedResult = v; }).catch(() => {});
      else resolvedResult = r;
    };
    subscribeResult(); // subscribe at start time
    // Poll for late result assignments (non-Promise or a new Promise set after start).
    const pollResult = () => { if (resolvedResult === null) subscribeResult(); };

    // Single arbiter: cancel/deadline poll + result check → kill. NEVER awaits a
    // pending result Promise — only checks if resolvedResult was set by the
    // subscription callback. This keeps cancel/deadline responsive.
    // Also detects consumer EOF (no result, no cancel/timeout) and exits after a
    // bounded grace so the supervisor does not wait forever for a result that
    // never arrives.
    let consumerDone = false, consumerDoneAt = 0, stopConsumer = false;
    const watcher = (async () => {
      const start = Date.now();
      for (;;) {
        if (!stillCurrent(directory, config.owner, config.commandId, generation)) {
          settled = true; stopConsumer = true; return;
        }
        if (resolvedResult !== null) return;
        if (!cancelRequested && existsSync(cancelPath)) {
          cancelRequested = true; killSucceeded = await safeKill(transport, pid, sandboxId); await safeDisconnect(); return;
        }
        if (remainingMs !== null && !timeoutRequested && Date.now() - start >= remainingMs) {
          timeoutRequested = true; killSucceeded = await safeKill(transport, pid, sandboxId); await safeDisconnect(); return;
        }
        pollResult();
        if (consumerDone && resolvedResult === null && !cancelRequested && !timeoutRequested
          && Date.now() - consumerDoneAt >= 1000) return;
        await delay(50);
      }
    })();
    // Consumer: async-iterate the stream, append output. Breaks on cancel/timeout
    // or stopConsumer (set after the drain). Does NOT check settled.
    const consumer = (async () => {
      try {
        if (stream && Symbol.asyncIterator in stream) {
          for await (const event of stream) {
            if (cancelRequested || timeoutRequested || stopConsumer) break;
            if (event.stdout) append(join(directory, 'stdout'), event.stdout);
            if (event.stderr) append(join(directory, 'stderr'), event.stderr);
          }
        }
      } catch { streamError = true; }
      finally { consumerDone = true; consumerDoneAt = Date.now(); }
    })();
    // Wait for the watcher (arbiter).
    await watcher;
    // Bounded drain: let the consumer finish delivering buffered output that
    // arrived before or during the watcher's decision.
    try { await Promise.race([consumer, delay(2000)]); } catch {}
    // Stop the consumer: signal + a short grace for any final buffered event.
    // The finally block handles disconnect on all exit paths.
    stopConsumer = true;
    try { await Promise.race([consumer, delay(500)]); } catch {}
    settled = true;
    pollResult();
    if (resolvedResult === null) {
      subscribeResult();
      if (subscribedResult !== undefined && typeof subscribedResult === 'object' && subscribedResult !== null && typeof subscribedResult.then === 'function')
        resolvedResult = await awaitBounded(subscribedResult, 1000);
    }
    // Consumer did not drain on a natural completion → unknown.
    if (!consumerDone && !cancelRequested && !timeoutRequested) {
      if (stillCurrent(directory, config.owner, config.commandId, generation))
        fencedWrite(directory, config.owner, config.commandId, generation,
          { status: 'unknown', exitCode: null, evidenceIncomplete: true, completedAt: Date.now(), outcomeReason: 'consumer_did_not_drain' });
      return;
    }
    let exitCode = Number.isSafeInteger(resolvedResult?.exitCode) ? resolvedResult.exitCode : null;
    if (!stillCurrent(directory, config.owner, config.commandId, generation)) return;
    record = readE2BRecord(directory, config.owner, config.commandId);
    let status, reason;
    // A stream error (iterator threw) means the output is incomplete — even if an
    // exit code was observed, the outcome is unknown+evidenceIncomplete with the
    // observed code retained for inspection.
    if (streamError) {
      status = 'unknown'; reason = 'stream_error';
      fencedWrite(directory, config.owner, config.commandId, generation,
        { status, exitCode: null, evidenceIncomplete: true, observedExitCode: exitCode,
          observedReason: reason, completedAt: Date.now() });
      return;
    }
    if (exitCode !== null) {
      if (cancelRequested && killSucceeded) [status, reason] = ['canceled', 'canceled'];
      else if (cancelRequested && !killSucceeded) [status, reason] = exitCode === 0 ? ['completed', 'exit_after_cancel_request'] : ['failed', 'exit_after_cancel_request'];
      else if (timeoutRequested && killSucceeded) [status, reason] = ['timed_out', 'timed_out'];
      else if (timeoutRequested && !killSucceeded) [status, reason] = exitCode === 0 ? ['completed', 'exit_after_timeout_request'] : ['failed', 'exit_after_timeout_request'];
      else [status, reason] = exitCode === 0 ? ['completed', ''] : ['failed', ''];
    } else if (cancelRequested && killSucceeded) [status, reason] = ['canceled', 'killed_by_cancel'];
    else if (timeoutRequested && killSucceeded) [status, reason] = ['timed_out', 'killed_by_timeout'];
    else if (cancelRequested || timeoutRequested) [status, reason] = ['unknown', 'kill_unconfirmed'];
    else [status, reason] = ['unknown', 'no_terminal_event'];
    let patch = { status, exitCode, completedAt: Date.now() };
    if (appendOnly && record.reconnectGap) {
      patch = { evidenceIncomplete: true, observedExitCode: exitCode, observedReason: reason,
        status: 'unknown', exitCode: null, completedAt: Date.now() };
    } else if (status === 'unknown') {
      // ALL unknown outcomes must carry evidenceIncomplete: true.
      patch.evidenceIncomplete = true;
      if (exitCode !== null) { patch.observedExitCode = exitCode; patch.exitCode = null; }
      patch.outcomeReason = reason;
    } else patch.outcomeReason = reason;
    fencedWrite(directory, config.owner, config.commandId, generation, patch);
  } catch (error) {
    settled = true;
    fenceUnknown(config, 'supervisor_body_failed');
    throw error;
  } finally {
    // Bounded disconnect on ALL exit paths (natural, cancel, timeout, error) —
    // not just cancel/timeout. Prevents hanging connections and unhandled rejections.
    try { await safeDisconnect(); } catch {}
    release();
  }
}

// Issue a remote kill and return whether it was confirmed. A kill that raises or
// returns a non-true value is NOT confirmed. A Promise is awaited (bounded) — never
// treated as truthy. The sandboxId pins the kill to the EXACT sandbox that start()
// created — two sandboxes may share the same pid but are distinct.
const safeKill = async (transport, pid, sandboxId) => {
  try { return await awaitBounded(transport.kill(pid, { sandboxId }), 10000) === true; }
  catch { return false; }
};
