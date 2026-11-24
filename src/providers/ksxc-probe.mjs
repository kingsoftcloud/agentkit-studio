/** M0 preparation only: explicit binary, --version and initialize; never starts a turn. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveKsxcCommand } from './ksxc-command.mjs';

const runFile = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const failure = code => Object.assign(new Error(code), { code });
const safeToken = value => typeof value === 'string' && /^[A-Za-z0-9._/+:-]{1,100}$/.test(value) ? value : null;

async function handshake(executable, { env, cwd, timeoutMs }) {
  const child = spawn(executable, ['app-server', '--stdio'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let exited = false;
  const exit = new Promise(resolveExit => { child.once('exit', () => { exited = true; resolveExit(); }); child.once('error', resolveExit); });
  let timer;
  try {
    return await new Promise((resolveHandshake, reject) => {
      let buffer = '', bytes = 0, done = false;
      const fail = code => { if (!done) { done = true; reject(failure(code)); } };
      timer = setTimeout(() => fail('KSXC_PROBE_HANDSHAKE_TIMEOUT'), timeoutMs);
      child.on('error', () => fail('KSXC_PROBE_PROCESS_FAILED'));
      child.on('exit', () => fail('KSXC_PROBE_EARLY_EXIT'));
      child.stdin.on('error', () => fail('KSXC_PROBE_TRANSPORT_FAILED'));
      child.stdout.on('error', () => fail('KSXC_PROBE_TRANSPORT_FAILED'));
      child.stderr.resume();
      child.stdout.on('data', chunk => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { fail('KSXC_PROBE_OUTPUT_LIMIT'); return; }
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { fail('KSXC_PROBE_INVALID_JSON'); return; }
          if (message.id !== 1 || message.method) continue;
          if (message.error || !message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
            fail('KSXC_PROBE_INITIALIZE_REJECTED'); return;
          }
          done = true;
          // No response strings, model lists, auth status, environment or stderr
          // are included in the report. A missing protocol field remains null.
          const result = message.result;
          child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          resolveHandshake({ accepted: true,
            resultFields: Object.keys(result).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).sort(),
            advertisedProtocolVersion: safeToken(result.protocolVersion ?? result.protocol_version),
          });
          return;
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { clientInfo: { name: 'agentkit-studio-m0-probe', version: '0.0.1' }, capabilities: { experimentalApi: true } } }) + '\n');
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (!exited) child.kill('SIGTERM');
    let killTimer;
    const stopped = new Promise(resolveStop => {
      killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); resolveStop(); }, 500);
    });
    await Promise.race([exit, stopped]);
    clearTimeout(killTimer);
  }
}

export async function probeKsxcPayload({ executable, expectedSha256, timeoutMs = 10000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw failure('KSXC_PROBE_TIMEOUT_INVALID');
  // Deliberately ignore ambient executable/profile/auth settings.
  const command = resolveKsxcCommand({ executable, expectedSha256, env: {} });
  const payload = await command.validate({ requireProtocol: false, requireCompanyConfig: false });
  const home = await mkdtemp(join(tmpdir(), 'agentkit-ksxc-m0-'));
  const systemKeys = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(systemKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: home, USERPROFILE: home, KSXC_HOME: home, CODEX_HOME: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, KSXC_DISABLE_UPDATE: '1' });
  try {
    // KSXC 1.4.0 requires company configuration even for app-server --help.
    // Use only a deliberately inert loopback endpoint, never the user's account.
    await writeFile(join(home, 'config.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:9',
      code: 'studio-m0-probe', installerUrl: 'http://127.0.0.1:9/install.sh' }), { mode: 0o600 });
    let version;
    try {
      const { stdout } = await runFile(command.executable, ['--version'], {
        env, cwd: home, timeout: timeoutMs, maxBuffer: 65536, killSignal: 'SIGKILL', windowsHide: true,
      });
      version = { detected: stdout.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0] || null,
        outputSha256: sha256(stdout) };
    } catch { throw failure('KSXC_PROBE_VERSION_FAILED'); }
    return { schema: 'agentkit.ksxc-m0-probe/v1', target: payload.target, payloadSha256: payload.sha256,
      expectedDigestMatched: payload.integrityVerified, version,
      initialize: await handshake(command.executable, { env, cwd: home, timeoutMs }),
      companyConfig: 'isolated-loopback', modelRequests: 0, fullConformancePassed: false,
      remaining: ['thread/turn parameters', 'bound tools', 'approval', 'cancel', 'usage', 'real Host and target-platform smoke'],
    };
  } finally { await rm(home, { recursive: true, force: true }); }
}
