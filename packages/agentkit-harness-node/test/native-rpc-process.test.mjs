// Subprocess lifecycle and durability tests for the Native RPC entry. These
// spawn the ACTUAL built dist as a child process and drive it over NDJSON stdio
// against a CONTROLLED local openai-chat HTTP fixture. Covers: EOF/SIGTERM
// cleanup, a happy run, cancel-not-blocked concurrency, requestId idempotency
// across a real process restart (SIGKILL + relaunch), and the no-replay
// guarantee for an in-flight write after crash-after-write (via a TEST-ONLY
// launcher that sets crashAfterWrite=true; the published bin never does).
//
// Requires the build: run `node scripts/build-native-node.mjs` first (the
// package `test` script assumes dist is built, same as adapters.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgDir = resolve(here, '..');
const coreDir = resolve(pkgDir, '../agentkit-harness-core');
const distEntry = resolve(pkgDir, 'dist/rpc-entry.mjs');
const crashLauncher = resolve(pkgDir, 'test/fixtures/rpc-crash-launcher.mjs');

// Link core so the dist's external core import resolves (same as adapters.test).
const scopeDir = resolve(pkgDir, 'node_modules/@kingsoftcloud');
const coreLink = resolve(scopeDir, 'agentkit-harness-core');
mkdirSync(scopeDir, { recursive: true });
let linkOk = false;
try { linkOk = realpathSync(coreLink) === coreDir; } catch {}
if (!linkOk) { rmSync(coreLink, { force: true }); symlinkSync(coreDir, coreLink, 'dir'); }

// ---- CONTROLLED openai-chat HTTP fixture (test-only) --------------------------
function toolCall(id, name, args) {
  return { choices: [{ message: { role: 'assistant', content: '', tool_calls:
    [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } };
}
function final(text) {
  return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 } };
}
const HANG = Symbol('hang');
function startFixture(script) {
  let call = 0;
  const server = createServer((req, res) => {
    call += 1;
    const step = script[Math.min(call - 1, script.length - 1)];
    if (step === HANG) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(step));
  });
  return new Promise(rp => server.listen(0, '127.0.0.1', () =>
    rp({ port: server.address().port, close: () => new Promise(r => { server.close(r); server.closeAllConnections(); }), calls: () => call })));
}

const activeProcesses = new Set();
class RpcProc {
  constructor(proc) {
    this.proc = proc;
    activeProcesses.add(this);
    this.waiters = [];
    this.stderr = '';
    this.exitInfo = null;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      buf += d;
      const i = buf.lastIndexOf('\n');
      if (i < 0) return;
      const add = buf.slice(0, i); buf = buf.slice(i + 1);
      for (const line of add.split('\n')) if (line.trim()) this._dispatch(JSON.parse(line));
    });
    proc.stderr.on('data', d => { this.stderr += d; });
    proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      activeProcesses.delete(this);
      for (const w of this.waiters) if (!w.done) { w.done = true; w.reject(new Error(`process exited code=${code} sig=${signal}: ${this.stderr}`)); }
    });
  }
  _dispatch(msg) {
    const w = this.waiters.find(w => w.id === msg.id && !w.done);
    if (w) { w.done = true; w.resolve(msg); }
  }
  request(req, timeoutMs = 30000) {
    return new Promise((resolveP, reject) => {
      const w = { id: req.id, done: false, resolve: resolveP, reject };
      this.waiters.push(w);
      const timer = setTimeout(() => { if (!w.done) { w.done = true; reject(new Error('request timeout')); } }, timeoutMs);
      const orig = w.resolve;
      w.resolve = m => { clearTimeout(timer); orig(m); };
      this.proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  close() { this.proc.stdin.end(); }
  kill(sig) { this.proc.kill(sig); }
  waitForExit(timeoutMs = 5000) {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('process did not exit')), timeoutMs);
      this.proc.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
    });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withFixture(script, fn) {
  const fixture = await startFixture(script);
  try { await fn(fixture); } finally {
    for (const rpc of activeProcesses) { rpc.kill('SIGKILL'); await rpc.waitForExit(); }
    await fixture.close();
  }
}

function envFor(port) {
  return {
    ...process.env,
    NATIVE_MODEL_PROTOCOL: 'openai-chat', NATIVE_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
    NATIVE_MODEL_API_KEY: 'test-key', NATIVE_MODEL_NAME: 'test-model',
    NATIVE_MODEL_COMPAT: 'controlled/v1', NATIVE_MODEL_MAX_TOKENS: '256',
    NATIVE_MODEL_REQUEST_TIMEOUT_MS: '3000',
  };
}

function spawnRpc({ dir, workspace, port, maxModelCalls = 8, leaseMs = 1000, launcher = distEntry }) {
  const args = ['--db', join(dir, 'run.sqlite'), '--ledger', join(dir, 'ledger.sqlite'), '--workspace', workspace,
    '--permissions', 'workspace:read,workspace:write',
    '--lease-ms', String(leaseMs), '--effect-timeout-ms', '8000', '--request-timeout-ms', '3000',
    '--max-model-calls', String(maxModelCalls), '--exec-log', join(workspace, '.native-exec.log')];
  const proc = spawn(process.execPath, [launcher, ...args], { env: envFor(port), stdio: ['pipe', 'pipe', 'pipe'] });
  return new RpcProc(proc);
}

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-proc-'));
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'note.txt'), 'hello from note.txt', 'utf8');
  return { dir, workspace, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function pollStatus(rpc, runId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await rpc.request({ jsonrpc: '2.0', id: `poll-${Math.random()}`, method: 'task/status', params: { runId } });
    if (res.error) throw new Error(`status error: ${JSON.stringify(res.error)}`);
    if (predicate(res.result)) return res.result;
    await sleep(50);
  }
  throw new Error(`timed out waiting for run ${runId}`);
}
const isTerminal = r => r.terminal;

// ---- lifecycle: EOF closes the process cleanly -------------------------------
test('closing stdin (EOF) lets the process exit with code 0', async () => {
  await withFixture([final('done')], async (fixture) => {
    const { dir, workspace, cleanup } = makeDir();
    try {
      const rpc = spawnRpc({ dir, workspace, port: fixture.port });
      const init = await rpc.request({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      assert.equal(init.result.protocolVersion, 'agentkit.native-rpc/v1');
      rpc.close();
      const exit = await rpc.waitForExit();
      assert.equal(exit.code, 0);
    } finally { cleanup(); }
  });
});

// ---- lifecycle: SIGTERM triggers clean shutdown ------------------------------
test('SIGTERM triggers clean shutdown with code 0', async () => {
  await withFixture([final('done')], async (fixture) => {
    const { dir, workspace, cleanup } = makeDir();
    try {
      const rpc = spawnRpc({ dir, workspace, port: fixture.port });
      await rpc.request({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      rpc.kill('SIGTERM');
      const exit = await rpc.waitForExit();
      assert.equal(exit.code, 0);
    } finally { cleanup(); }
  });
});

// ---- happy run over stdio ---------------------------------------------------
test('a happy run completes over stdio and writes the file', async () => {
  const script = [toolCall('c1', 'read', { path: 'note.txt' }), toolCall('c2', 'write', { path: 'out.txt', content: 'written by rpc proc' }), final('done')];
  await withFixture(script, async (fixture) => {
    const { dir, workspace, cleanup } = makeDir();
    try {
      const rpc = spawnRpc({ dir, workspace, port: fixture.port });
      const submit = await rpc.request({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
        params: { requestId: 'happy-1', objective: 'Read then write then finish.' } });
      assert.equal(submit.result.status, 'accepted');
      const r = await pollStatus(rpc, submit.result.runId, isTerminal);
      assert.equal(r.phase, 'completed');
      assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'written by rpc proc');
      rpc.close();
      await rpc.waitForExit();
    } finally { cleanup(); }
  });
});

// ---- concurrency: cancel and status do not block on a long task --------------
test('cancel and status respond while a long model call is in flight', async () => {
  await withFixture([HANG], async (fixture) => {
    const { dir, workspace, cleanup } = makeDir();
    try {
      const rpc = spawnRpc({ dir, workspace, port: fixture.port });
      const submit = await rpc.request({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
        params: { requestId: 'hang-1', objective: 'hang' } });
      await pollStatus(rpc, submit.result.runId, r => r.driving, 3000);
      const t0 = Date.now();
      const status = await rpc.request({ jsonrpc: '2.0', id: 's1', method: 'task/status', params: { runId: submit.result.runId } });
      assert.ok(Date.now() - t0 < 2000, 'status must not be blocked by the long task');
      assert.equal(status.result.driving, true);
      const t1 = Date.now();
      const cancel = await rpc.request({ jsonrpc: '2.0', id: 'c1', method: 'task/cancel',
        params: { runId: submit.result.runId, commandId: 'cancel-1' } });
      assert.ok(Date.now() - t1 < 2000, 'cancel must not be blocked by the long task');
      assert.ok(['accepted', 'duplicate'].includes(cancel.result.status));
      const r = await pollStatus(rpc, submit.result.runId, isTerminal);
      assert.equal(r.phase, 'canceled');
      rpc.close();
      await rpc.waitForExit();
    } finally { cleanup(); }
  });
});

// ---- requestId idempotency across a real process restart ---------------------
test('a retried requestId after a restart does NOT re-run the task', async () => {
  await withFixture([HANG], async (fixture) => {
    const { dir, workspace, cleanup } = makeDir();
    try {
      // Process A: submit, the model hangs; SIGKILL A while the run is in flight.
      const a = spawnRpc({ dir, workspace, port: fixture.port });
      const submit = await a.request({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
        params: { requestId: 'restart-1', objective: 'hang and get killed' } });
      await pollStatus(a, submit.result.runId, r => r.driving, 3000);
      const deadline = Date.now() + 3000;
      while (!fixture.calls() && Date.now() < deadline) await sleep(20);
      assert.equal(fixture.calls(), 1, 'process A made one model call');
      a.kill('SIGKILL');
      await a.waitForExit();
      await sleep(1200); // wait past leaseMs so the crashed lease expires before B acquires.
      // Process B reopens the same db+ledger and re-submits the same business requestId.
      const b = spawnRpc({ dir, workspace, port: fixture.port });
      const resubmit = await b.request({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
        params: { requestId: 'restart-1', objective: 'hang and get killed' } });
      assert.ok(['pending', 'completed'].includes(resubmit.result.status), `re-submit must not re-run: ${resubmit.result.status}`);
      assert.equal(fixture.calls(), 1, 'the re-submit must not call the model again (no replay)');
      await b.request({ jsonrpc: '2.0', id: 'res1', method: 'task/resume', params: { runId: submit.result.runId } });
      const r = await pollStatus(b, submit.result.runId, isTerminal);
      assert.equal(r.phase, 'interrupted');
      assert.equal(r.reason, 'recovery_retry_exhausted', 'the inference recovery budget is zero');
      assert.equal(fixture.calls(), 1, 'recovery must not call the model');
      b.close();
      await b.waitForExit();
    } finally { cleanup(); }
  });
});

// ---- no-replay of an in-flight write after crash-after-write ------------------
test('a crashed write is recovered as unknown and never replayed', async () => {
  const script = [toolCall('c1', 'write', { path: 'out.txt', content: 'written before crash' })];
  await withFixture(script, async (fixture) => {
    const { dir, workspace, cleanup } = makeDir();
    try {
      // Process A uses the TEST-ONLY launcher (crashAfterWrite=true); the
      // published bin never sets this.
      const a = spawnRpc({ dir, workspace, port: fixture.port, launcher: crashLauncher });
      const submit = await a.request({ jsonrpc: '2.0', id: 'req-1', method: 'task/submit',
        params: { requestId: 'crash-1', objective: 'write then crash' } });
      const exit = await a.waitForExit();
      assert.equal(exit.code, 7, 'process A must crash with code 7');
      assert.ok(existsSync(join(workspace, 'out.txt')), 'process A must have written out.txt before crashing');
      let execLog = readFileSync(join(workspace, '.native-exec.log'), 'utf8');
      let writes = execLog.trim().split('\n').filter(Boolean).filter(l => JSON.parse(l).name === 'write').length;
      assert.equal(writes, 1, 'process A logged exactly one write');
      assert.equal(fixture.calls(), 1);
      await sleep(1200);
      // Process B uses the real bin to resume (no crash injection).
      const b = spawnRpc({ dir, workspace, port: fixture.port });
      await b.request({ jsonrpc: '2.0', id: 'res1', method: 'task/resume', params: { runId: submit.result.runId } });
      const r = await pollStatus(b, submit.result.runId, isTerminal);
      assert.equal(r.phase, 'interrupted');
      assert.equal(r.reason, 'effect_outcome_unknown');
      execLog = readFileSync(join(workspace, '.native-exec.log'), 'utf8');
      writes = execLog.trim().split('\n').filter(Boolean).filter(l => JSON.parse(l).name === 'write').length;
      assert.equal(writes, 1, 'resume must not append a second write');
      assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'written before crash');
      assert.equal(fixture.calls(), 1, 'resume must not call the model');
      b.close();
      await b.waitForExit();
    } finally { cleanup(); }
  });
});
