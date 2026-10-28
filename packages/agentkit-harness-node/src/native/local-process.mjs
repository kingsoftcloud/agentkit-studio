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
export function buildScriptEnvironment(source, { settings = localControlSettings(), required = {} } = {}) {
  const policy = localControlSettings(settings), result = Object.create(null);
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', ...policy.extraEnvNames])
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
 * the caller; no retries and no durable handle ownership is inferred here. */
export async function runBoundedProcess({ argv, cwd, env, settings: input = {}, timeoutMs = null, signal, onOutput, onSpawn } = {}) {
  const settings = localControlSettings(input); signal?.throwIfAborted();
  check(Array.isArray(argv) && argv.length > 0 && argv.every(value => typeof value === 'string' && !value.includes('\0'))
    && argv[0].length > 0 && typeof cwd === 'string' && cwd.length > 0, 'invalid_local_process_command');
  check(env && typeof env === 'object' && !Array.isArray(env) && Object.entries(env).every(([name, value]) =>
    namePattern.test(name) && typeof value === 'string' && !value.includes('\0')), 'invalid_local_process_environment');
  check(timeoutMs === null || Number.isFinite(timeoutMs) && timeoutMs > 0, 'invalid_local_process_timeout');
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
  for (const channel of ['stdout', 'stderr']) {
    child[channel].on('error', () => { cleanupErrors.add(`${channel}_read_error`); stop(); });
    child[channel].on('data', chunk => {
      const remaining = settings.maxOutputBytes - lengths[channel], kept = chunk.subarray(0, Math.max(0, remaining));
      if (kept.length) {
        output[channel].push(kept); lengths[channel] += kept.length;
        const text = decoders[channel].write(kept);
        if (text) { try { onOutput?.(channel, text); } catch { /* observation never changes execution */ } }
      }
      if (chunk.length > remaining) { truncated[channel] = true; outputLimitExceeded = true; stop(); }
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
  for (const channel of ['stdout', 'stderr']) {
    const tail = decoders[channel].end();
    if (tail) { try { onOutput?.(channel, tail); } catch { /* observation never changes execution */ } }
  }
  if (spawnError) throw new LocalProcessError(`local_process_spawn_failed:${spawnError.code ?? 'error'}`);
  const controls = controlReport(Buffer.concat(report).toString('utf8'), settings);
  const code = exitCode ?? (exitSignal && osConstants.signals[exitSignal] ? -osConstants.signals[exitSignal] : null);
  return { stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'),
    exitCode: outputLimitExceeded ? 122 : code, timedOut, canceled, outputLimitExceeded,
    stdoutTruncated: truncated.stdout, stderrTruncated: truncated.stderr, cleanupError: [...cleanupErrors].join(',') || null, controls };
}
