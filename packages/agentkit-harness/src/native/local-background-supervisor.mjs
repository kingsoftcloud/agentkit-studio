// Separate trusted Node process: the tool/Host caller may disappear while this
// supervisor continues. Its own death closes the bounded runner's owner pipe.
import { constants, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandRequest } from './local-background.mjs';
import { runBoundedProcess } from './local-process.mjs';
import { START_GRACE_MS, TERMINAL, atomicPrivate, check, digest, lockUntil, openPrivate,
  privateDirectory, privateFile, readRecord, unknownRecord, validId, writeRecord } from './local-command-state.mjs';

async function inputRequest() {
  let size = 0; const parts = [];
  const timer = setTimeout(() => process.stdin.destroy(Error('request_timeout')), START_GRACE_MS);
  try {
    for await (const part of process.stdin) {
      size += part.length; check(size <= 1024 * 1024, 'background_command_request_too_large'); parts.push(part);
    }
    return commandRequest(JSON.parse(Buffer.concat(parts).toString('utf8')));
  } finally { clearTimeout(timer); }
}
async function supervise() {
  const [directory, owner, commandId] = process.argv.slice(2);
  check(typeof directory === 'string' && validId(owner) && validId(commandId), 'invalid_background_supervisor_arguments');
  privateDirectory(directory);
  const unlock = await lockUntil(join(directory, 'supervisor.sqlite'), performance.now() + START_GRACE_MS);
  let record;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  let poll;
  try {
    record = readRecord(directory, owner, commandId);
    // A duplicate/stale supervisor can never reclaim a prepared operation.
    if (record.status !== 'starting') return;
    const request = await inputRequest();
    check(record.requestDigest === digest(request), 'background_command_request_digest_mismatch');
    record = readRecord(directory, owner, commandId);
    if (record.status !== 'starting') return;
    if (Date.now() - record.createdAt >= START_GRACE_MS) {
      unknownRecord(directory, record, 'supervisor_start_expired'); return;
    }
    const persist = (status, exitCode, stdout, stderr, metadata = {}) => {
      // Complete bytes are fsynced and published BEFORE the terminal receipt.
      for (const [channel, text] of [['stdout', stdout], ['stderr', stderr]]) atomicPrivate(join(directory, channel), text);
      record = { ...record, ...metadata, status, exitCode, completedAt: Date.now() }; writeRecord(directory, record);
    };
    if (privateFile(join(directory, 'cancel'), true) || controller.signal.aborted) {
      persist('canceled', null, '', ''); return;
    }
    record = { ...record, status: 'running', supervisorPid: process.pid }; writeRecord(directory, record);
    let outputError = false;
    poll = setInterval(() => {
      try { if (privateFile(join(directory, 'cancel'), true)) cancel(); }
      catch { outputError = true; cancel(); }
    }, 20);
    const result = await runBoundedProcess({ argv: ['/bin/sh', '-c', request.command], cwd: request.cwd,
      env: request.env, timeoutMs: request.timeoutMs, settings: request.settings, signal: controller.signal,
      onOutput(channel, text) {
        let fd;
        try {
          fd = openPrivate(join(directory, channel), constants.O_WRONLY | constants.O_APPEND); writeFileSync(fd, text);
        } catch { outputError = true; cancel(); }
        finally { if (fd !== undefined) closeSync(fd); }
      } });
    clearInterval(poll); poll = null;
    let status = result.exitCode === 0 ? 'completed' : 'failed', exitCode = result.exitCode, diagnostic = '';
    if (result.canceled) status = 'canceled';
    else if (result.timedOut) { status = 'timed_out'; exitCode = 124; diagnostic = 'command timed out'; }
    else if (result.outputLimitExceeded) { status = 'output_limit'; exitCode = 122; diagnostic = 'command output limit exceeded'; }
    if (result.controls.status === 'failed' || result.cleanupError || outputError) {
      status = 'unknown'; exitCode = null; diagnostic = 'command supervision or cleanup failed';
    }
    const stderr = result.stderr + (diagnostic ? (result.stderr && !result.stderr.endsWith('\n') ? '\n' : '') + diagnostic : '');
    persist(status, exitCode, result.stdout, stderr, { controls: result.controls, outputLimitExceeded: result.outputLimitExceeded,
      evidenceIncomplete: status === 'unknown', observedExitCode: status === 'unknown' ? result.exitCode : null,
      outcomeReason: status === 'unknown' ? 'process_supervision_failed' : '' });
  } catch {
    // Secrets/input exception strings never enter records or diagnostics.
    if (record && !TERMINAL.has(record.status)) unknownRecord(directory, record, 'supervisor_failed');
  } finally {
    clearInterval(poll); process.off('SIGTERM', cancel); process.off('SIGINT', cancel); unlock();
  }
}
supervise().catch(() => { process.exitCode = 1; });
