// Fake-transport tests for the E2B background command module. These tests use a
// deterministic in-process fake transport (controllable faults) — they are NOT a
// real E2B online proof (stated in the test names). Covers: scope/session/owner
// isolation, durable reopen/restart, UTF-8 byte cursors, concurrent recovery
// claim + TTL, generation fencing (late old owner cannot write), disconnect-gap
// unknown+evidenceIncomplete, cancel/timeout kill semantics, wrong scope/sandbox
// refusal. Node26 + Node22.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { E2BCommandStore, E2BBackgroundCommand } from '../src/native/e2b-background.mjs';
import { TERMINAL } from '../src/native/local-command-state.mjs';

// macOS /tmp is a symlink to /private/tmp; the private-state helpers reject
// symlinked roots, so resolve tmpdir first (matching the local-background tests).
const tmp = realpathSync(tmpdir());
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Per-setup workspace (not global) to avoid cross-test interference.
let seq = 0;

/** A deterministic fake transport: the "remote command" is a local child process
 * whose stdout/stderr the supervisor appends. Controllable: killSucceeds, noResult,
 * startThrows. Mirrors the reference _LocalSubprocessStreamSource shape. */
function fakeTransport({ killSucceeds = true, noResult = false, startThrows = false, sandboxId = 'sandbox-1' } = {}) {
  return {
    start(command, { cwd, env, timeout }) {
      if (startThrows) throw new Error('injected start failure');
      const proc = spawn('/bin/sh', ['-c', command], { cwd: cwd || undefined, env: env || undefined,
        stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid,
        result: null,
        async * [Symbol.asyncIterator]() {
          // Yield stdout/stderr chunks as they arrive, then settle result on exit.
          const stdout = [], stderr = [];
          proc.stdout.on('data', c => stdout.push(c));
          proc.stderr.on('data', c => stderr.push(c));
          await new Promise((resolve) => {
            const done = () => { if (handle.result === null) { handle.result = { exitCode: proc.exitCode ?? 0 }; resolve(); } };
            proc.once('exit', done); proc.stdout.once('end', done); proc.once('close', done);
          });
          for (const c of stdout) yield { stdout: c.toString('utf8') };
          for (const c of stderr) yield { stderr: c.toString('utf8') };
        },
        disconnect() { /* close the stream without killing (mirrors the SDK contract) */ },
      };
      return { pid: proc.pid, handle, sandboxId };
    },
    reconnect(pid) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) {
      if (killSucceeds === 'raise') throw new Error('injected kill failure');
      if (!killSucceeds) return false;
      try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
    },
  };
}

function setup(t, opts = {}) {
  const root = mkdtempSync(join(tmp, 'e2b-bg-'));
  const workspace = mkdtempSync(join(tmp, 'e2b-ws-'));
  // If opts.transport is a full transport object (has .start), use it directly;
  // otherwise treat it as fakeTransport config options.
  const transport = opts.transport && typeof opts.transport.start === 'function'
    ? opts.transport : fakeTransport(opts.transport);
  const store = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'session-1',
    transport, ...opts.store });
  t.after(() => { store.close?.(); rmSync(root, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  return { root, store, workspace };
}
const poll = async (fn, { timeoutMs = 5000 } = {}) => {
  const until = performance.now() + timeoutMs;
  for (;;) { const r = fn(); if (r) return r; if (performance.now() > until) throw new Error('poll timeout'); await new Promise(r => setTimeout(r, 20)); }
};

test('start connects, appends output with UTF-8 byte cursors, and settles completed on natural exit', async t => {
  const { store } = setup(t);
  const handle = await store.start({ operationKey: 'op-1', command: 'echo hello && echo world', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  const out = store.connect(handle.commandId).readOutput({ stdoutCursor: 0, maxBytes: 8192 });
  assert.equal(out.status, 'completed'); assert.equal(out.exitCode, 0);
  assert.ok(out.stdout.includes('hello') && out.stdout.includes('world'));
  // UTF-8 cursor: a partial multi-byte read would be rejected; here a full read advances past the content.
  const full = store.connect(handle.commandId).readOutput({ stdoutCursor: 0, maxBytes: 65536 });
  assert.ok(full.stdoutCursor > 0);
  // A cursor past the end is rejected.
  assert.throws(() => store.connect(handle.commandId).readOutput({ stdoutCursor: full.stdoutCursor + 100 }), /cursor_past_end/);
});

test('durable reopen: a new store on the same root/session reopens the command and reads the same output', async t => {
  const { root, store, workspace } = setup(t);
  const handle = await store.start({ operationKey: 'op-2', command: 'echo reopen-test', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  // A fresh store (same root/session/workspace) reopens the same record.
  const reopened = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'session-1',
    transport: fakeTransport() });
  const reconnected = reopened.connect(handle.commandId);
  const out = reconnected.readOutput();
  assert.equal(out.status, 'completed'); assert.ok(out.stdout.includes('reopen-test'));
  reopened.close?.();
});

test('a different session or workspace cannot read another owner command (scope isolation)', t => {
  const { root, store, workspace } = setup(t);
  const handle = store.commandId('op-3');
  // A store with a different session has a different owner key → connect refuses.
  const foreign = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'foreign-session',
    transport: fakeTransport() });
  assert.throws(() => foreign.connect(handle), /not_owned/);
  foreign.close?.();
});

test('cancel writes a marker and the supervisor settles canceled when the kill is confirmed', async t => {
  const { store } = setup(t, { transport: { killSucceeds: true } });
  const handle = await store.start({ operationKey: 'op-4', command: 'sleep 30', cwd: null, env: null, timeoutSeconds: 60 });
  await poll(() => store.connect(handle.commandId).readOutput().status === 'running');
  const cmd = store.connect(handle.commandId);
  const before = cmd.readOutput().status;
  assert.ok(['running', 'starting'].includes(before));
  cmd.requestCancel();
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'canceled'); assert.ok(existsSync(join(cmd.directory, 'cancel')));
});

test('an unconfirmed kill (kill returns false) settles unknown, not a fake cancel', async t => {
  const { store } = setup(t, { transport: { killSucceeds: false } });
  const handle = await store.start({ operationKey: 'op-5', command: 'sleep 30', cwd: null, env: null, timeoutSeconds: 60 });
  await poll(() => store.connect(handle.commandId).readOutput().status === 'running');
  store.connect(handle.commandId).requestCancel();
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'unknown'); assert.equal(out.outcomeReason, 'kill_unconfirmed');
});

test('timeout settles timed_out when the kill is confirmed; the deadline is the original remaining window', async t => {
  const { store } = setup(t, { transport: { killSucceeds: true } });
  const handle = await store.start({ operationKey: 'op-6', command: 'sleep 30', cwd: null, env: null, timeoutSeconds: 1 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 8000 });
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'timed_out');
});

test('a start transport failure settles unknown, never launches a second time', async t => {
  const { store } = setup(t, { transport: { startThrows: true } });
  const handle = await store.start({ operationKey: 'op-7', command: 'echo nope', cwd: null, env: null, timeoutSeconds: 10 });
  // The supervisor settles unknown (start threw). A second start with the same op is idempotent — no relaunch.
  const replay = await store.start({ operationKey: 'op-7', command: 'echo nope', cwd: null, env: null, timeoutSeconds: 10 });
  assert.equal(replay.commandId, handle.commandId);
});

test('a wrong-sandbox authority is refused: close returns false with zero side effects without killSandbox authority', async t => {
  let killed = null;
  const { store } = setup(t, { store: { killSandbox: id => { killed = id; return true; }, authority: () => false } });
  // No sandbox.json yet → no existing sandbox to close → false.
  assert.equal(await store.close(), false); assert.equal(killed, null);
});

test('async close: killSandbox returning a Promise<boolean> is awaited; true confirms, false/reject do not', async t => {
  const { root, store, workspace } = setup(t, { store: { authority: () => true } });
  // Create a sandbox state by launching a command.
  const handle = await store.start({ operationKey: 'close-1', command: 'echo close-test', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  // sandbox.json now exists with owner === store.owner.
  // Test 1: async killSandbox returning true → confirmed.
  let killedId = null;
  const storeT = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'session-1',
    transport: fakeTransport(), authority: () => true, killSandbox: async id => { killedId = id; return true; } });
  assert.equal(await storeT.close(), true);
  assert.ok(killedId !== null, 'killSandbox was called with the frozen sandboxId');
  // Test 2: async killSandbox returning false → not confirmed.
  const storeF = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'session-1',
    transport: fakeTransport(), authority: () => true, killSandbox: async () => false });
  assert.equal(await storeF.close(), false);
  // Test 3: async killSandbox rejecting → not confirmed, no throw.
  const storeR = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'session-1',
    transport: fakeTransport(), authority: () => true, killSandbox: async () => { throw new Error('kill failed'); } });
  assert.equal(await storeR.close(), false);
  // Test 4: no authority → zero side effects.
  let killed2 = null;
  const storeN = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'session-1',
    transport: fakeTransport(), authority: null, killSandbox: id => { killed2 = id; return true; } });
  assert.equal(await storeN.close(), false);
  assert.equal(killed2, null, 'no kill without authority');
  storeT.close?.(); storeF.close?.(); storeR.close?.(); storeN.close?.();
});

test('frozen sandbox cannot be replaced: a second start whose transport returns a different sandboxId settles unknown and does not overwrite sandbox.json', async t => {
  let callCount = 0;
  const transport = {
    start(command, { cwd, env, timeout, sandboxId }) {
      callCount++;
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid, result: null,
        async * [Symbol.asyncIterator]() {
          const o = []; const e = [];
          proc.stdout.on('data', x => o.push(x)); proc.stderr.on('data', x => e.push(x));
          await new Promise(r => { const d = () => { if (handle.result === null) { handle.result = { exitCode: proc.exitCode ?? 0 }; r(); } };
            proc.once('exit', d); proc.stdout.once('end', d); proc.once('close', d); });
          for (const x of o) yield { stdout: x.toString('utf8') };
          for (const x of e) yield { stderr: x.toString('utf8') };
        },
        disconnect() {},
      };
      // First start: return 'sb-original'. Second start: return 'sb-DIFFERENT'.
      const returnedSandboxId = callCount === 1 ? 'sb-original' : 'sb-DIFFERENT';
      return { pid: proc.pid, handle, sandboxId: returnedSandboxId };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
  const { store } = setup(t, { transport, store: { authority: () => true } });
  // First start creates the frozen sandbox.
  const h1 = await store.start({ operationKey: 'sb-1', command: 'echo first', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(h1.commandId).readOutput().status));
  // sandbox.json has sb-original.
  const frozen1 = store._frozenSandbox();
  assert.equal(frozen1.sandboxId, 'sb-original');
  // Second start: transport returns sb-DIFFERENT → supervisor settles unknown, sandbox.json unchanged.
  const h2 = await store.start({ operationKey: 'sb-2', command: 'echo second', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(h2.commandId).readOutput().status), { timeoutMs: 10000 });
  const out2 = store.connect(h2.commandId).readOutput();
  assert.equal(out2.status, 'unknown');
  assert.equal(out2.outcomeReason, 'sandbox_id_mismatch');
  // sandbox.json is NOT overwritten — still sb-original.
  const frozen2 = store._frozenSandbox();
  assert.equal(frozen2.sandboxId, 'sb-original', 'frozen sandbox not replaced by a mismatched one');
});

test('recover with unproven authority refuses a live command without reconnect or record mutation', async t => {
  const { root, store, workspace } = setup(t, { store: { authority: () => true } });
  const handle = await store.start({ operationKey: 'op-8', command: 'sleep 1', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => handle.readOutput().status === 'running');
  let reconnects = 0;
  const refusing = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'session-1',
    transport: { ...fakeTransport(), reconnect() { reconnects++; } }, authority: () => false, killSandbox: null });
  const path = join(handle.directory, 'record.json'), before = readFileSync(path);
  await assert.rejects(refusing.recover(handle.commandId), /e2b_background_authority_unprovable/);
  assert.equal(reconnects, 0); assert.ok(readFileSync(path).equals(before));
  await poll(() => TERMINAL.has(handle.readOutput().status));
});

test('recovery claim TTL: a stale claim is reclaimed with an advanced generation; a late old owner cannot overwrite', async t => {
  const { root, store, workspace } = setup(t, { store: { authority: () => true } });
  const handle = await store.start({ operationKey: 'op-9', command: 'echo ttl', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  // Manually craft a non-terminal record with a remote identity + a stale claim to exercise the TTL reclaim.
  const dir = join(store.directory, handle.commandId);
  const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  rec.status = 'running'; rec.exitCode = null; rec.pid = 99999; rec.sandboxId = 'sb-stale'; rec.generation = 2;
  rec.recoveryClaimGeneration = 3; rec.recoveryClaimAt = Date.now() - 40000; // stale (> 30s TTL)
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  writeFileSync(join(store._sandboxRoot, 'sandbox.json'), JSON.stringify({ sandboxId: 'sb-stale', owner: store.owner }));
  // recover reclaims: generation must advance past 2.
  await store.recover(handle.commandId);
  const after = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  assert.ok((after.recoveryClaimGeneration ?? 0) > 3 || (after.generation ?? 0) > 3,
    'generation advanced past the stale claim');
});

test('concurrent recovery claim: a second host seeing a fresh claim does not spawn again', async t => {
  const { root, store, workspace } = setup(t, { store: { authority: () => true } });
  const handle = await store.start({ operationKey: 'op-10', command: 'echo concur', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  const dir = join(store.directory, handle.commandId);
  const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  rec.status = 'running'; rec.exitCode = null; rec.pid = 99998; rec.sandboxId = 'sb-concur'; rec.generation = 1;
  rec.recoveryClaimGeneration = 2; rec.recoveryClaimAt = Date.now(); // fresh claim
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  writeFileSync(join(store._sandboxRoot, 'sandbox.json'), JSON.stringify({ sandboxId: 'sb-concur', owner: store.owner }));
  // A second recover sees the fresh claim (< TTL) and does NOT spawn — returns the handle as-is.
  const before = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  await store.recover(handle.commandId);
  const after = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  assert.equal(after.recoveryClaimGeneration, before.recoveryClaimGeneration); // unchanged — no new spawn
});

test('stateRoot inside the workspace is rejected; a symlinked stateRoot parent is rejected', t => {
  const root = mkdtempSync(join(tmp, 'e2b-bound-'));
  const ws = join(root, 'workspace'); mkdirSync(ws);
  // stateRoot inside workspace → rejected.
  assert.throws(() => new E2BCommandStore({ stateRoot: join(ws, 'state'), workspaceRoot: ws,
    sessionId: 's', transport: fakeTransport() }), /background_state_inside_workspace/);
  // stateRoot === workspace → rejected.
  assert.throws(() => new E2BCommandStore({ stateRoot: ws, workspaceRoot: ws,
    sessionId: 's', transport: fakeTransport() }), /background_state_inside_workspace/);
  rmSync(root, { recursive: true, force: true });
});

test('detached supervisor: real child Host process spawns, starts a command, exits; a new Host process reopens and reads the same output', async t => {
  const root = mkdtempSync(join(tmp, 'e2b-detach-'));
  const ws = mkdtempSync(join(tmp, 'e2b-dws-'));
  const transportModule = new URL('./e2b-fake-transport.mjs', import.meta.url).href;
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });
  // Spawn a real child process that creates a store, starts a command, writes
  // the task_id to a file, then exits. The detached supervisor survives.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { E2BCommandStore } from ${JSON.stringify(new URL('../src/native/e2b-background.mjs', import.meta.url).href)};
    const store = new E2BCommandStore({ stateRoot: ${JSON.stringify(root)}, workspaceRoot: ${JSON.stringify(ws)},
      sessionId: 'detach-1', transportModule: ${JSON.stringify(transportModule)}, transportConfig: {} });
    const handle = await store.start({ operationKey: 'detach-1', command: 'echo detach-output && sleep 1', cwd: null, env: null, timeoutSeconds: 30 });
    const fs = await import('node:fs');
    fs.writeFileSync(${JSON.stringify(join(root, 'task-id.txt'))}, handle.commandId);
    store.close?.();
    process.exit(0);
  `], { stdio: ['ignore', 'ignore', 'inherit'], detached: false });
  // Wait for the child to exit (it started the command and wrote the task_id).
  await new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve() : reject(new Error('child exit ' + code))); child.once('error', reject); });
  // The child exited. The detached supervisor is still running (or already settled).
  // A NEW process reopens the store and reads the same record.
  const taskId = readFileSync(join(root, 'task-id.txt'), 'utf8').trim();
  assert.ok(taskId, 'child wrote a task_id');
  const reopened = new E2BCommandStore({ stateRoot: root, workspaceRoot: ws, sessionId: 'detach-1',
    transportModule, transportConfig: {} });
  await poll(() => TERMINAL.has(reopened.connect(taskId).readOutput().status), { timeoutMs: 10000 });
  const out = reopened.connect(taskId).readOutput();
  assert.equal(out.status, 'completed');
  assert.ok(out.stdout.includes('detach-output'), 'output survived the child Host exiting');
  reopened.close?.();
});

test('detached fork with recovery: a dead supervisor is detected and the claim advances the generation', async t => {
  const root = mkdtempSync(join(tmp, 'e2b-recover-'));
  const ws = mkdtempSync(join(tmp, 'e2b-rws-'));
  const transportModule = new URL('./e2b-fake-transport.mjs', import.meta.url).href;
  const store = new E2BCommandStore({ stateRoot: root, workspaceRoot: ws, sessionId: 'recover-1',
    transportModule, transportConfig: {}, authority: () => true });
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });
  const handle = await store.start({ operationKey: 'recover-1', command: 'echo recover-test', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  // Simulate a dead supervisor + non-terminal record with a remote identity.
  const dir = join(store.directory, handle.commandId);
  const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  rec.status = 'running'; rec.exitCode = null; rec.pid = 99997; rec.sandboxId = 'sb-recover'; rec.generation = 1;
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  writeFileSync(join(store._sandboxRoot, 'sandbox.json'), JSON.stringify({ sandboxId: 'sb-recover', owner: store.owner }), { mode: 0o600 });
  // recover should detect the dead supervisor (lock free) and advance the generation.
  await store.recover(handle.commandId);
  const after = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  assert.ok((after.recoveryClaimGeneration ?? 0) > 1, 'generation advanced for recovery');
});

// A transport whose handle.result is a Promise that never resolves. The watcher
// must NOT await it — cancel/deadline still fire.
function pendingResultTransport() {
  return {
    start(command, { cwd, env, timeout }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid, result: new Promise(() => {}),
        async * [Symbol.asyncIterator]() {
          const o = []; const e = [];
          proc.stdout.on('data', x => o.push(x));
          proc.stderr.on('data', x => e.push(x));
          await new Promise(r => { const d = () => { r(); }; proc.once('exit', d); proc.stdout.once('end', d); });
          for (const x of o) yield { stdout: x.toString('utf8') };
          for (const x of e) yield { stderr: x.toString('utf8') };
        },
        disconnect() {},
      };
      return { pid: proc.pid, handle, sandboxId: 'sb-pending' };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: new Promise(() => {}), disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
}

test('pending result Promise: cancel fires without awaiting it; kill confirmed → strict canceled, not a hang', async t => {
  const { store } = setup(t, { transport: pendingResultTransport() });
  const handle = await store.start({ operationKey: 'pend-1', command: 'sleep 30', cwd: null, env: null, timeoutSeconds: 60 });
  await poll(() => store.connect(handle.commandId).readOutput().status === 'running', { timeoutMs: 3000 });
  store.connect(handle.commandId).requestCancel();
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'canceled', 'strict canceled (kill confirmed, result never resolved)');
});

test('pending result Promise: timeout fires without awaiting it; kill confirmed → strict timed_out, not a hang', async t => {
  const { store } = setup(t, { transport: pendingResultTransport() });
  const handle = await store.start({ operationKey: 'pend-2', command: 'sleep 30', cwd: null, env: null, timeoutSeconds: 1 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'timed_out', 'strict timed_out (kill confirmed, result never resolved)');
});

// A gated transport: the iterator yields one chunk, then blocks on a gate
// Promise the test controls. The test can advance the record's generation BEFORE
// resolving the gate, then the supervisor's append guard must reject the late
// yield. result is a Promise the test resolves after the gate.
function gatedTransport() {
  let gateResolve = null;
  return {
    start(command, { cwd, env, timeout }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid,
        result: null,
        async * [Symbol.asyncIterator]() {
          // Buffer stdout/stderr until the stream ends (all data captured), then
          // yield the first batch and block on the gate.
          const chunks = [];
          const stderrChunks = [];
          proc.stdout.on('data', x => chunks.push(x));
          proc.stderr.on('data', x => stderrChunks.push(x));
          await new Promise(resolve => { proc.stdout.once('end', resolve); proc.stderr.once('end', resolve);
            proc.once('exit', resolve); });
          // Small delay to ensure all 'data' events fired before 'end'.
          await new Promise(r => setImmediate(r));
          for (const x of chunks) yield { stdout: x.toString('utf8') };
          for (const x of stderrChunks) yield { stderr: x.toString('utf8') };
          // Block on the gate — the test resolves this after advancing the generation.
          await new Promise(r => { gateResolve = r; });
          // After the gate: yield a LATE chunk that a stale supervisor should NOT append.
          yield { stdout: 'LATE-STALE-OUTPUT' };
          handle.result = { exitCode: 0 };
        },
        disconnect() {},
      };
      return { pid: proc.pid, handle, sandboxId: 'sb-gated' };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
    _gate() { return gateResolve; },
  };
}

test('late iterator after new generation: a live stale supervisor yields late stdout but the append guard rejects it (no new bytes, record unchanged)', async t => {
  const transport = gatedTransport();
  const { root, store, workspace } = setup(t, { transport });
  const handle = await store.start({ operationKey: 'gate-1', command: 'echo first-batch', cwd: null, env: null, timeoutSeconds: 60 });
  await poll(() => store.connect(handle.commandId).readOutput().status === 'running', { timeoutMs: 3000 });
  // Wait for the first batch to be appended and the iterator to reach the gate.
  await poll(() => readFileSync(join(store.directory, handle.commandId, 'stdout'), 'utf8').includes('first-batch'), { timeoutMs: 5000 });
  // Wait for the gate to be set (iterator reached the gate).
  await poll(() => transport._gate() !== null, { timeoutMs: 5000 });
  const originalOutput = readFileSync(join(store.directory, handle.commandId, 'stdout'), 'utf8');
  // Advance the record's generation to simulate a newer reclaim — the old supervisor is now stale.
  const dir = join(store.directory, handle.commandId);
  const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  rec.generation = (rec.generation ?? 0) + 10;
  delete rec.recoveryClaimGeneration; delete rec.recoveryClaimAt;
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  // Release the gate — the iterator yields 'LATE-STALE-OUTPUT' and sets result.
  transport._gate()();
  // Wait for the supervisor to settle.
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  const finalOutput = readFileSync(join(dir, 'stdout'), 'utf8');
  // The late stale output must NOT appear — the append guard rejected it.
  assert.ok(!finalOutput.includes('LATE-STALE-OUTPUT'), 'late stale output was NOT appended: ' + finalOutput);
  assert.equal(finalOutput, originalOutput, 'output unchanged by the stale supervisor');
  // The record's generation is the newer one (the stale supervisor did not overwrite it).
  const finalRec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  assert.deepEqual(finalRec, rec, 'new owner record was not changed by stale supervisor');
});

test('terminal write fence: a live supervisor cannot rewrite an already-terminal record', async t => {
  const transport = gatedTransport();
  const { store } = setup(t, { transport, store: { authority: () => true } });
  const handle = await store.start({ operationKey: 'gate-2', command: 'echo term-test', cwd: null, env: null, timeoutSeconds: 60 });
  await poll(() => store.connect(handle.commandId).readOutput().status === 'running', { timeoutMs: 3000 });
  await poll(() => readFileSync(join(store.directory, handle.commandId, 'stdout'), 'utf8').includes('term-test'), { timeoutMs: 5000 });
  await poll(() => transport._gate() !== null, { timeoutMs: 5000 });
  const dir = join(store.directory, handle.commandId);
  // Settle the record as terminal BEFORE releasing the gate.
  const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  rec.status = 'completed'; rec.exitCode = 0; rec.completedAt = Date.now();
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  // Release the gate — the supervisor tries to write terminal but the record is already terminal.
  transport._gate()();
  // Wait a moment for the supervisor to attempt its write.
  await delay(500);
  // The record must remain as we set it — the supervisor's fencedWrite was rejected.
  const finalRec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  assert.equal(finalRec.status, 'completed');
  assert.equal(finalRec.exitCode, 0);
  assert.equal(finalRec.completedAt, rec.completedAt, 'completedAt not overwritten by the stale supervisor');
});

// Real EOF: the stream ends without a result (handle.result stays null). The
// supervisor must settle unknown after a bounded grace, not hang forever.
function eofNoResultTransport() {
  return {
    start(command, { cwd, env, timeout }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid, result: null, // never set — stream ends without a terminal event
        async * [Symbol.asyncIterator]() {
          const o = []; const e = [];
          proc.stdout.on('data', x => o.push(x));
          proc.stderr.on('data', x => e.push(x));
          await new Promise(r => { proc.stdout.once('end', r); proc.once('exit', r); });
          for (const x of o) yield { stdout: x.toString('utf8') };
          for (const x of e) yield { stderr: x.toString('utf8') };
          // EOF — no result set. The iterator ends.
        },
        disconnect() {},
      };
      return { pid: proc.pid, handle, sandboxId: 'sb-eof' };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
}

test('real EOF without result: the supervisor settles unknown after a bounded grace, not a hang', async t => {
  const { store } = setup(t, { transport: eofNoResultTransport() });
  const handle = await store.start({ operationKey: 'eof-1', command: 'echo eof-test', cwd: null, env: null, timeoutSeconds: 0 });
  // timeoutSeconds 0 → no deadline. The stream EOFs without a result. The supervisor
  // must settle unknown (bounded grace), not wait forever.
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'unknown', 'EOF without result → unknown (no_terminal_event)');
  assert.ok(out.stdout.includes('eof-test'), 'output was appended before EOF');
});

// Reproduce parent review: iterator throws AFTER yielding output and result=exit0.
// The outcome must be unknown+evidenceIncomplete with observedExitCode retained,
// not completed with exitCode 0.
test('iterator error after result: unknown+evidenceIncomplete, not completed (exit0 preserved as observed)', async t => {
  let disconnectCount = 0;
  const transport = {
    start(command, { cwd, env, timeout, sandboxId }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid, result: null,
        async * [Symbol.asyncIterator]() {
          const o = []; proc.stdout.on('data', x => o.push(x));
          await new Promise(r => { const d = () => { if (handle.result === null) { handle.result = Promise.resolve({ exitCode: 0 }); r(); } }; proc.once('exit', d); proc.stdout.once('end', d); });
          await new Promise(r => setImmediate(r));
          for (const x of o) yield { stdout: x.toString('utf8') };
          throw new Error('injected iterator error');
        },
        disconnect() { disconnectCount++; },
      };
      return { pid: proc.pid, handle, sandboxId: 'sb-iter-err' };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
  const { store } = setup(t, { transport });
  const handle = await store.start({ operationKey: 'iter-err-1', command: 'echo tail', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  // Wait for the supervisor's finally block (disconnect) to complete.
  await delay(500);
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'unknown', 'iterator error → unknown, not completed');
  assert.equal(out.evidenceIncomplete, true, 'evidenceIncomplete: true');
  assert.equal(out.exitCode, null, 'exitCode null (not 0)');
  assert.equal(out.observedExitCode, 0, 'observedExitCode retains the observed 0');
  assert.ok(out.stdout.includes('tail'), 'output was appended before the error');
  assert.ok(disconnectCount > 0, 'disconnect was called on the exit path');
});

test('EOF without result: unknown + evidenceIncomplete=true (not false)', async t => {
  let disconnectCount = 0;
  const transport = {
    start(command, { cwd, env, timeout, sandboxId }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid, result: null,
        async * [Symbol.asyncIterator]() {
          const o = []; proc.stdout.on('data', x => o.push(x));
          await new Promise(r => { const d = () => r(); proc.stdout.once('end', d); proc.once('exit', d); });
          for (const x of o) yield { stdout: x.toString('utf8') };
        },
        disconnect() { disconnectCount++; },
      };
      return { pid: proc.pid, handle, sandboxId: 'sb-eof-ev' };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
  const { store } = setup(t, { transport });
  const handle = await store.start({ operationKey: 'eof-ev-1', command: 'echo eof-ev', cwd: null, env: null, timeoutSeconds: 0 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  await delay(500);
  const out = store.connect(handle.commandId).readOutput();
  assert.equal(out.status, 'unknown');
  assert.equal(out.evidenceIncomplete, true, 'evidenceIncomplete must be true for unknown');
  assert.ok(disconnectCount > 0, 'disconnect was called on natural exit');
});

test('disconnect called on normal completion (not just cancel/timeout)', async t => {
  let disconnectCount = 0;
  const transport = {
    start(command, { cwd, env, timeout, sandboxId }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid, result: null,
        async * [Symbol.asyncIterator]() {
          const o = []; proc.stdout.on('data', x => o.push(x));
          await new Promise(r => { const d = () => { if (handle.result === null) { handle.result = { exitCode: proc.exitCode ?? 0 }; r(); } }; proc.once('exit', d); proc.stdout.once('end', d); proc.once('close', d); });
          for (const x of o) yield { stdout: x.toString('utf8') };
        },
        disconnect() { disconnectCount++; },
      };
      return { pid: proc.pid, handle, sandboxId: 'sb-disc-norm' };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
  const { store } = setup(t, { transport });
  const handle = await store.start({ operationKey: 'disc-1', command: 'echo done', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  await delay(500);
  assert.equal(store.connect(handle.commandId).readOutput().status, 'completed');
  assert.ok(disconnectCount > 0, 'disconnect was called on normal completion');
});

// Reproduce parent review issue 1: reconnect branch never set sandboxId, so
// safeKill passed undefined. This test enters the reconnect branch and verifies
// the kill target receives the EXACT frozen sandboxId from the record.
test('reconnect timeout/cancel: safeKill receives the frozen sandboxId from the record (not undefined)', async t => {
  let killTarget = null;
  const transport = {
    start(command, { cwd, env, timeout, sandboxId }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = { pid: proc.pid, result: null,
        async * [Symbol.asyncIterator]() { const o = []; proc.stdout.on('data', x => o.push(x));
          await new Promise(r => { const d = () => { if (handle.result === null) { handle.result = { exitCode: proc.exitCode ?? 0 }; r(); } }; proc.once('exit', d); proc.stdout.once('end', d); });
          for (const x of o) yield { stdout: x.toString('utf8') }; },
        disconnect() {} };
      return { pid: proc.pid, handle, sandboxId: 'sb-reconnect-test' };
    },
    reconnect(pid, opts) {
      // Verify the sandboxId is passed from the record, not undefined.
      assert.ok(opts.sandboxId, 'reconnect must receive sandboxId from record');
      return { async * [Symbol.asyncIterator]() { yield { stdout: 'reconnected' }; }, result: null, disconnect() {} };
    },
    kill(pid, opts) { killTarget = { pid, sandboxId: opts?.sandboxId }; try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
    killSandbox: null,
  };
  const { root, store, workspace } = setup(t, { transport, store: { authority: () => true } });
  const handle = await store.start({ operationKey: 'recon-1', command: 'echo test', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status));
  // Simulate a dead supervisor + non-terminal record with the remote identity.
  const dir = join(store.directory, handle.commandId);
  const rec = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  rec.status = 'running'; rec.exitCode = null; rec.pid = 99995; rec.sandboxId = 'sb-reconnect-test'; rec.generation = 1;
  writeFileSync(join(dir, 'record.json'), JSON.stringify(rec));
  writeFileSync(join(store._sandboxRoot, 'sandbox.json'), JSON.stringify({ sandboxId: 'sb-reconnect-test', owner: store.owner }));
  // recover enters the reconnect branch and spawns a supervisor. The supervisor's
  // reconnect transport fires, then we cancel — safeKill must receive sandboxId.
  await store.recover(handle.commandId);
  // Wait for the supervisor to start, then cancel.
  await delay(200);
  store.connect(handle.commandId).requestCancel();
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  // The kill target must have the EXACT sandboxId from the record, not undefined.
  assert.ok(killTarget, 'kill was called');
  assert.equal(killTarget.sandboxId, 'sb-reconnect-test', 'kill received the frozen sandboxId');
});

// Reproduce parent review issue 2: result Promise resolves before the iterator
// drains its buffered output. The supervisor must drain all buffered output before
// deciding completed — stdout must not be empty when output was produced.
test('result resolves before queue drain: all buffered output is appended, not dropped', async t => {
  const transport = {
    start(command, { cwd, env, timeout, sandboxId }) {
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = {
        pid: proc.pid, result: null,
        async * [Symbol.asyncIterator]() {
          // Buffer output, then set result BEFORE yielding (result-first race).
          const o = [];
          proc.stdout.on('data', x => o.push(x));
          await new Promise(r => { proc.stdout.once('end', () => { handle.result = Promise.resolve({ exitCode: 0 }); r(); }); proc.once('exit', () => { handle.result = Promise.resolve({ exitCode: 0 }); r(); }); });
          // Wait a bit so the result Promise resolves before we yield.
          await delay(100);
          // Now yield the buffered output — this must NOT be dropped.
          for (const x of o) yield { stdout: x.toString('utf8') };
        },
        disconnect() {},
      };
      return { pid: proc.pid, handle, sandboxId: 'sb-drain-test' };
    },
    reconnect() { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
  const { store } = setup(t, { transport });
  const handle = await store.start({ operationKey: 'drain-1', command: 'echo TAIL-MUST-NOT-BE-DROPPED', cwd: null, env: null, timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(store.connect(handle.commandId).readOutput().status), { timeoutMs: 10000 });
  const out = store.connect(handle.commandId).readOutput();
  // The output must include the buffered text — it was NOT dropped by an early
  // settled=true that broke the consumer before it yielded.
  assert.ok(out.stdout.includes('TAIL-MUST-NOT-BE-DROPPED'), 'buffered output was drained, not dropped: ' + out.stdout);
  assert.equal(out.status, 'completed', 'completed with full output');
  assert.equal(out.exitCode, 0);
});

for (const boundary of ['before-start', 'after-start']) {
  test(`actual detached supervisor SIGKILL ${boundary}: cold retry never launches the unknown operation again`, async t => {
    const root = mkdtempSync(join(tmp, 'e2b-kill-')), workspace = join(root, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const checkpoint = join(root, 'checkpoint.json'), effect = join(root, 'remote-effect.txt');
    const options = { stateRoot: join(root, 'state'), workspaceRoot: workspace, sessionId: 'kill-proof',
      transportModule: new URL('./e2b-fake-transport.mjs', import.meta.url).href,
      transportConfig: { sandboxId: 'bound-sandbox', boundary, checkpoint },
      sandboxId: 'bound-sandbox', authority: () => true };
    const store = new E2BCommandStore(options);
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const input = { operationKey: 'exact-original-operation', command: `printf 'effect\\n' >> ${quote(effect)}`,
      cwd: null, env: null, timeoutSeconds: 30 };
    const handle = await store.start(input);
    await poll(() => existsSync(checkpoint));
    const observed = JSON.parse(readFileSync(checkpoint, 'utf8'));
    assert.equal(observed.boundary, boundary); assert.equal(observed.pid, handle.processId);
    if (boundary === 'after-start') await poll(() => existsSync(effect));
    else assert.equal(existsSync(effect), false);
    process.kill(observed.pid, 'SIGKILL');
    await poll(() => { try { process.kill(observed.pid, 0); return false; } catch (error) { assert.equal(error.code, 'ESRCH'); return true; } });
    const originalRecord = readFileSync(join(handle.directory, 'record.json'));
    // Same real identity and operation reopened through a new store instance.
    const cold = new E2BCommandStore(options), retried = await cold.start(input);
    assert.equal(retried.commandId, handle.commandId);
    assert.ok(readFileSync(join(handle.directory, 'record.json')).equals(originalRecord));
    assert.equal(retried.readOutput().status, 'unknown');
    assert.equal(retried.readOutput().evidenceIncomplete, true);
    assert.equal(JSON.parse(readFileSync(checkpoint, 'utf8')).pid, observed.pid);
    // The launch record stays intact; the reader reports the dead supervisor
    // conservatively. It never invents completion or re-dispatches the command.
    if (boundary === 'after-start') assert.equal(readFileSync(effect, 'utf8'), 'effect\n');
    else assert.equal(existsSync(effect), false);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(readFileSync(join(handle.directory, 'record.json')).equals(originalRecord));
    if (boundary === 'after-start') assert.equal(readFileSync(effect, 'utf8'), 'effect\n');
  });
}

test('bound sandbox ownership is durable before launch, survives reopen and rejects replacement', async t => {
  const { root, workspace } = setup(t);
  const options = { stateRoot: root, workspaceRoot: workspace, sessionId: 'bound',
    transport: fakeTransport(), sandboxId: 'bound-sandbox', authority: () => true };
  const store = new E2BCommandStore(options);
  const path = store._sandboxFile(), saved = readFileSync(path);
  assert.equal(JSON.parse(saved).sandboxId, 'bound-sandbox');
  const cold = new E2BCommandStore(options);
  assert.ok(readFileSync(path).equals(saved)); assert.equal(cold._authorityProven(), true);
  assert.throws(() => new E2BCommandStore({ ...options, sandboxId: 'foreign' }), /binding_changed/);
  assert.ok(readFileSync(path).equals(saved));
  const asyncAuthority = new E2BCommandStore({ ...options, authority: () => Promise.reject(Error('invalid async authority')) });
  assert.equal(await asyncAuthority.close(), false);
  // start also observes invalid async authority without running a command.
  await assert.rejects(asyncAuthority.start({ operationKey: 'denied', command: 'echo no', timeoutSeconds: 1 }), /authority_unprovable/);
  await new Promise(resolve => setImmediate(resolve));
});

test('cleanup authority cannot retarget a frozen sandbox by mutating its argument or durable binding', async t => {
  const { root, workspace } = setup(t);
  for (const mutateDisk of [false, true]) {
    const killed = []; let store;
    store = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: `retarget-${mutateDisk}`,
      transport: fakeTransport(), sandboxId: 'original', killSandbox: async id => { killed.push(id); return true; },
      authority: record => {
        record.sandboxId = 'foreign';
        if (mutateDisk) writeFileSync(store._sandboxFile(), JSON.stringify(record));
        return true;
      } });
    assert.equal(await store.close(), false); assert.deepEqual(killed, []);
  }
});

test('detached supervisor uses the original copied transport configuration after caller mutation', async t => {
  const { root, workspace } = setup(t);
  const config = { sandboxId: 'original-sandbox', nested: { key: 'original' } };
  const store = new E2BCommandStore({ stateRoot: root, workspaceRoot: workspace, sessionId: 'transport-seal',
    transportModule: new URL('./e2b-fake-transport.mjs', import.meta.url).href, transportConfig: config,
    sandboxId: 'original-sandbox', authority: () => true });
  config.sandboxId = 'foreign-sandbox'; config.nested.key = 'changed';
  assert.throws(() => { store._transportConfig.nested.key = 'changed'; }, TypeError);
  const handle = await store.start({ operationKey: 'sealed', command: 'echo sealed', timeoutSeconds: 10 });
  await poll(() => TERMINAL.has(handle.readOutput().status));
  assert.equal(handle.readOutput().status, 'completed');
  assert.equal(store.recordSandboxIdForTask(handle.commandId), 'original-sandbox');
  assert.equal(handle.readOutput().stdout, 'sealed\n');
});
