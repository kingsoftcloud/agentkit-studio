import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDshNodeCommandTools } from '../src/providers/dsh-node-command-tools.mjs';
import { createDshNodeBuiltins } from '../src/providers/dsh-node-builtins.mjs';
import { commandDigest, commandStateRoot, DshNodeCommandLedger } from '../src/providers/dsh-node-command-ledger.mjs';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(check) {
  const deadline = performance.now() + 10000;
  while (!check()) { assert.ok(performance.now() < deadline, 'condition deadline'); await pause(20); }
}
function fixture(t, options = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsh-node-command-'));
  const workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state'); mkdirSync(workspaceRoot);
  const controllers = [], ports = [];
  const config = { workspaceRoot, stateDir, agentId: 'bound-agent', settings: { wallSeconds: 5 },
    env: { PATH: '/bin:/usr/bin', HOST_SECRET: 'not-inherited' },
    ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }, ...options };
  const open = overrides => { const port = createDshNodeCommandTools({ ...config, ...overrides }); ports.push(port); return port; };
  const port = open();
  function execution(name, args, callId = 'call', sessionId = 'session') {
    const controller = new AbortController(); controllers.push(controller);
    return { name, arguments: args, callId, signal: controller.signal, agent: { session: { id: sessionId } }, controller };
  }
  t.after(() => { for (const controller of controllers) controller.abort(); for (const item of ports) item.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceRoot, stateDir, config, port, open, execution,
    run: (name, args, callId, sessionId, target = port) => target.execute(name, args, execution(name, args, callId, sessionId)) };
}

test('real supervised foreground output, changed paths and immutable duplicate calls survive reopen', async t => {
  const f = fixture(t), args = { command: 'printf x >> counter; printf "$HOST_SECRET:$CI"; exit 7' };
  const exec = f.execution('run_command', args);
  const results = await Promise.all([f.port.execute(exec.name, args, exec), f.port.execute(exec.name, args, exec)]);
  assert.equal(results[0].status, 'ok'); assert.equal(results[0].content.exit_code, 7);
  assert.equal(results[0].content.stdout, ':1'); assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[0].workspaceChangedPaths, ['counter']);
  assert.equal(readFileSync(join(f.workspaceRoot, 'counter'), 'utf8'), 'x');
  f.port.close(); const reopened = f.open();
  assert.deepEqual(await reopened.execute(exec.name, args, exec), results[0]);
  const changed = { command: 'printf bad >> counter' };
  const conflict = await f.run('run_command', changed, 'call', 'session', reopened);
  assert.equal(conflict.status, 'error'); assert.equal(conflict.content.error_type, 'dsh_node_command_call_identity_conflict');
  assert.equal(readFileSync(join(f.workspaceRoot, 'counter'), 'utf8'), 'x');
  const state = commandStateRoot(f.stateDir, f.workspaceRoot, 'bound-agent');
  const path = join(state.root, commandDigest({ agentId: 'bound-agent', sessionId: 'session' }), commandDigest('call'), 'record.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(record.phase, 'finished'); assert.equal(record.request.agentId, 'bound-agent');
  for (const key of ['runId', 'scope', 'executionFence', 'turnId']) assert.equal(key in record.request, false);
  assert.equal(readFileSync(path, 'utf8').includes('not-inherited'), false);
});

test('background read, byte cursors and scoped stop survive reopen without granting another Agent/Session access', async t => {
  const f = fixture(t);
  const launched = await f.run('run_command', { command: 'printf "你好😀"; sleep 3', background: true });
  assert.equal(launched.status, 'ok'); const taskId = launched.content.task_id;
  f.port.close(); const reopened = f.open();
  let result;
  await until(() => existsSync(join(f.stateDir, 'commands')));
  for (let n = 0; n < 40; n++) {
    result = await f.run('read_command_output', { task_id: taskId, max_bytes: 4 }, `read-${n}`, 'session', reopened);
    if (result.content.stdout === '你') break; await pause(20);
  }
  assert.equal(result.status, 'ok'); assert.equal(result.content.stdout, '你'); assert.equal(result.content.stdout_cursor, 3);
  const next = await f.run('read_command_output', { task_id: taskId, stdout_cursor: 3, max_bytes: 4 }, 'next', 'session', reopened);
  assert.equal(next.content.stdout, '好'); assert.equal(next.content.stdout_cursor, 6);
  const foreign = await f.run('read_command_output', { task_id: taskId }, 'foreign', 'foreign', reopened);
  assert.equal(foreign.status, 'error');
  const other = f.open({ agentId: 'other-agent' });
  assert.equal((await f.run('stop_command', { task_id: taskId }, 'other', 'session', other)).status, 'error');
  const stopped = await f.run('stop_command', { task_id: taskId }, 'stop', 'session', reopened);
  assert.equal(stopped.status, 'ok');
  const done = await f.run('read_command_output', { task_id: taskId, wait_seconds: 2 }, 'final', 'session', reopened);
  assert.equal(done.content.status, 'canceled'); assert.equal(done.content.exit_code, -osConstants.signals.SIGTERM);
});

test('large supervised foreground output is retained in a real immutable Session-bound artifact', async t => {
  const f = fixture(t);
  const result = await f.run('run_command', { command: "awk 'BEGIN { for (i=0;i<40000;i++) printf \"界\" }'" });
  assert.equal(result.status, 'ok'); assert.equal(result.content.output_budget.truncated, true);
  const text = readFileSync(result.content.output_budget.artifact_uri, 'utf8');
  assert.equal(JSON.parse(text).stdout, '界'.repeat(40000));
  assert.ok(Buffer.byteLength(result.content.stdout) <= 4000);
  assert.equal(result.artifactRefs[0].sizeBytes, Buffer.byteLength(text));
});

for (const drift of ['args', 'execArguments', 'session', 'signal', 'closed', 'canceled']) {
  test(`original ${drift} change during actual approval prevents dispatch`, async t => {
    const ready = deferred(), release = deferred();
    const f = fixture(t, { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
      approval: { request: async () => { ready.resolve(); await release.promise; return 'allowed-once'; } } } });
    const args = { command: 'printf forbidden > forbidden' }, exec = f.execution('run_command', args);
    const pending = f.port.execute(exec.name, args, exec); await ready.promise;
    if (drift === 'args') args.command += 'changed';
    if (drift === 'execArguments') exec.arguments = { command: 'printf different' };
    if (drift === 'session') exec.agent.session = { id: 'session' };
    if (drift === 'signal') exec.signal = new AbortController().signal;
    if (drift === 'closed') f.port.close();
    if (drift === 'canceled') exec.controller.abort();
    release.resolve(); const result = await pending;
    assert.equal(result.status, 'error'); assert.equal(result.content.executed, false);
    assert.equal(existsSync(join(f.workspaceRoot, 'forbidden')), false);
  });
}

test('approval denial, formal mutation, governed policy and symlink cwd fail before command effects', async t => {
  const f = fixture(t, { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: async () => 'denied' } } });
  assert.equal((await f.run('run_command', { command: 'printf no > forbidden' })).content.executed, false);
  const allowed = f.open({ ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } } });
  allowed.definitions.find(item => item.name === 'run_command').parameters.additionalProperties = true;
  assert.equal((await f.run('run_command', { command: 'printf no > forbidden', approval: true }, 'formal', 'session', allowed)).status, 'error');
  symlinkSync(f.root, join(f.workspaceRoot, 'escape'));
  for (const [index, args] of [{ command: 'sudo true' }, { command: 'printf no > forbidden', cwd: 'escape' }].entries()) {
    const result = await f.run('run_command', args, `deny-${index}`, 'session', allowed);
    assert.equal(result.status, 'error'); assert.equal(result.content.executed, false);
  }
  assert.equal(existsSync(join(f.workspaceRoot, 'forbidden')), false);
});

test('original cancellation settles an uncooperative approval and observes its late rejection', async t => {
  const ready = deferred(); let reject;
  const f = fixture(t, { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: () => { ready.resolve(); return new Promise((_, no) => { reject = no; }); } } } });
  const args = { command: 'printf no > forbidden' }, exec = f.execution('run_command', args);
  const pending = f.port.execute(exec.name, args, exec); await ready.promise; exec.controller.abort();
  const result = await pending; assert.equal(result.status, 'error'); assert.equal(result.content.executed, false);
  reject(Error('late approval error')); await pause(10);
  assert.equal(existsSync(join(f.workspaceRoot, 'forbidden')), false);
});

for (const cancel of ['caller', 'host', 'close']) {
  test(`${cancel} cancels a supervised foreground command without replaying or reaching its later effect`, async t => {
    const host = new AbortController(), f = fixture(t, { signal: host.signal });
    const args = { command: 'printf ready > started; sleep 1; printf no > forbidden' }, exec = f.execution('run_command', args);
    const pending = f.port.execute(exec.name, args, exec); await until(() => existsSync(join(f.workspaceRoot, 'started')));
    if (cancel === 'caller') exec.controller.abort();
    if (cancel === 'host') host.abort();
    if (cancel === 'close') f.port.close();
    const result = await pending; assert.equal(result.status, 'uncertain'); assert.ok(result.content.task_id);
    await pause(1200); assert.equal(existsSync(join(f.workspaceRoot, 'forbidden')), false);
    const reopened = f.open({ signal: undefined });
    const retry = await f.run('run_command', args, 'call', 'session', reopened);
    assert.deepEqual(retry, result);
  });
}

test('changed Host execution binding cannot borrow cached results or owned handles', async t => {
  const f = fixture(t), args = { command: 'printf once' };
  const result = await f.run('run_command', args);
  assert.equal(result.status, 'ok', canonical(result));
  const changed = f.open({ settings: { wallSeconds: 4 } });
  assert.equal((await f.run('run_command', args, 'call', 'session', changed)).content.error_type, 'dsh_node_command_call_identity_conflict');
  assert.equal((await f.run('read_command_output', { task_id: result.content.task_id }, 'read', 'session', changed)).status, 'error');
});

test('actual SIGKILL after ledger intent and before external effect is uncertain and never automatically dispatched', async t => {
  const f = fixture(t), state = commandStateRoot(f.stateDir, f.workspaceRoot, 'bound-agent');
  const ledger = new DshNodeCommandLedger({ root: state.root, agentId: 'bound-agent', sessionId: 'session', assertRoot: state.guard });
  const request = { agentId: 'bound-agent', sessionId: 'session', call: { callId: 'pending', name: 'run_command', arguments: { command: 'echo once' } },
    operationKey: 'owned-key', signal: new AbortController().signal }, binding = { digest: 'fixed' };
  const { signal: _, ...json } = request;
  const fixturePath = fileURLToPath(new URL('./fixtures/dsh-node-command-crash.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixturePath, f.workspaceRoot, f.stateDir, 'before'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = once(child, 'close'); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await until(() => existsSync(join(f.workspaceRoot, 'before-ready')) || child.exitCode !== null);
  assert.equal(child.exitCode, null, stderr);
  assert.equal(Number(readFileSync(join(f.workspaceRoot, 'before-ready'), 'utf8')), child.pid);
  child.kill('SIGKILL'); const [code, stopped] = await closed;
  assert.equal(code, null); assert.equal(stopped, 'SIGKILL');
  const entry = ledger.entry('pending');
  assert.equal(canonical(ledger.read(entry).request), canonical(json));
  let effects = 0;
  const before = readFileSync(join(entry, 'record.json'), 'utf8');
  const result = await ledger.execute({ request, binding, taskId: 'a'.repeat(64), assertCurrent: () => { state.guard(); request.signal.throwIfAborted(); return true; },
    dispatch: () => { effects++; return { status: 'ok' }; } });
  assert.equal(result.status, 'uncertain'); assert.equal(effects, 0);
  assert.equal(readFileSync(join(entry, 'record.json'), 'utf8'), before);
  assert.equal(existsSync(join(f.workspaceRoot, 'forbidden')), false);
});

for (const invalid of ['async', 'false', 'mutates']) test(`ledger rejects ${invalid} authority before recording or dispatching`, async t => {
  const f = fixture(t), state = commandStateRoot(f.stateDir, f.workspaceRoot, 'bound-agent');
  const ledger = new DshNodeCommandLedger({ root: state.root, agentId: 'bound-agent', sessionId: 'session', assertRoot: state.guard });
  const request = { agentId: 'bound-agent', sessionId: 'session', call: { name: 'run_command', callId: 'invalid', arguments: { command: 'true' } },
    signal: new AbortController().signal };
  let effects = 0;
  const assertCurrent = invalid === 'async' ? () => Promise.reject(Error('observe late denial'))
    : invalid === 'false' ? () => false : () => { request.call.callId = 'changed'; return true; };
  await assert.rejects(ledger.execute({ request, binding: {}, assertCurrent, dispatch: () => { effects++; } }),
    /dsh_node_command_(authority_lost|request_drifted)/);
  await pause(5); assert.equal(effects, 0);
  assert.equal(existsSync(join(ledger.root, commandDigest('invalid'))), false);
  assert.equal(existsSync(join(ledger.root, commandDigest('changed'))), false);
});

test('actual foreground Host SIGKILL leaves an uncertain call; detached supervisor completes without replay', async t => {
  const f = fixture(t), fixturePath = fileURLToPath(new URL('./fixtures/dsh-node-command-crash.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixturePath, f.workspaceRoot, f.stateDir, 'after'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = once(child, 'close'); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await until(() => existsSync(join(f.workspaceRoot, 'ready')) || child.exitCode !== null);
  assert.equal(child.exitCode, null, stderr); child.kill('SIGKILL');
  const [code, signal] = await closed; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const state = commandStateRoot(f.stateDir, f.workspaceRoot, 'bound-agent');
  const path = join(state.root, commandDigest({ agentId: 'bound-agent', sessionId: 'session' }), commandDigest('crash-call'), 'record.json');
  const intent = readFileSync(path, 'utf8'); assert.equal(JSON.parse(intent).phase, 'executing');
  const args = { command: 'printf x >> counter; printf ready > ready; sleep 1; printf done' };
  const result = await f.run('run_command', args, 'crash-call');
  assert.equal(result.status, 'uncertain'); assert.equal(result.content.task_id, JSON.parse(intent).taskId);
  await pause(1400);
  assert.equal(readFileSync(join(f.workspaceRoot, 'counter'), 'utf8'), 'x');
  assert.equal(readFileSync(path, 'utf8'), intent);
  const again = await f.run('run_command', args, 'crash-call'); assert.deepEqual(again, result);
});

test('actual builtin composition selects Node commands and never falls back to local for explicit E2B', async t => {
  const f = fixture(t), builtins = createDshNodeBuiltins({ ...f.config, env: { PATH: '/bin:/usr/bin' } });
  t.after(() => builtins.close());
  for (const name of ['sandbox_status', 'run_command', 'read_command_output', 'stop_command']) assert.equal(builtins.supports(name), true);
  const status = await builtins.execute('sandbox_status', {}, f.execution('sandbox_status', {}));
  assert.equal(status.content.backend, 'local_process'); assert.equal(status.content.isolated, false);
  const e2b = createDshNodeBuiltins({ ...f.config, env: { KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'explicit-template',
    E2B_API_URL: 'https://fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'test-only-key' } }); t.after(() => e2b.close());
  assert.equal(e2b.supports('run_command'), true); assert.equal(e2b.supports('web_fetch'), true);
  const component = await e2b.execute('component_status', {}, f.execution('component_status', {}));
  assert.equal(component.content.sandbox.backend, 'e2b'); assert.equal(component.content.sandbox.template_bound, true);
  assert.equal(component.content.summary.isolated_execution, 'enabled');
  assert.throws(() => createDshNodeBuiltins({ ...f.config, env: { KSADK_SANDBOX_BACKEND: 'e2b' } }), /studio_native_e2b_template_required/);
});
