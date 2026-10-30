// Node owns the bounded lifetime; a packaged, verified POSIX exec substrate
// applies exact rlimits and an owner-pipe watchdog. This is a risk control for
// same-container commands, not an OS security sandbox or an execution policy.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { constants as osConstants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { localEnvironmentPolicy, localOutputPolicy, resolveEnvironmentPolicy, resolveOutputPolicy } from './local-output-policy.mjs';

export const LOCAL_PROCESS_CONTRACT = 'agentkit.local-process-control/v1';
const directory = fileURLToPath(new URL('./', import.meta.url));
const defaults = Object.freeze({ cpuSeconds: 120, addressSpaceBytes: 1024 ** 3, maxProcesses: 64,
  maxOpenFiles: 256, maxFileBytes: 64 * 1024 ** 2, maxOutputBytes: 1024 ** 2, wallSeconds: 900, extraEnvNames: [] });
const limitNames = ['cpuSeconds', 'addressSpaceBytes', 'maxProcesses', 'maxOpenFiles', 'maxFileBytes'];
export class LocalProcessError extends Error { constructor(code) { super(code); this.name = 'LocalProcessError'; this.code = code; } }
const check = (value, code) => { if (!value) throw new LocalProcessError(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function boundedWait(promise, milliseconds) {
  let timer;
  try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function localControlSettings(input = {}) {
  check(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => Object.hasOwn(defaults, key)), 'invalid_local_process_settings');
  const settings = { ...defaults, ...input };
  for (const [name, value] of Object.entries(settings)) if (name !== 'extraEnvNames')
    check(Number.isSafeInteger(value) && value > 0, `invalid_local_process_limit:${name}`);
  check(settings.wallSeconds <= Number.MAX_SAFE_INTEGER / 1000, 'invalid_local_process_wall_limit');
  check(Array.isArray(settings.extraEnvNames) && settings.extraEnvNames.every(name => typeof name === 'string'
    && namePattern.test(name) && !name.startsWith('KSADK_LOCAL_PROCESS_')), 'invalid_local_process_environment_allowlist');
  settings.extraEnvNames = Object.freeze([...new Set(settings.extraEnvNames)]);
  return Object.freeze(settings);
}
export function buildScriptEnvironment(source, { settings = localControlSettings(), required = {}, environmentPolicy = null } = {}) {
  const policy = localControlSettings(settings), env = resolveEnvironmentPolicy(policy, localEnvironmentPolicy(environmentPolicy)), result = Object.create(null);
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', ...env.names, ...policy.extraEnvNames])
    if (Object.hasOwn(source, name)) result[name] = String(source[name]);
  result.PATH ??= '/bin:/usr/bin'; result.LANG ??= 'C.UTF-8'; result.CI = '1';
  for (const [name, value] of Object.entries(required)) { check(namePattern.test(name), 'invalid_local_process_environment'); result[name] = String(value); }
  return result;
}
export function supportsLocalProcessPlatform({ platform = process.platform, arch = process.arch } = {}) {
  return ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(`${platform}-${arch}`);
}
export function resolveLocalProcessLauncher({ platform = process.platform, arch = process.arch } = {}) {
  const target = `${platform}-${arch}`;
  check(supportsLocalProcessPlatform({ platform, arch }), 'unsupported_local_process_platform');
  const manifest = JSON.parse(readFileSync(join(directory, 'local-process-manifest.json'), 'utf8'));
  check(manifest.schemaVersion === 'agentkit.local-process-binary/v1'
    && manifest.sourceSha256 === hash(readFileSync(join(directory, 'local-process-launcher.c'))), 'local_process_source_digest_mismatch');
  const entry = manifest.builds?.[target], relative = `local-process-bin/${target}/launcher`;
  check(entry?.file === relative, 'local_process_launcher_missing');
  const filename = join(directory, relative), stat = lstatSync(filename);
  check(stat.isFile() && (stat.mode & 0o111) !== 0, 'local_process_launcher_not_executable');
  const bytes = readFileSync(filename, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
  check(bytes.length === entry.bytes && hash(bytes) === entry.sha256, 'local_process_launcher_digest_mismatch');
  return filename;
}
function controlReport(text, settings) {
  try {
    const report = JSON.parse(text);
    check(report.schemaVersion === LOCAL_PROCESS_CONTRACT && ['applied', 'partial', 'failed'].includes(report.status)
      && report.applied && typeof report.applied === 'object' && !Array.isArray(report.applied)
      && Array.isArray(report.unsupported) && Array.isArray(report.failed), 'invalid_local_process_control_report');
    check(Object.entries(report.applied).every(([key, value]) => limitNames.includes(key)
      && Number.isSafeInteger(value) && value >= 0 && value <= settings[key]), 'invalid_local_process_control_report');
    check(report.unsupported.every(key => limitNames.includes(key)) && report.failed.every(key => [...limitNames, 'owner_watchdog'].includes(key)),
      'invalid_local_process_control_report');
    if (report.status !== 'failed') {
      const allowedUnsupported = process.platform === 'darwin' ? ['addressSpaceBytes', 'maxProcesses'] : [];
      check(Number.isSafeInteger(report.watcherPid) && report.watcherPid > 0 && !report.failed.length
        && report.unsupported.length === allowedUnsupported.length && allowedUnsupported.every(key => report.unsupported.includes(key))
        && limitNames.every(key => Object.hasOwn(report.applied, key) !== report.unsupported.includes(key))
        && report.status === (allowedUnsupported.length ? 'partial' : 'applied'), 'invalid_local_process_control_report');
    }
    const { watcherPid, ...publicReport } = report; return publicReport;
  } catch { return { schemaVersion: LOCAL_PROCESS_CONTRACT, status: 'failed', applied: {}, unsupported: [], failed: ['control_report'] }; }
}

/** argv/env are already Host-authorized. Shell/AST/workspace policy belongs to
 * the caller; no retries and no durable handle ownership is inferred here.
 * outputPolicy is opt-in (persisted-stream/v1); when absent, legacy
 * maxOutputBytes-then-kill semantics and result shape are preserved exactly. */
export async function runBoundedProcess({ argv, cwd, env, settings: input = {}, timeoutMs = null, signal, onOutput, onSpawn, outputPolicy = null } = {}) {
  const settings = localControlSettings(input); signal?.throwIfAborted();
  check(Array.isArray(argv) && argv.length > 0 && argv.every(value => typeof value === 'string' && !value.includes('\0'))
    && argv[0].length > 0 && typeof cwd === 'string' && cwd.length > 0, 'invalid_local_process_command');
  check(env && typeof env === 'object' && !Array.isArray(env) && Object.entries(env).every(([name, value]) =>
    namePattern.test(name) && typeof value === 'string' && !value.includes('\0')), 'invalid_local_process_environment');
  check(timeoutMs === null || Number.isFinite(timeoutMs) && timeoutMs > 0, 'invalid_local_process_timeout');
  const outPolicy = resolveOutputPolicy(settings, localOutputPolicy(outputPolicy));
  const executable = resolveLocalProcessLauncher();
  const started = performance.now(), duration = Math.min(timeoutMs ?? Infinity, settings.wallSeconds * 1000);
  const child = spawn(executable, [...limitNames.map(key => String(settings[key])), '3', '4', '--', ...argv], {
    cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  const output = { stdout: [], stderr: [] }, lengths = { stdout: 0, stderr: 0 };
  const truncated = { stdout: false, stderr: false }, decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const report = []; let reportBytes = 0, timedOut = false, canceled = false, outputLimitExceeded = false;
  const cleanupErrors = new Set(); let exitCode = null, exitSignal = null, exited = false, closed = false, spawnError = null, timer;
  let stop; const stopping = new Promise(resolve => { stop = resolve; });
  let exitDone; const exit = new Promise(resolve => { exitDone = resolve; });
  let closeDone; const close = new Promise(resolve => { closeDone = resolve; });
  child.once('error', error => { spawnError = error; exitDone(); stop(); });
  child.once('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; exitDone(); stop(); });
  child.once('close', () => { closed = true; closeDone(); });
  child.once('spawn', () => { try { onSpawn?.({ pid: child.pid }); } catch { cleanupErrors.add('spawn_observer_failed'); stop(); } });
  // persisted-stream/v1: the full capped UTF-8 output is streamed out via onOutput
  // to the existing supervisor-owned files; result.stdout/stderr hold ONLY a bounded
  // preview. No full 64MiB buffer is held in memory here. The supervisor fsyncs the
  // streamed files before its terminal receipt and never overwrites them with the
  // preview. Only the hard persisted cap, timeout, cancellation, or real resource
  // limits stop the process; preview overflow never kills a successful process.
  const persistedStream = outPolicy.mode === 'persistedStream';
  const preview = persistedStream ? { stdout: [], stderr: [], lengths: { stdout: 0, stderr: 0 },
    truncated: { stdout: false, stderr: false } } : null;
  const stream = persistedStream ? { lengths: { stdout: 0, stderr: 0 }, emitted: { stdout: 0, stderr: 0 }, truncated: { stdout: false, stderr: false },
    decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') } } : null;
  const utf8Prefix = (text, limit) => new StringDecoder('utf8').write(Buffer.from(text).subarray(0, limit));
  const emitPersisted = (channel, text) => {
    // Invalid source bytes may expand into replacement characters. Bound the
    // encoded observation too, so normalization cannot exceed the persisted cap.
    const remaining = outPolicy.persistedBytes - stream.emitted[channel];
    const bounded = utf8Prefix(text, remaining);
    stream.emitted[channel] += Buffer.byteLength(bounded);
    if (bounded) { try { onOutput?.(channel, bounded); } catch { /* supervisor records its own write failure */ } }
    if (bounded !== text) { stream.truncated[channel] = true; outputLimitExceeded = true; stop(); }
  };
  for (const channel of ['stdout', 'stderr']) {
    child[channel].on('error', () => { cleanupErrors.add(`${channel}_read_error`); stop(); });
    child[channel].on('data', chunk => {
      if (!persistedStream) {
        const remaining = settings.maxOutputBytes - lengths[channel], kept = chunk.subarray(0, Math.max(0, remaining));
        if (kept.length) {
          output[channel].push(kept); lengths[channel] += kept.length;
          const text = decoders[channel].write(kept);
          if (text) { try { onOutput?.(channel, text); } catch { /* observation never changes execution */ } }
        }
        if (chunk.length > remaining) { truncated[channel] = true; outputLimitExceeded = true; stop(); }
        return;
      }
      // Hard persisted cap: stream all bytes up to this bound via onOutput (to the
      // owned files). Beyond it the process is stopped — this is the real boundary.
      const pRemaining = outPolicy.persistedBytes - stream.lengths[channel];
      const pKept = chunk.subarray(0, Math.max(0, pRemaining));
      const overcap = chunk.length > pRemaining;
      if (pKept.length) {
        stream.lengths[channel] += pKept.length;
        // Stream complete characters only; the StringDecoder holds a trailing
        // partial multibyte sequence rather than emitting it. We never flush that
        // held tail as replacement bytes (end()), so the file holds at most
        // persistedBytes of valid UTF-8 — a cap-cut multibyte sequence is dropped,
        // not written as a 3-byte replacement char beyond the cap.
        const text = stream.decoders[channel].write(pKept);
        if (text) emitPersisted(channel, text);
      }
      // Bounded in-memory preview: keep only up to previewBytes for the receipt,
      // captured from pKept BEFORE the hard-cap return so an overcap first chunk
      // still yields a non-empty preview. Preview overflow is honest (truncated
      // flag) but never stops the process.
      const vRemaining = outPolicy.previewBytes - preview.lengths[channel];
      if (vRemaining > 0) {
        const vKept = pKept.subarray(0, Math.min(pKept.length, vRemaining));
        if (vKept.length) { preview[channel].push(vKept); preview.lengths[channel] += vKept.length; }
        if (pKept.length > vRemaining) preview.truncated[channel] = true;
      } else if (chunk.length) preview.truncated[channel] = true;
      if (overcap) { stream.truncated[channel] = true; outputLimitExceeded = true; stop(); }
    });
  }
  child.stdio[3].on('error', () => { cleanupErrors.add('control_report_read_error'); stop(); });
  child.stdio[3].on('data', chunk => {
    reportBytes += chunk.length;
    if (reportBytes <= 4096) report.push(chunk); else { cleanupErrors.add('control_report_oversize'); stop(); }
  });
  child.stdio[4].on('error', () => { cleanupErrors.add('owner_lease_error'); stop(); });
  const abort = () => { canceled = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const deadline = () => {
    const remaining = duration - (performance.now() - started);
    if (remaining <= 0) { timedOut = true; stop(); }
    else timer = setTimeout(deadline, Math.min(2_147_483_647, Math.max(1, remaining)));
  };
  deadline();
  const groupSignal = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') cleanupErrors.add(`group_${signal}:${error.code ?? 'error'}`); }
  };
  try {
    await stopping; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (child.pid) {
      groupSignal('SIGTERM'); await wait(200); groupSignal('SIGKILL');
      if (!exited) await boundedWait(exit, 1000);
      if (!exited && !spawnError) { cleanupErrors.add('process_reap_timeout'); try { child.kill('SIGKILL'); } catch { /* recorded below */ } }
    }
    // The only owner writer closes after the last group signal. The watchdog
    // also handles hard caller death, when no finally block can execute.
    child.stdio[4].destroy();
    if (!closed) await boundedWait(close, 200);
    if (!closed && !spawnError) cleanupErrors.add('process_stdio_close_timeout');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    for (const stream of child.stdio) stream?.destroy();
    if (!exited) child.unref();
  }
  if (!persistedStream) {
    for (const channel of ['stdout', 'stderr']) {
      const tail = decoders[channel].end();
      if (tail) { try { onOutput?.(channel, tail); } catch { /* observation never changes execution */ } }
    }
  }
  if (persistedStream) for (const channel of ['stdout', 'stderr']) {
    // Do not synthesize a replacement for a sequence cut by the hard cap.
    // Natural invalid tails are normalized within the same encoded-byte bound.
    if (!stream.truncated[channel]) emitPersisted(channel, stream.decoders[channel].end());
  }
  if (spawnError) throw new LocalProcessError(`local_process_spawn_failed:${spawnError.code ?? 'error'}`);
  const controls = controlReport(Buffer.concat(report).toString('utf8'), settings);
  const code = exitCode ?? (exitSignal && osConstants.signals[exitSignal] ? -osConstants.signals[exitSignal] : null);
  if (!persistedStream)
    return { stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'),
      exitCode: outputLimitExceeded ? 122 : code, timedOut, canceled, outputLimitExceeded,
      stdoutTruncated: truncated.stdout, stderrTruncated: truncated.stderr, cleanupError: [...cleanupErrors].join(',') || null, controls };
  // persisted-stream/v1: stdout/stderr hold ONLY the bounded preview. The full
  // capped output lives in the supervisor-owned files (streamed via onOutput and
  // located by task_id/cursors). Honest truncation flags distinguish preview vs
  // hard persisted bounds; outputPersistedTruncated marks the real boundary.
  const previewText = channel => {
    const decoded = Buffer.concat(preview[channel]).toString('utf8'), bounded = utf8Prefix(decoded, outPolicy.previewBytes);
    if (bounded !== decoded) preview.truncated[channel] = true;
    return bounded;
  };
  return { stdout: previewText('stdout'), stderr: previewText('stderr'),
    exitCode: outputLimitExceeded ? 122 : code, timedOut, canceled, outputLimitExceeded,
    stdoutTruncated: preview.truncated.stdout, stderrTruncated: preview.truncated.stderr,
    stdoutPersistedTruncated: stream.truncated.stdout, stderrPersistedTruncated: stream.truncated.stderr,
    previewBytes: outPolicy.previewBytes, persistedBytes: outPolicy.persistedBytes,
    cleanupError: [...cleanupErrors].join(',') || null, controls };
}
