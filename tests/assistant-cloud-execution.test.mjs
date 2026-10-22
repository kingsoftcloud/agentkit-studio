/** Confined cloud execution: plan shape, environment scrubbing, limits and refusals. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOUD_BASH_TOOL, CLOUD_RUN_CODE_TOOL, createCloudExecutor, planCloudExecution,
  registerAssistantCloudExecutionTools, resolveCloudSandbox,
} from '../src/assistant-cloud-execution.mjs';

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'akt-cloud-exec-')));
  mkdirSync(join(root, 'files'));
  return root;
}

function sandboxForTest(path = '/usr/bin/bwrap') {
  return { available: true, kind: 'bwrap', path };
}

function mockChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function captureSpawn(child, calls = []) {
  return { calls, spawn: (file, args, options) => { calls.push({ file, args, options }); return child; } };
}

test('a missing Linux confiner refuses execution instead of degrading', () => {
  assert.equal(resolveCloudSandbox({ platform: 'darwin' }).available, false);
  const missing = resolveCloudSandbox({ platform: 'linux', env: {}, bwrapPath: '/nonexistent/bwrap' });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /bubblewrap/);
});

test('the plan confines the child: no network, no inherited environment, workspace-only cwd', () => {
  const root = workspace();
  const plan = planCloudExecution({ sandbox: sandboxForTest(), workspaceRoot: root, argv: ['/bin/bash', '-c', 'pwd'], timeoutMs: 5000 });
  assert.equal(plan.file, '/usr/bin/bwrap');
  assert.equal(plan.env.PATH, undefined, 'the bwrap process itself must not inherit the Host environment');
  assert.ok(plan.args.includes('--unshare-net'));
  assert.ok(plan.args.includes('--unshare-user'));
  assert.ok(plan.args.includes('--clearenv'));
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--'), plan.args.indexOf('--') + 3), ['--', '/bin/bash', '-c']);
  const bind = plan.args.indexOf('--bind');
  assert.equal(plan.args[bind + 1], root);
  assert.equal(plan.args[bind + 2], root);
  assert.ok(!plan.args.includes('/var/lib/agentkit'), 'Host state directories must never be bound');
  for (const key of ['--setenv']) assert.ok(plan.args.includes(key));
  assert.equal(plan.cwd, root);
});

test('plan refuses a workspace that is a symlink or missing', () => {
  assert.throws(() => planCloudExecution({ sandbox: sandboxForTest(), workspaceRoot: '/nonexistent/ws', argv: ['true'], timeoutMs: 1000 }), /工作区/);
});

test('the executor spawns with an empty environment and returns bounded output', async () => {
  const root = workspace();
  const child = mockChild();
  const { calls, spawn } = captureSpawn(child);
  const executor = createCloudExecutor({ workspaceRoot: root, sandbox: sandboxForTest(), spawn });
  const pending = executor.runBash({ command: 'printf hello' });
  child.stdout.write('hello');
  child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.env, {});
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.detached, true);
});

test('output beyond the cap is truncated rather than returned in full', async () => {
  const root = workspace();
  const child = mockChild();
  const executor = createCloudExecutor({ workspaceRoot: root, sandbox: sandboxForTest(), spawn: captureSpawn(child).spawn, limits: { outputBytes: 8 } });
  const pending = executor.runCode({ language: 'python', code: 'print("x")' });
  child.stdout.write(Buffer.from('0123456789abcdef'));
  child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.stdout, '01234567');
  assert.equal(result.stdoutTruncated, true);
});

test('a runaway command is killed at its timeout and reported as a timeout', async () => {
  const root = workspace();
  const child = mockChild({ pid: 2147483000 });
  let killed = false;
  const executor = createCloudExecutor({ workspaceRoot: root, sandbox: sandboxForTest(), spawn: () => { killed = true; return child; } });
  await assert.rejects(executor.runBash({ command: 'sleep 10', timeoutMs: 1000 }), error => {
    assert.equal(error.code, 'ASSISTANT_CLOUD_EXEC_TIMEOUT');
    return true;
  });
  assert.equal(killed, true);
});

test('aborting the tool aborts the child', async () => {
  const root = workspace();
  const child = mockChild();
  const executor = createCloudExecutor({ workspaceRoot: root, sandbox: sandboxForTest(), spawn: captureSpawn(child).spawn });
  const controller = new AbortController();
  const pending = executor.runBash({ command: 'sleep 10' }, { signal: controller.signal });
  controller.abort();
  child.emit('close', null, 'SIGKILL');
  await assert.rejects(pending, /已取消/);
});

test('invalid limits and languages are refused before spawning', async () => {
  const root = workspace();
  const child = mockChild();
  const { calls, spawn } = captureSpawn(child);
  const executor = createCloudExecutor({ workspaceRoot: root, sandbox: sandboxForTest(), spawn });
  assert.throws(() => executor.runBash({ command: '   ' }), /不能为空/);
  await assert.rejects(executor.runBash({ command: 'true', timeoutMs: 10 }), /超时时间/);
  assert.throws(() => executor.runCode({ language: 'ruby', code: 'puts 1' }), /JavaScript 或 Python/);
  assert.equal(calls.length, 0);
});

test('an unavailable confiner means the tools are not registered at all', () => {
  const agent = { ctx: { get: () => ({ register: () => () => {} }) } };
  assert.throws(() => registerAssistantCloudExecutionTools({
    agent, workspaceRoot: workspace(), previous: undefined,
    executor: { available: false, reason: '缺少 bubblewrap' },
  }), error => error.code === 'ASSISTANT_CLOUD_EXECUTION_UNAVAILABLE');
});

test('granted tools register under the confined names', () => {
  const definitions = [];
  const agent = { ctx: { get: () => ({ register: definition => { definitions.push(definition); return () => {}; } }) } };
  const executor = { available: true, dispose() {}, runBash: async () => ({}), runCode: async () => ({}) };
  const registered = registerAssistantCloudExecutionTools({ agent, workspaceRoot: workspace(), executor });
  assert.deepEqual(registered.names, [CLOUD_BASH_TOOL, CLOUD_RUN_CODE_TOOL]);
  assert.deepEqual(definitions.map(item => item.name), [CLOUD_BASH_TOOL, CLOUD_RUN_CODE_TOOL]);
  for (const definition of definitions) {
    assert.equal(definition.parameters.additionalProperties, false);
    assert.ok(definition.output.schema.properties.exitCode);
  }
});
