import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runBoundedProcess, buildScriptEnvironment, localControlSettings, resolveLocalProcessLauncher } from '../src/native/local-process.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function workspace(t) { const directory = mkdtempSync(join(tmpdir(), 'native-local-process-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }
const run = (directory, argv, options = {}) => runBoundedProcess({ cwd: directory, argv, env: buildScriptEnvironment(process.env), ...options });
async function waitFor(predicate) {
  const until = Date.now() + 3000;
  while (Date.now() < until) { if (predicate()) return; await pause(20); }
  assert.fail('process lifecycle did not settle before deadline');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function readPid(filename) {
  if (!existsSync(filename)) return null;
  const text = readFileSync(filename, 'utf8');
  // Opening the fixture file precedes printf's write; existence alone can
  // observe an empty file (Number('') is 0, meaning the caller's own group).
  return /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

test('settings and environment admit only explicit, validated Host controls', () => {
  const settings = localControlSettings({ extraEnvNames: ['EXTRA', 'EXTRA'] }); assert.deepEqual(settings.extraEnvNames, ['EXTRA']);
  for (const input of [{ maxOpenFiles: 0 }, { cpuSeconds: '2' }, { maxFileBytes: 1.1 }, { wallSeconds: Number.MAX_SAFE_INTEGER },
    { extraEnvNames: ['BAD=NAME'] }, { extraEnvNames: ['KSADK_LOCAL_PROCESS_CPU_SECONDS'] }, { unknown: 1 }]) assert.throws(() => localControlSettings(input));
  const env = buildScriptEnvironment({ PATH: '/bin', EXTRA: 'yes', API_KEY: 'secret', NODE_OPTIONS: 'injected', BASH_ENV: 'injected' }, { settings });
  assert.deepEqual({ ...env }, { PATH: '/bin', EXTRA: 'yes', LANG: 'C.UTF-8', CI: '1' });
  assert.throws(() => resolveLocalProcessLauncher({ platform: 'win32', arch: 'x64' }), { code: 'unsupported_local_process_platform' });
});
test('verified packaged executable applies exact caps before any target command; no Python or shell launcher', async t => {
  const directory = workspace(t), result = await run(directory, ['/bin/sh', '-c', 'printf hello; printf diagnostic >&2; exit 7'], {
    env: buildScriptEnvironment({ PATH: join(directory, 'no-programs') }), settings: { maxFileBytes: 1001 },
  });
  assert.equal(result.stdout, 'hello'); assert.equal(result.stderr, 'diagnostic'); assert.equal(result.exitCode, 7);
  assert.equal(result.cleanupError, null); assert.equal(result.controls.status, process.platform === 'darwin' ? 'partial' : 'applied');
  assert.equal(result.controls.applied.maxFileBytes, 1001); assert.equal(result.controls.applied.maxOpenFiles, 256);
  assert.equal(Object.hasOwn(result.controls, 'watcherPid'), false);
  assert.deepEqual(result.controls.unsupported, process.platform === 'darwin' ? ['addressSpaceBytes', 'maxProcesses'] : []);
});
test('the exec target cannot access the control report or the private owner lease', async t => {
  // An interpreter/emulator may reuse a closed descriptor for its executable
  // (Docker's x64 Rosetta does this for busybox). The private lease is an IPC
  // descriptor; it must never remain inherited, even if the number is reused.
  const result = await run(workspace(t), ['/bin/sh', '-c',
    'if (printf leak >&3) 2>/dev/null; then exit 41; fi; if [ -p /dev/fd/4 ] || [ -S /dev/fd/4 ]; then exit 42; fi; printf closed']);
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'closed'); assert.equal(result.cleanupError, null);
});
test('captured stdout and stderr each have a byte bound; observers cannot change execution', async t => {
  // Overflow terminates the producer immediately. Test channels separately:
  // after stdout overflow the producer need not reach its later stderr write.
  for (const channel of ['stdout', 'stderr']) {
    const result = await run(workspace(t), ['/bin/sh', '-c', channel === 'stdout' ? 'printf 12345' : 'printf 12345 >&2'], {
      settings: { maxOutputBytes: 4 }, onOutput: () => { throw Error('display unavailable'); },
    });
    const other = channel === 'stdout' ? 'stderr' : 'stdout';
    assert.equal(result[channel], '1234'); assert.equal(result[other], ''); assert.equal(result.exitCode, 122);
    assert.equal(result.outputLimitExceeded, true); assert.equal(result[`${channel}Truncated`], true);
    assert.equal(result[`${other}Truncated`], false); assert.equal(result.cleanupError, null);
  }
});
test('multibyte output is decoded incrementally and byte truncation reports replacement exactly once', async t => {
  const chunks = [], result = await run(workspace(t), ['/bin/sh', '-c', "printf '\\342\\202'; printf '\\254Z'"], {
    settings: { maxOutputBytes: 3 }, onOutput: (channel, text) => chunks.push([channel, text]),
  });
  assert.equal(result.stdout, '€'); assert.deepEqual(chunks, [['stdout', '€']]); assert.equal(result.stdoutTruncated, true);
  const partialChunks = [];
  const partial = await run(workspace(t), ['/bin/sh', '-c', "printf '\\342\\202\\254'"], {
    settings: { maxOutputBytes: 2 }, onOutput: (channel, text) => partialChunks.push([channel, text]),
  });
  assert.equal(partial.stdout, '�'); assert.equal(partial.outputLimitExceeded, true);
  assert.deepEqual(partialChunks, [['stdout', '�']]);
  const finalChunks = [], incomplete = await run(workspace(t), ['/bin/sh', '-c', "printf '\\342\\202'"], {
    onOutput: (channel, text) => finalChunks.push([channel, text]),
  });
  assert.equal(incomplete.stdout, '�'); assert.equal(incomplete.outputLimitExceeded, false);
  assert.deepEqual(finalChunks, [['stdout', '�']]);
});
test('file size limits preserve byte precision rather than rounding to a shell ulimit unit', async t => {
  const directory = workspace(t), result = await run(directory, ['/bin/sh', '-c', "printf '%01024d' 0 > capped.bin"], { settings: { maxFileBytes: 1001 } });
  assert.equal(result.controls.applied.maxFileBytes, 1001); assert.ok(statSync(join(directory, 'capped.bin')).size <= 1001);
  assert.notEqual(result.exitCode, 0); assert.equal(result.cleanupError, null);
});
test('the inherited OS hard limit is clamped rather than raised by the launcher', async t => {
  const directory = workspace(t), moduleUrl = new URL('../src/native/local-process.mjs', import.meta.url).href;
  const code = `import {runBoundedProcess,buildScriptEnvironment} from ${JSON.stringify(moduleUrl)};
    const result=await runBoundedProcess({cwd:process.cwd(),argv:['/bin/sh','-c','ulimit -Hn'],env:buildScriptEnvironment(process.env)});
    console.log(JSON.stringify(result));`;
  const child = spawnSync('/bin/sh', ['-c', 'ulimit -n 64; exec "$@"', 'bounded-parent', process.execPath, '--input-type=module', '-e', code], {
    cwd: directory, env: { PATH: join(directory, 'no-programs') }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.controls.applied.maxOpenFiles, 64); assert.equal(result.stdout.trim(), '64');
});
if (process.platform === 'linux' && process.getuid() !== 0) test('non-root Linux refuses exec if the required owner watchdog cannot fork under NPROC', async t => {
  const directory = workspace(t), result = await run(directory, ['/bin/sh', '-c', 'printf forbidden > must-not-exist'], { settings: { maxProcesses: 1 } });
  assert.equal(result.controls.status, 'failed'); assert.ok(result.controls.failed.includes('owner_watchdog'));
  assert.equal(result.exitCode, 125); assert.equal(existsSync(join(directory, 'must-not-exist')), false);
});
test('CPU hard limit is enforced by the OS without waiting for the Node wall deadline', { timeout: 12_000 }, async t => {
  const result = await run(workspace(t), ['/bin/sh', '-c', 'while :; do :; done'], { settings: { cpuSeconds: 1 }, timeoutMs: 8000 });
  assert.equal(result.timedOut, false); assert.ok([-constants.signals.SIGKILL, -constants.signals.SIGXCPU].includes(result.exitCode));
  assert.equal(result.controls.applied.cpuSeconds, 1); assert.equal(result.cleanupError, null);
});
test('wall timeout ends an otherwise stalled process and reaps the owned group', async t => {
  const result = await run(workspace(t), ['/bin/sleep', '60'], { timeoutMs: 60 });
  assert.equal(result.timedOut, true); assert.notEqual(result.exitCode, 0); assert.equal(result.cleanupError, null);
});
test('cancellation stops descendants that ignore TERM and discards inherited output handles', async t => {
  const directory = workspace(t), marker = join(directory, 'child.pid'), controller = new AbortController();
  const running = run(directory, ['/bin/sh', '-c', '(/bin/sh -c \'trap "" TERM; while :; do /bin/sleep 1; done\') & printf "%s" "$!" > child.pid; wait'], { signal: controller.signal });
  await waitFor(() => readPid(marker) !== null); const pid = readPid(marker);
  controller.abort(); const result = await running; assert.equal(result.canceled, true); assert.equal(result.cleanupError, null);
  await waitFor(() => !alive(pid));
});
test('normal leader exit still cleans a descendant holding stdout open', async t => {
  const directory = workspace(t), result = await run(directory, ['/bin/sh', '-c', '/bin/sleep 60 & printf "%s" "$!" > child.pid; printf done']);
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'done'); assert.equal(result.cleanupError, null);
  await waitFor(() => !alive(Number(readFileSync(join(directory, 'child.pid'), 'utf8'))));
});
test('caller SIGKILL closes its private pipe and the C watchdog kills the target group', { timeout: 10_000 }, async t => {
  const directory = workspace(t), marker = join(directory, 'target.pid');
  const moduleUrl = new URL('../src/native/local-process.mjs', import.meta.url).href;
  const code = `import {runBoundedProcess,buildScriptEnvironment} from ${JSON.stringify(moduleUrl)};
    await runBoundedProcess({cwd:${JSON.stringify(directory)},argv:['/bin/sh','-c','printf "%s" "$$" > target.pid; exec /bin/sleep 60'],env:buildScriptEnvironment(process.env)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: join(directory, 'no-programs') }, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waitFor(() => readPid(marker) !== null); const target = readPid(marker);
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  await waitFor(() => !alive(target));
});
test('already canceled calls and malformed input never spawn a process', async t => {
  const controller = new AbortController(); controller.abort(Error('canceled before launch'));
  await assert.rejects(run(workspace(t), ['/bin/true'], { signal: controller.signal, onSpawn: () => assert.fail() }), /canceled before launch/);
  await assert.rejects(run(workspace(t), ['/bin/true'], { env: { PATH: 'x\0bad' } }), { code: 'invalid_local_process_environment' });
});
test('a copied package refuses mismatched sources and modified executables before spawn', async t => {
  const directory = workspace(t), origin = new URL('../src/native/', import.meta.url);
  for (const filename of ['local-process.mjs', 'local-process-launcher.c', 'local-process-manifest.json', 'local-process-bin'])
    cpSync(new URL(filename, origin), join(directory, filename), { recursive: true });
  const standalone = await import(pathToFileURL(join(directory, 'local-process.mjs')).href);
  assert.ok(standalone.resolveLocalProcessLauncher());
  const source = join(directory, 'local-process-launcher.c'), original = readFileSync(source); writeFileSync(source, 'changed');
  assert.throws(() => standalone.resolveLocalProcessLauncher(), { code: 'local_process_source_digest_mismatch' }); writeFileSync(source, original);
  writeFileSync(join(directory, `local-process-bin/${process.platform}-${process.arch}/launcher`), 'changed');
  assert.throws(() => standalone.resolveLocalProcessLauncher(), { code: 'local_process_launcher_digest_mismatch' });
});
