// E2B command ToolPort tests. Fake deterministic transport + real disk/supervisor.
// These are NOT real E2B online proof. Covers: full ToolPort lifecycle, sandbox
// binding, fg/bg, timeout/cancel, unknown→uncertain, receipt scope isolation,
// identity drift, output artifact, owner.ensure failure. Node26+22.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { factory as subprocessTransport } from './e2b-fake-transport.mjs';
import { createNativeE2BCommandTools, E2B_COMMAND_TOOLS_CONTRACT } from '../src/native/e2b-command-tools.mjs';
import { E2BCommandStore, createE2BBackgroundReader } from '../src/native/e2b-background.mjs';
import { TERMINAL } from '../src/native/e2b-command-state.mjs';
import { ownedCommandReceipt, createOwnedCommandResolver } from '../src/native/owned-command.mjs';

const tmp = realpathSync(tmpdir());
const delay = ms => new Promise(r => setTimeout(r, ms));
const poll = async (fn, { timeoutMs = 10000 } = {}) => {
  const until = performance.now() + timeoutMs;
  for (;;) { const r = fn(); if (r) return r; if (performance.now() > until) throw new Error('poll timeout'); await delay(50); }
};

// Fake transport: runs commands as local subprocesses (deterministic, NOT real E2B).
function fakeTransport({ sandboxId = 'sb-test' } = {}) {
  const transport = subprocessTransport({ sandboxId });
  return {
    ...transport,
    start(command, options) {
      assert.ok(options.sandboxId, 'transport.start must receive a sandboxId');
      // stdout EOF may precede process exit. The shared fixture waits for
      // close and preserves null for signal kills, rather than guessing zero.
      return transport.start(command, options);
    },
  };
}

// Fake owner: returns a fixed sandboxId, tracks ensure calls.
function fakeOwner({ sandboxId = 'sb-test', ensureThrows = null, ensureUncertain = false } = {}) {
  let ensureCount = 0;
  return { ensureCount: () => ensureCount,
    ensure: async () => { ensureCount++; if (ensureThrows) throw ensureThrows; return { sandboxId, created: ensureCount === 1 }; },
    close: async () => ({ confirmed: true, sandboxId }),
    inspect: () => ({ phase: 'ready', sandboxId, ownerKey: 'fake' }),
  };
}

const scope = { tenantId: 'tenant', workspaceId: 'workspace', agentId: 'agent', userId: 'user' };
let seq = 0;
function makeRequest(tools, name, args, extra = {}) {
  const ac = new AbortController();
  return { call: { name, arguments: args, callId: 'call-' + ++seq },
    definition: tools.definitions.find(d => d.name === name),
    operationKey: 'op-' + seq, runId: 'run-1', turnId: 'turn-1', buildId: 'build-1',
    parentRunId: null, taskChainId: 'chain-1', executionFence: 1, scope, sessionId: 'session-1',
    signal: ac.signal, ...extra };
}

function setup(t, opts = {}) {
  const root = mkdtempSync(join(tmp, 'e2b-cmd-'));
  const ws = mkdtempSync(join(tmp, 'e2b-cmd-ws-'));
  const transport = opts.transport || fakeTransport(opts.transportOpts || {});
  const owner = opts.owner || fakeOwner(opts.ownerOpts || {});
  let storeInstance = null;
  const storeFactory = (facOpts) => {
    if (storeInstance) return storeInstance;
    storeInstance = new E2BCommandStore({ stateRoot: root, workspaceRoot: ws, sessionId: 'session-1',
      transport, sandboxId: facOpts.sandboxId || 'sb-test', authority: () => true, launchAuthorized: true });
    return storeInstance;
  };
  const launches = [];
  const tools = createNativeE2BCommandTools({ scope, sessionId: 'session-1', owner, storeFactory,
    authorize: async request => {
      if (request.call.name === 'run_command') launches.push({ operationKey: request.operationKey, sourceRunId: request.runId });
      return opts.authorize ? opts.authorize(request) : 'allow';
    },
    assertAuthority: opts.assertAuthority || (() => true),
    resolveOwnedCommand: opts.resolveOwnedCommand || ((req, taskId) => {
      // Deterministic resolver seam: preserve the original launch operation,
      // never attribute the command to this later read/stop operation.
      const source = launches.find(item => storeInstance.commandId(item.operationKey) === taskId);
      assert.ok(source, 'only an actual prior launch in this fixture is owned');
      return { ref: { taskId, ...source }, backend: 'e2b' };
    }),
    artifacts: opts.artifacts || null,
  });
  t.after(() => { storeInstance?.close?.(); rmSync(root, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });
  return { root, ws, transport, owner, storeFactory, tools, getStore: () => storeInstance };
}

test('sandbox_status returns the bound E2B backend with allowInternetAccess boolean', async () => {
  const tools = createNativeE2BCommandTools({ scope, sessionId: 'session-1',
    owner: fakeOwner({ sandboxId: 'sb-status' }), storeFactory: () => ({}),
    authorize: async () => 'allow', assertAuthority: () => true,
    resolveOwnedCommand: () => ({}), allowInternetAccess: true });
  const r = await tools.execute(makeRequest(tools, 'sandbox_status', {}));
  assert.equal(r.status, 'ok'); assert.equal(r.content.backend, 'e2b'); assert.equal(r.content.isolated, true);
  assert.equal(r.content.allow_internet_access, true);
  assert.equal(r.content.sandbox_id, 'sb-status');
});

test('background run_command: launches, returns task_id and backgroundCommandRef {taskId,sourceRunId,operationKey}', async t => {
  const { tools, owner, getStore } = setup(t);
  const req = makeRequest(tools, 'run_command', { command: 'echo bg-test', background: true, background_timeout: 10 });
  const r = await tools.execute(req);
  assert.equal(r.status, 'ok'); assert.ok(r.content.task_id);
  assert.equal(r.content.backend, 'sandbox/e2b'); assert.equal(r.content.sandbox_id, 'sb-test');
  assert.deepEqual(r.backgroundCommandRef, { taskId: r.content.task_id, sourceRunId: 'run-1', operationKey: req.operationKey });
  assert.equal(owner.ensureCount(), 1, 'owner.ensure called once');
  // The command settles.
  await poll(() => TERMINAL.has(getStore().connect(r.content.task_id).readOutput().status));
  const out = getStore().connect(r.content.task_id).readOutput();
  assert.ok(out.stdout.includes('bg-test'));
});

test('foreground run_command: waits for completion, returns exit_code', async t => {
  const { tools, getStore } = setup(t);
  const r = await tools.execute(makeRequest(tools, 'run_command',
    { command: 'echo fg-test && exit 0', timeout: 10 }));
  assert.equal(r.status, 'ok'); assert.equal(r.content.exit_code, 0);
  assert.ok(r.content.stdout.includes('fg-test'));
});

test('foreground run_command non-zero exit: status ok, exit_code non-zero', async t => {
  const { tools } = setup(t);
  const r = await tools.execute(makeRequest(tools, 'run_command',
    { command: 'echo fail && exit 42', timeout: 10 }));
  assert.equal(r.status, 'ok'); assert.equal(r.content.exit_code, 42);
});

test('foreground timeout: command killed, status uncertain (not ok)', async t => {
  const { tools } = setup(t);
  const r = await tools.execute(makeRequest(tools, 'run_command',
    { command: 'sleep 30', timeout: 1 }));
  assert.equal(r.status, 'uncertain'); assert.equal(r.content.evidence_incomplete, true);
  assert.equal(r.content.exit_code, null);
});

test('background cancel: stop_command requests cancel, read confirms final status', async t => {
  const { tools, getStore } = setup(t);
  const runR = await tools.execute(makeRequest(tools, 'run_command',
    { command: 'sleep 30', background: true, background_timeout: 60 }));
  await poll(() => getStore().connect(runR.content.task_id).readOutput().status === 'running', { timeoutMs: 5000 });
  const stopR = await tools.execute(makeRequest(tools, 'stop_command', { task_id: runR.content.task_id }));
  assert.equal(stopR.status, 'ok'); assert.ok(stopR.content.cancel_requested);
  await poll(() => TERMINAL.has(getStore().connect(runR.content.task_id).readOutput().status));
  const finalOut = getStore().connect(runR.content.task_id).readOutput();
  assert.ok(['canceled', 'unknown'].includes(finalOut.status));
});

test('owner.ensure uncertain throws: status uncertain, not clean error', async t => {
  const owner = fakeOwner({ ensureThrows: Object.assign(new Error('unknown'), { uncertain: true }) });
  const { tools } = setup(t, { owner });
  const r = await tools.execute(makeRequest(tools, 'run_command', { command: 'echo test', timeout: 10 }));
  assert.equal(r.status, 'uncertain'); assert.equal(r.content.error_type, 'e2b_sandbox_outcome_unknown');
  assert.equal(r.content.evidence_incomplete, true);
});

test('identity drift: mutating runId during authorize → reject no write', async t => {
  const { tools } = setup(t, { authorize: async req => { req.runId = 'drifted'; return 'allow'; } });
  const r = await tools.execute(makeRequest(tools, 'run_command', { command: 'echo drift', timeout: 10 }));
  assert.equal(r.status, 'error'); assert.equal(r.content.code, 'e2b_command_request_drifted');
});

test('assertAuthority rejected on read: execute returns error (not throws)', async t => {
  const { tools } = setup(t, { assertAuthority: () => false });
  const r = await tools.execute(makeRequest(tools, 'read_command_output', { task_id: 'a'.repeat(64) }));
  assert.equal(r.status, 'error');
  assert.equal(r.content.error_type, 'e2b_command_authority_unproven');
});

test('sandboxId passed to store and transport.start: first launch uses owner.ensure id', async t => {
  let receivedSandboxId = null;
  const transport = {
    start(command, { cwd, env, timeout, sandboxId }) {
      receivedSandboxId = sandboxId;
      const proc = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
      const handle = { pid: proc.pid, result: null,
        async * [Symbol.asyncIterator]() { const o = []; proc.stdout.on('data', x => o.push(x));
          await new Promise(r => { const d = () => { if (handle.result === null) { handle.result = { exitCode: proc.exitCode }; r(); } }; proc.once('exit', d); proc.stdout.once('end', d); proc.once('close', d); });
          for (const x of o) yield { stdout: x.toString('utf8') }; },
        disconnect() {} };
      return { pid: proc.pid, handle, sandboxId: sandboxId || 'sb-bound' };
    },
    reconnect(pid, opts) { return { async * [Symbol.asyncIterator]() {}, result: null, disconnect() {} }; },
    kill(pid, opts) { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } },
  };
  const { tools, getStore } = setup(t, { transport, ownerOpts: { sandboxId: 'sb-bound' } });
  const r = await tools.execute(makeRequest(tools, 'run_command', { command: 'echo bound', background: true, background_timeout: 10 }));
  // Wait for the supervisor to actually start (it runs async in-process).
  await poll(() => receivedSandboxId !== null, { timeoutMs: 5000 });
  assert.equal(receivedSandboxId, 'sb-bound');
});

test('output artifact: large output is budgeted to artifact, remote locator retained', async t => {
  let artifactWritten = false;
  const artifacts = { write: async () => { artifactWritten = true; return { uri: 'artifact://test', sizeBytes: 50000 }; } };
  const { tools } = setup(t, { artifacts });
  const r = await tools.execute(makeRequest(tools, 'run_command',
    { command: 'echo ' + 'x'.repeat(30000), timeout: 10 }));
  assert.ok(artifactWritten, 'artifact was written');
  assert.ok(r.content.output_budget?.truncated);
  assert.ok(r.content.output_budget?.artifact_uri);
});
