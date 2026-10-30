import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindNativeLocalExecution, nativeLocalExecutionMethods } from '../src/providers/native-local-execution.mjs';
import { createLocalCommandTransport } from '@kingsoftcloud/agentkit-harness-node/native/local-command-tools';
import { canonical } from '@kingsoftcloud/agentkit-harness-core';

test('one selected execution profile drives environment facts and a credential-free frozen binding while legacy controls remain exact', () => {
  const sourceEnv = { PATH: '/usr/bin:/bin', HOME: '/private/test-home', USER: 'fixture-user', PROVIDER_SECRET: 'must-not-inherit' };
  const legacy = bindNativeLocalExecution({ sourceEnv });
  const modern = bindNativeLocalExecution({ sourceEnv, modern: true });
  assert.equal(legacy.environment.HOME, undefined); assert.equal(modern.environment.HOME, sourceEnv.HOME);
  assert.equal(modern.environment.PROVIDER_SECRET, undefined);
  assert.equal(canonical(modern.settings), canonical(legacy.settings));
  assert.equal(legacy.binding.controls.outputPolicy, undefined);
  assert.equal(modern.binding.controls.outputPolicy.version, 'persisted-stream/v1');
  assert.notEqual(modern.binding.environmentDigest, legacy.binding.environmentDigest);
  assert.ok(!canonical(modern.binding).includes('must-not-inherit'));
  assert.ok(!canonical(modern.binding).includes('/private/test-home'));
});

test('Studio execution binding reaches the owned foreground transport: preview overflow completes once and full output stays cursor-readable', { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'native-execution-integration-')), workspaceRoot = join(directory, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bound = bindNativeLocalExecution({ settings: { maxOutputBytes: 32, wallSeconds: 5 },
    sourceEnv: { PATH: '/usr/bin:/bin', HOME: directory }, modern: true });
  let taskId;
  const transport = createLocalCommandTransport({ workspaceRoot, stateRoot: join(directory, 'commands'), sessionId: 'session',
    settings: bound.settings, sourceEnv: bound.environment, outputPolicy: bound.outputPolicy, environmentPolicy: bound.environmentPolicy,
    authorize: async () => 'allow', assertAuthority: () => true,
    resolveOwnedCommand: (_request, id) => { assert.equal(id, taskId); return { backend: 'local_process',
      ref: { taskId: id, operationKey: 'execute-once' } }; },
    captureWorkspace: () => ({ revision: 'fixture-observation', entries: {} }),
  });
  const request = (name, args, operationKey) => ({ sessionId: 'session', runId: 'run', operationKey,
    call: { callId: operationKey, name, arguments: args }, definition: transport.definitions.find(tool => tool.name === name),
    signal: new AbortController().signal, resultGovernance: 'runtime-artifacts/v1' });
  const result = await transport.execute(request('run_command', { command: "printf '%02048d' 0; printf x >> once.txt" }, 'execute-once'));
  assert.equal(result.status, 'ok'); assert.equal(result.content.exit_code, 0); assert.equal(result.content.status, 'completed');
  assert.ok(Buffer.byteLength(result.content.stdout) <= 32);
  assert.equal(readFileSync(join(workspaceRoot, 'once.txt'), 'utf8'), 'x');
  taskId = result.content.task_id; assert.match(taskId, /^[a-f0-9]{64}$/);
  const read = await transport.execute(request('read_command_output', { task_id: taskId, stdout_cursor: 0,
    stderr_cursor: 0, max_bytes: 4096 }, 'read-full-output'));
  assert.equal(read.status, 'ok'); assert.equal(read.content.stdout.length, 2048);
  assert.equal(read.content.stdout_cursor, 2048); assert.equal(read.content.exit_code, 0);
  assert.equal(readFileSync(join(workspaceRoot, 'once.txt'), 'utf8'), 'x');
});

test('Host profiles retain exact legacy controls, apply explicit overrides and expose the same requested limits they bind', () => {
  const sourceEnv = { PATH: '/usr/bin:/bin', HOME: '/fixture-home', API_KEY: 'private' };
  const owner = nativeLocalExecutionMethods({ enabled: true, settings: {}, sourceEnv,
    workspaceRoot: '/workspace', commandBackend: 'local_process' });
  const legacy = owner.localExecution({ modern: true });
  assert.equal(legacy.settings.maxFileBytes, 64 * 1024 ** 2);
  assert.equal(legacy.binding.controls.resourceProfile, undefined);
  assert.equal(owner.executionEnvironment({ modern: true }).commandResources, undefined);
  const options = { modern: true, resourceProfile: 'local-development/v1' };
  const local = owner.localExecution(options), facts = owner.executionEnvironment(options).commandResources;
  assert.equal(local.settings.maxFileBytes, 1024 ** 3);
  assert.equal(local.binding.controls.resourceProfile, options.resourceProfile);
  assert.equal(facts.profile, options.resourceProfile);
  assert.equal(facts.requestedLimits.maxFileBytes, local.settings.maxFileBytes);
  assert.equal(facts.requestedLimits.wallSeconds, local.settings.wallSeconds);
  assert.doesNotMatch(canonical(facts), /private|fixture-home|API_KEY/);
  const explicit = bindNativeLocalExecution({ ...options, settings: { maxFileBytes: 12345, cpuSeconds: 11 }, sourceEnv });
  assert.equal(explicit.settings.maxFileBytes, 12345); assert.equal(explicit.settings.cpuSeconds, 11);
  assert.deepEqual(explicit.binding.risk, legacy.binding.risk, 'resource profiles do not change command permission policies');
  for (const resourceProfile of ['unlimited', null, {}, 'toString', 'constructor'])
    assert.throws(() => bindNativeLocalExecution({ resourceProfile }), /invalid_local_resource_profile/);
  assert.throws(() => bindNativeLocalExecution({ ...options, settings: { maxFileBytes: 0 } }), /invalid_local_process_limit/);
});

test('a real foreground command can write a repository-size file under development admission while an explicit smaller cap remains enforced', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'native-resource-profile-')), workspaceRoot = join(directory, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [label, settings, succeeds] of [['development', {}, true], ['explicit-restriction', { maxFileBytes: 1024 ** 2 }, false]]) {
    const bound = bindNativeLocalExecution({ resourceProfile: 'local-development/v1', modern: true,
      settings: { wallSeconds: 10, ...settings }, sourceEnv: { PATH: '/usr/bin:/bin', HOME: directory } });
    const transport = createLocalCommandTransport({ workspaceRoot, stateRoot: join(directory, label), sessionId: 'session',
      settings: bound.settings, sourceEnv: bound.environment, outputPolicy: bound.outputPolicy, environmentPolicy: bound.environmentPolicy,
      authorize: async () => 'allow', assertAuthority: () => true, resolveOwnedCommand: () => assert.fail('No polling expected'),
      captureWorkspace: () => ({ revision: 'fixture', entries: {} }) });
    const code = 'const f=require("fs");const fd=f.openSync("' + label + '.bin","wx");const b=Buffer.alloc(1024*1024);for(let i=0;i<70;i++)f.writeSync(fd,b);f.closeSync(fd);';
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const result = await transport.execute({ sessionId: 'session', runId: 'run', operationKey: label,
      call: { callId: label, name: 'run_command', arguments: { command: quote(process.execPath) + ' -e ' + quote(code) } },
      definition: transport.definitions.find(x => x.name === 'run_command'), signal: new AbortController().signal,
      resultGovernance: 'runtime-artifacts/v1' });
    assert.equal(result.content.exit_code === 0, succeeds, canonical(result));
    assert.equal(result.content.status, succeeds ? 'completed' : 'failed');
    const { statSync } = await import('node:fs');
    assert.equal(statSync(join(workspaceRoot, label + '.bin')).size, succeeds ? 70 * 1024 ** 2 : settings.maxFileBytes);
  }
});
