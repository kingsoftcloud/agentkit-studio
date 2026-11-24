import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

function darwinGroupHasExited(pid) {
  // Darwin can return EPERM for a group containing only unreaped children.
  // A live member still represents a real signaling failure.
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], {
      encoding: 'utf8', timeout: 2000,
    });
    if (!output.trim()) return false;
    const processes = output.trim().split('\n').map(row => /^\s*(\d+)\s+(\S+)\s*$/u.exec(row));
    return processes.every(row => row && (Number(row[1]) !== pid || row[2].startsWith('Z')));
  } catch { return false; }
}

/** Own the entire installer process group, including package-manager wrappers.
 * An attempt cannot finish or retry while its descendants keep running. */
export function runWithDeadline(command, args, { timeoutMs, graceMs = 15000, env = process.env,
  cwd = process.cwd(), stdio = 'inherit', signal } = {}) {
  if (process.platform === 'win32') throw Error('This CI process owner requires POSIX process groups');
  for (const value of [timeoutMs, graceMs])
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw TypeError('Invalid CI deadline');
  if (!command || !Array.isArray(args) || args.some(value => typeof value !== 'string')) throw TypeError('Invalid CI command');
  if (signal?.aborted) return Promise.resolve(143);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio, detached: true });
    let settled = false, terminationCode = null, grace;
    const killGroup = name => {
      if (!child.pid) return;
      try { process.kill(-child.pid, name); } catch (error) {
        if (error.code === 'ESRCH'
          || error.code === 'EPERM' && process.platform === 'darwin' && darwinGroupHasExited(child.pid)) return;
        throw error;
      }
    };
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(grace);
      signal?.removeEventListener('abort', abort);
      try { killGroup('SIGKILL'); } catch (cleanupError) { error ??= cleanupError; }
      if (error) reject(error); else resolve(terminationCode ?? code);
    };
    const terminate = code => {
      if (settled || terminationCode !== null) return;
      terminationCode = code;
      try { killGroup('SIGTERM'); } catch (error) { finish(code, error); return; }
      grace = setTimeout(() => {
        try { killGroup('SIGKILL'); } catch (error) { finish(code, error); }
      }, graceMs);
    };
    const abort = () => terminate(signal.reason === 'SIGINT' ? 130 : 143);
    const deadline = setTimeout(() => terminate(124), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => finish(127, error));
    child.once('exit', (code, name) => finish(code ?? 128 + (constants.signals[name] ?? 1)));
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2), split = args.indexOf('--');
  const { values } = parseArgs({ args: args.slice(0, split < 0 ? args.length : split), options: {
    'timeout-ms': { type: 'string' }, 'kill-grace-ms': { type: 'string', default: '15000' },
  } });
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(name));
  try {
    if (split < 0 || !args[split + 1]) throw TypeError('A CI command after -- is required');
    process.exitCode = await runWithDeadline(args[split + 1], args.slice(split + 2), {
      timeoutMs: Number(values['timeout-ms']), graceMs: Number(values['kill-grace-ms']), signal: controller.signal,
    });
    if (process.exitCode === 124) console.error('CI command exceeded its deadline; the installer process group was terminated.');
  } catch (error) {
    console.error('CI process owner failed:', error.code || error.name);
    process.exitCode = 127;
  }
}
