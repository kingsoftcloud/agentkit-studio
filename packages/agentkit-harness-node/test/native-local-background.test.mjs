import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalCommandStore, createLocalBackgroundReader } from '../src/native/local-background.mjs';
import { buildScriptEnvironment } from '../src/native/local-process.mjs';
import { NativeKernel, emptyUsage, transition } from '../../agentkit-harness-core/dist/index.mjs';
import { fixture as coreFixture, scope, digest as coreDigest, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createBackgroundCommandPort } from '../src/native/background-command-port.mjs';
import { LOCAL_COMMAND_SHELL } from '../src/native/command-shell.mjs';

const moduleUrl = new URL('../src/native/local-background.mjs', import.meta.url).href;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, milliseconds = 4000) {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { const result = predicate(); if (result) return result; await pause(20); }
  assert.fail('background fixture did not reach the expected state');
}
function pidFile(filename) {
  if (!existsSync(filename)) return null;
  const text = readFileSync(filename, 'utf8'); return /^[1-9][0-9]*$/.test(text) ? Number(text) : null;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'native-background-')), workspace = join(root, 'workspace');
  mkdirSync(workspace); const config = { stateRoot: join(root, 'state'), workspaceRoot: workspace, sessionId: 'session' };
  const store = new LocalCommandStore(config), handles = [];
  t.after(async () => {
    for (const handle of handles) { try { await handle.kill(); } catch { /* failed fixtures remain bounded by wallSeconds */ } }
    rmSync(root, { recursive: true, force: true });
  });
  const input = (command, overrides = {}) => ({ command, cwd: workspace, env: buildScriptEnvironment({ PATH: '/bin:/usr/bin' }),
    settings: { wallSeconds: 10 }, ...overrides });
  return { root, workspace, config, store, input, handles,
    async start(command, overrides = {}) { const h = await store.start(input(command, overrides)); handles.push(h); return h; } };
}
function nodeChild(code) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: '/no-programs', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr })); });
  return { child, exit, line: () => stdout.split('\n').find(line => line.trim()) };
}

test('shell selection is persisted, reconnects without replay and cannot change an existing operation', async t => {
  const f = fixture(t), command = 'test -n "$BASH_VERSION" && printf x >> once.txt';
  const h = await f.start(command, { operationKey: 'bash-contract', shellPolicy: LOCAL_COMMAND_SHELL });
  assert.equal((await h.wait()).exitCode, 0);
  const reopened = new LocalCommandStore(f.config);
  const same = await reopened.start(f.input(command, { operationKey: 'bash-contract', shellPolicy: LOCAL_COMMAND_SHELL }));
  assert.equal(same.commandId, h.commandId);
  assert.equal(readFileSync(join(f.workspace, 'once.txt'), 'utf8'), 'x');
  await assert.rejects(reopened.start(f.input(command, { operationKey: 'bash-contract' })), { code: 'background_operation_arguments_changed' });
  await assert.rejects(f.start('printf never', { shellPolicy: 'unknown-shell/v1' }), /unsupported_command_shell/);
});

test('real supervisor publishes a complete result and reconnects after store re-open', async t => {
  const f = fixture(t), h = await f.start('printf hello; printf diagnostic >&2; exit 7');
  const result = await h.wait({ timeoutMs: 5000 });
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7); assert.equal(result.stdout, 'hello'); assert.equal(result.stderr, 'diagnostic');
  assert.deepEqual(new LocalCommandStore(f.config).connect(h.commandId).readOutput(), result);
  assert.equal(statSync(join(h.directory, 'record.json')).mode & 0o777, 0o600);
  const record = JSON.parse(readFileSync(join(h.directory, 'record.json'), 'utf8'));
  assert.equal(record.controls.status, process.platform === 'darwin' ? 'partial' : 'applied');
});
test('concurrent starts are serialized, one operation executes once, changed arguments are rejected', async t => {
  const f = fixture(t), request = f.input('printf x >> counter; /bin/sleep 0.2; printf done', { operationKey: 'same-operation' });
  const handles = await Promise.all([f.store.start(request), f.store.start(request), new LocalCommandStore(f.config).start(request)]);
  f.handles.push(...handles); assert.equal(new Set(handles.map(h => h.commandId)).size, 1);
  await Promise.all(handles.map(h => h.wait({ timeoutMs: 5000 })));
  assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
  for (const change of [{ command: 'printf y >> counter' }, { timeoutMs: 123 }, { env: { PATH: '/different' } }, { settings: { wallSeconds: 9 } }])
    await assert.rejects(f.store.start({ ...request, ...change }), { code: 'background_operation_arguments_changed' });
  const again = await f.store.start(request); assert.equal(again.readOutput().status, 'completed');
  assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
});
test('existing receipts remain readable when a replacement installation has no executable launcher', async t => {
  const f = fixture(t), request = f.input('printf retained', { operationKey: 'lookup-only' });
  const h = await f.store.start(request); f.handles.push(h); await h.wait({ timeoutMs: 5000 });
  const copy = join(f.root, 'replacement'); mkdirSync(copy);
  for (const file of ['local-background.mjs', 'local-command-state.mjs', 'local-command-evidence.mjs', 'local-process.mjs', 'local-output-policy.mjs'])
    cpSync(new URL('../src/native/' + file, import.meta.url), join(copy, file));
  const replacement = await import(pathToFileURL(join(copy, 'local-background.mjs')).href);
  const store = new replacement.LocalCommandStore(f.config), same = await store.start(request);
  assert.equal(same.commandId, h.commandId); assert.equal(same.readOutput().stdout, 'retained');
  await assert.rejects(store.start({ ...request, operationKey: 'new-effect' }), { code: 'ENOENT' });
});
test('session/workspace ownership, private paths and handle identities are checked', async t => {
  const f = fixture(t), h = await f.start('printf owned'); await h.wait({ timeoutMs: 5000 });
  const other = new LocalCommandStore({ ...f.config, sessionId: 'other' });
  assert.throws(() => other.connect(h.commandId));
  const differentWorkspace = join(f.root, 'other-workspace'); mkdirSync(differentWorkspace);
  assert.throws(() => new LocalCommandStore({ ...f.config, workspaceRoot: differentWorkspace }).connect(h.commandId));
  for (const id of ['../escape', '0'.repeat(63), 'A'.repeat(64), 123]) assert.throws(() => f.store.connect(id));
  assert.throws(() => new LocalCommandStore({ ...f.config, stateRoot: join(f.workspace, 'state') }), { code: 'background_state_inside_workspace' });
  symlinkSync(f.config.stateRoot, join(f.root, 'linked-state'));
  assert.throws(() => new LocalCommandStore({ ...f.config, stateRoot: join(f.root, 'linked-state') }), { code: 'background_state_symlink' });
  const stdout = join(h.directory, 'stdout'); rmSync(stdout); symlinkSync(join(f.workspace, 'outside'), stdout);
  assert.throws(() => h.readOutput(), { code: 'background_state_not_private' });
});
test('byte windows preserve UTF-8 boundaries and BOMs and reject invalid cursors', async t => {
  const f = fixture(t), h = await f.start("printf '\\357\\273\\277A\\342\\202\\254BC'"); await h.wait({ timeoutMs: 5000 });
  const first = h.readOutput({ maxBytes: 4 }); assert.equal(first.stdout, '\uFEFFA'); assert.equal(first.stdoutCursor, 4); assert.equal(first.outputMayBeTruncated, true);
  const second = h.readOutput({ stdoutCursor: 4, maxBytes: 4 }); assert.equal(second.stdout, '€B'); assert.equal(second.stdoutCursor, 8);
  const last = h.readOutput({ stdoutCursor: 8, maxBytes: 4 }); assert.equal(last.stdout, 'C'); assert.equal(last.stdoutCursor, 9);
  assert.throws(() => h.readOutput({ stdoutCursor: 5 }), { code: 'background_output_cursor_not_utf8_boundary' });
  assert.throws(() => h.readOutput({ stdoutCursor: 100 }), { code: 'background_output_cursor_past_end' });
  assert.throws(() => h.readOutput({ stdoutCursor: -1 }), { code: 'invalid_background_output_cursor' });
  assert.throws(() => h.readOutput({ maxBytes: 3 }), { code: 'invalid_background_output_window' });
});
test('complete waits return all retained bytes with matching cursors rather than a window cursor', async t => {
  const f = fixture(t), h = await f.start("printf '%070000d' 0");
  const result = await h.wait({ timeoutMs: 5000 }); assert.equal(result.stdout, '0'.repeat(70000));
  assert.equal(result.stdoutCursor, 70000); assert.equal(result.stderrCursor, 0); assert.equal(result.outputMayBeTruncated, false);
  const window = h.readOutput({ maxBytes: 4 }); assert.equal(window.stdout, '0000'); assert.equal(window.stdoutCursor, 4); assert.equal(window.outputMayBeTruncated, true);
});
test('timeout and output-limit results retain final diagnostics and UTF-8 tail bytes', async t => {
  const f = fixture(t), timeout = await f.start('/bin/sleep 60', { timeoutMs: 200 });
  const expired = await timeout.wait({ timeoutMs: 5000 }); assert.equal(expired.status, 'timed_out'); assert.equal(expired.exitCode, 124); assert.match(expired.stderr, /command timed out/);
  const capped = await f.start("printf '\\342\\202\\254'", { settings: { wallSeconds: 10, maxOutputBytes: 2 } });
  const result = await capped.wait({ timeoutMs: 5000 }); assert.equal(result.status, 'output_limit'); assert.equal(result.exitCode, 122);
  assert.equal(result.stdout, '�'); assert.equal(result.stdoutCursor, 3); assert.equal(result.outputMayBeTruncated, true);
  assert.match(result.stderr, /command output limit exceeded/);
});
test('owned cancellation kills TERM-ignoring descendants without accepting a PID', async t => {
  const f = fixture(t), h = await f.start('(/bin/sh -c \'trap "" TERM; while :; do /bin/sleep 1; done\') & printf "%s" "$!" > child.pid; wait');
  const pid = await until(() => pidFile(join(f.workspace, 'child.pid')));
  h.requestCancel(); const result = await h.wait({ timeoutMs: 5000 });
  assert.equal(result.status, 'canceled'); assert.equal(result.cancelRequested, true); assert.ok(result.exitCode < 0);
  await until(() => !alive(pid)); assert.equal(await h.kill(), true);
});
test('aborted/timed-out output waits do not cancel a background command', async t => {
  const f = fixture(t), h = await f.start('/bin/sleep 1; printf finished');
  await assert.rejects(h.wait({ timeoutMs: 0 }), { code: 'background_command_still_running' });
  const controller = new AbortController(); controller.abort(Error('stop observation'));
  await assert.rejects(h.wait({ signal: controller.signal }), /stop observation/);
  assert.equal(h.readOutput().cancelRequested, false); assert.equal((await h.wait({ timeoutMs: 5000 })).stdout, 'finished');
});
test('supervisor receives a private request without inheriting Host secrets or Node options', async t => {
  const f = fixture(t), secret = 'synthetic-command-secret-unique';
  const poison = join(f.root, 'poison.mjs'), marker = join(f.root, 'poison-executed');
  writeFileSync(poison, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'injected');`);
  const before = { HOST_ONLY_SECRET: process.env.HOST_ONLY_SECRET, NODE_OPTIONS: process.env.NODE_OPTIONS };
  let h;
  try {
    process.env.HOST_ONLY_SECRET = 'synthetic-host-secret'; process.env.NODE_OPTIONS = '--import=' + pathToFileURL(poison).href;
    h = await f.start('/bin/sleep 0.3; printf "%s:%s" "$REQUEST_SECRET" "$HOST_ONLY_SECRET"', {
      env: { PATH: '/no-programs', REQUEST_SECRET: secret },
    });
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const record = readFileSync(join(h.directory, 'record.json'), 'utf8'); assert.equal(record.includes(secret), false); assert.equal(record.includes('REQUEST_SECRET'), false);
  if (process.platform === 'linux') {
    assert.equal(readFileSync(`/proc/${h.processId}/cmdline`, 'utf8').includes(secret), false);
    const env = readFileSync(`/proc/${h.processId}/environ`, 'utf8'); assert.equal(env.includes(secret), false); assert.equal(env.includes('NODE_OPTIONS='), false);
  }
  assert.equal((await h.wait({ timeoutMs: 5000 })).stdout, secret + ':');
  assert.equal(existsSync(marker), false);
});
test('canonical observation reader is nonblocking, owned and does not rewrite a lost command record', async t => {
  const f = fixture(t), operationKey = 'observation', h = await f.start('printf observed', { operationKey }); await h.wait({ timeoutMs: 5000 });
  const reader = createLocalBackgroundReader(f.store), signal = new AbortController().signal;
  const request = { sessionId: f.config.sessionId, ref: { taskId: h.commandId, operationKey, sourceRunId: 'run' },
    stdoutCursor: 0, stderrCursor: 0, maxBytes: 8192, waitSeconds: 0, signal };
  assert.equal((await reader(request)).stdout, 'observed');
  await assert.rejects(reader({ ...request, sessionId: 'other' }), { code: 'background_reader_owner_mismatch' });
  await assert.rejects(reader({ ...request, ref: { ...request.ref, operationKey: 'forged' } }), { code: 'background_reader_owner_mismatch' });
  await assert.rejects(reader({ ...request, waitSeconds: 1 }), { code: 'background_observation_must_not_wait' });
  const controller = new AbortController(); controller.abort(Error('aborted read'));
  await assert.rejects(reader({ ...request, signal: controller.signal }), /aborted read/);
  const lostKey = 'lost-observation', lost = await f.start('printf "%s" "$$" > reader.pid; exec /bin/sleep 60', { operationKey: lostKey });
  const pid = await until(() => pidFile(join(f.workspace, 'reader.pid'))); process.kill(lost.processId, 'SIGKILL'); await until(() => !alive(pid));
  const record = readFileSync(join(lost.directory, 'record.json'));
  const unknown = await reader({ ...request, ref: { ...request.ref, taskId: lost.commandId, operationKey: lostKey } });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.evidenceIncomplete, true);
  assert.deepEqual(readFileSync(join(lost.directory, 'record.json')), record);
});
for (const lost of [false, true]) test(`Native SQLite loop observes a real ${lost ? 'lost' : 'completed'} command after ledger reopen without relaunch`, async t => {
  const f = fixture(t), filename = join(f.root, 'native.sqlite'); let ledger = new SqliteRunStore(filename);
  t.after(() => ledger.close()); let launched = 0, paused = false, handle;
  const launcher = tool({ name: 'run_command', readOnly: false, concurrentSafe: false, timeoutMs: 3000,
    backgroundCommandPolicy: 'owned-command-launch/v1' });
  const { config, snapshot } = coreFixture({ tools: [launcher], backgroundNotificationPolicy: 'completed-before-model/v1' });
  const first = new NativeKernel({ store: ledger, digest: coreDigest, owner: 'launcher', now: () => 1,
    onCheckpoint: async state => { if (state.backgroundCommands.length && !paused) { paused = true; first.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} }); } },
    ports: { model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] }) }, tools: { execute: async request => {
      launched++; handle = await f.start(lost ? 'printf x >> counter; printf "%s" "$$" > kernel.pid; exec /bin/sleep 60'
        : 'printf x >> counter; printf integrated-output', { operationKey: request.operationKey });
      return { status: 'ok', content: { backend: 'sandbox/local_process', task_id: handle.commandId },
        backgroundCommandRef: { taskId: handle.commandId, sourceRunId: request.runId, operationKey: request.operationKey } };
    } } } });
  first.start(snapshot, config); assert.equal((await first.runUntilIdle(scope, 'run')).phase, 'paused');
  if (lost) {
    const pid = await until(() => pidFile(join(f.workspace, 'kernel.pid'))); process.kill(handle.processId, 'SIGKILL'); await until(() => !alive(pid));
  } else await handle.wait({ timeoutMs: 5000 });
  ledger.close(); ledger = new SqliteRunStore(filename);
  const lease = ledger.acquire(scope, 'run', 'resume-host', 100, 30), before = ledger.load(scope, 'run').snapshot;
  ledger.commit(scope, 'run', lease, 100, before.revision, transition(before, { phase: 'preparing_context', resumePhase: null })); ledger.release(scope, 'run', lease);
  const background = createBackgroundCommandPort({ scope, store: ledger, readers: { local_process: createLocalBackgroundReader(new LocalCommandStore(f.config)) } });
  let models = 0;
  const resumed = new NativeKernel({ store: ledger, digest: coreDigest, owner: 'observer', now: () => 100, ports: {
    background, tools: { execute: async () => assert.fail('observation cannot replay a command') },
    model: { generate: async request => {
      models++; const notices = request.messages.filter(message => message.kind === 'background_command_observation');
      assert.equal(notices.length, 1); assert.match(notices[0].content, /integrated-output/);
      return { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } },
  } });
  const result = await resumed.runUntilIdle(scope, 'run'); assert.equal(launched, 1); assert.equal(models, lost ? 0 : 1);
  assert.equal(result.phase, lost ? 'interrupted' : 'completed');
  if (lost) assert.equal(result.reason, 'effect_outcome_unknown');
  const notices = result.messages.filter(message => message.kind === 'background_command_observation'); assert.equal(notices.length, 1);
  const observation = JSON.parse(notices[0].content).commands[0]; assert.equal(observation.status, lost ? 'unknown' : 'completed');
  assert.equal(observation.evidenceIncomplete, lost); assert.equal(result.backgroundCommands[0].notified, true);
  assert.equal(ledger.load(scope, 'run').events.filter(event => event.kind === 'background.commands_observed').length, 1);
  assert.deepEqual(await resumed.runUntilIdle(scope, 'run'), result);
  assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
});
test('disposable Host SIGKILL leaves the supervisor running and a restarted Host never relaunches', async t => {
  const f = fixture(t), request = f.input('printf x >> counter; /bin/sleep 1; printf survived', { operationKey: 'host-loss' });
  const child = nodeChild(`import {LocalCommandStore} from ${JSON.stringify(moduleUrl)};
    const h=await new LocalCommandStore(${JSON.stringify(f.config)}).start(${JSON.stringify(request)});
    console.log(h.commandId); setInterval(()=>{},1000);`);
  t.after(() => { if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL'); });
  const id = await until(child.line), h = f.store.connect(id); f.handles.push(h);
  await until(() => existsSync(join(f.workspace, 'counter'))); child.child.kill('SIGKILL'); assert.equal((await child.exit).signal, 'SIGKILL');
  const result = await new LocalCommandStore(f.config).connect(id).wait({ timeoutMs: 5000 });
  assert.equal(result.status, 'completed'); assert.equal(result.stdout, 'survived');
  assert.equal((await f.store.start(request)).commandId, id); assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
});
test('supervisor SIGKILL closes the command owner pipe; unknown outcomes cannot be replayed', async t => {
  const f = fixture(t), request = f.input('printf x >> counter; printf "%s" "$$" > target.pid; exec /bin/sleep 60', { operationKey: 'supervisor-loss' });
  const h = await f.store.start(request); f.handles.push(h); const pid = await until(() => pidFile(join(f.workspace, 'target.pid')));
  process.kill(h.processId, 'SIGKILL'); await until(() => !alive(pid));
  const result = await until(() => { const value = h.readOutput(); return value.status === 'unknown' && value; });
  assert.equal(result.evidenceIncomplete, true); assert.equal(result.exitCode, null); assert.equal(result.observedExitCode, null);
  await assert.rejects(h.wait(), { code: 'background_command_outcome_unknown' });
  const again = await new LocalCommandStore(f.config).start(request); assert.equal(again.commandId, h.commandId); assert.equal(again.readOutput().status, 'unknown');
  assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
});
test('a real output publication failure records its stages and cannot relaunch the command', async t => {
  const f = fixture(t), request = f.input('printf x >> counter; while [ ! -f release ]; do /bin/sleep 0.02; done; printf result',
    { operationKey: 'publication-failure' });
  const h = await f.store.start(request); f.handles.push(h);
  await until(() => existsSync(join(f.workspace, 'counter')));
  const stdout = join(h.directory, 'stdout'); chmodSync(stdout, 0o644);
  writeFileSync(join(f.workspace, 'release'), 'go');
  const record = await until(() => {
    const value = JSON.parse(readFileSync(join(h.directory, 'record.json'), 'utf8'));
    return value.status === 'unknown' && value;
  });
  chmodSync(stdout, 0o600);
  assert.equal(record.commandEvidence.stage, 'publish');
  assert.deepEqual(record.commandEvidence.causes, ['output_recording_failed', 'private_state_invalid']);
  assert.equal(record.exitCode, null);
  const observed = h.readOutput(); assert.equal(observed.status, 'unknown');
  assert.deepEqual(observed.commandEvidence, record.commandEvidence);
  const again = await new LocalCommandStore(f.config).start(request);
  assert.equal(again.commandId, h.commandId); assert.equal(again.readOutput().status, 'unknown');
  assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
});
test('process exit immediately after durable intent, before supervisor spawn, never starts an effect on recovery', async t => {
  const f = fixture(t), request = f.input('printf forbidden > forbidden', { operationKey: 'before-spawn' });
  const child = nodeChild(`import{createRequire,syncBuiltinESMExports}from'node:module';
    const cp=createRequire(import.meta.url)('node:child_process');cp.spawn=()=>process.exit(73);syncBuiltinESMExports();
    const{LocalCommandStore}=await import(${JSON.stringify(moduleUrl)});await new LocalCommandStore(${JSON.stringify(f.config)}).start(${JSON.stringify(request)});`);
  assert.equal((await child.exit).code, 73);
  const h = await f.store.start(request); f.handles.push(h); assert.equal(existsSync(join(f.workspace, 'forbidden')), false);
  await until(() => h.readOutput().status === 'unknown', 6500);
  assert.equal((await f.store.start(request)).readOutput().status, 'unknown'); assert.equal(existsSync(join(f.workspace, 'forbidden')), false);
});
test('failed supervisor spawn returns an owned unknown locator that a repaired Host cannot relaunch', async t => {
  const f = fixture(t), request = f.input('printf forbidden > forbidden', { operationKey: 'spawn-failure' });
  const child = nodeChild(`const{LocalCommandStore}=await import(${JSON.stringify(moduleUrl)});
    Object.defineProperty(process,'execPath',{value:'/nonexistent/native-node'});
    const h=await new LocalCommandStore(${JSON.stringify(f.config)}).start(${JSON.stringify(request)});console.log(JSON.stringify(h.readOutput()));`);
  const result = await child.exit; assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'unknown');
  const h = await f.store.start(request); f.handles.push(h); assert.equal(h.readOutput().status, 'unknown');
  assert.equal(existsSync(join(f.workspace, 'forbidden')), false);
});
if (process.platform === 'linux' && process.getuid() !== 0) test('failed POSIX control admission preserves unknown evidence and the observed exit code', async t => {
  const f = fixture(t), request = f.input('printf forbidden > forbidden', { operationKey: 'controls-failure', settings: { wallSeconds: 10, maxProcesses: 1 } });
  const h = await f.store.start(request); f.handles.push(h);
  const result = await until(() => { const output = h.readOutput(); return output.status === 'unknown' && output; });
  assert.equal(result.exitCode, null); assert.equal(result.observedExitCode, 125); assert.equal(result.evidenceIncomplete, true);
  assert.equal(existsSync(join(f.workspace, 'forbidden')), false);
  assert.equal((await f.store.start(request)).readOutput().status, 'unknown');
});
test('crash during private preparation exposes no half-created command and proves no dispatch', async t => {
  const f = fixture(t), request = f.input('printf x >> counter', { operationKey: 'preparation' });
  const id = f.store.commandId(request.operationKey);
  const child = nodeChild(`import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';
    const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to).endsWith('/'+${JSON.stringify(id)}))process.exit(72);return rename(from,to);};syncBuiltinESMExports();
    const{LocalCommandStore}=await import(${JSON.stringify(moduleUrl)});await new LocalCommandStore(${JSON.stringify(f.config)}).start(${JSON.stringify(request)});`);
  assert.equal((await child.exit).code, 72); assert.equal(existsSync(join(f.workspace, 'counter')), false);
  assert.equal(existsSync(join(f.store.directory, id)), false); // Protocol proves no spawn was possible.
  const h = await f.store.start(request); f.handles.push(h); assert.equal((await h.wait({ timeoutMs: 5000 })).status, 'completed');
  assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
});
for (const phase of ['after-stdout', 'before-terminal', 'after-terminal']) test(`real supervisor crash ${phase} preserves output/receipt order and never repeats the command`, async t => {
  const f = fixture(t), proof = join(f.root, 'crash-proof'), injection = join(f.root, 'fault.mjs');
  const request = f.input('printf x >> counter; printf final-output; printf final-diagnostic >&2', { operationKey: phase });
  writeFileSync(injection, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
    const rename=fs.renameSync;fs.renameSync=(from,to)=>{
      const terminal=String(to).endsWith('/record.json')&&JSON.parse(fs.readFileSync(from,'utf8')).status==='completed';
      const selected=${JSON.stringify(phase)}==='after-stdout'?String(to).endsWith('/stdout'):terminal;
      if(!selected)return rename(from,to);
      if(terminal){const d=String(to).slice(0,-'record.json'.length);
        if(fs.readFileSync(d+'stdout','utf8')!=='final-output'||fs.readFileSync(d+'stderr','utf8')!=='final-diagnostic')process.exit(99);}
      if(${JSON.stringify(phase)}!=='before-terminal')rename(from,to);
      fs.writeFileSync(${JSON.stringify(proof)},'injected');process.exit(74);};syncBuiltinESMExports();`);
  const child = nodeChild(`import{createRequire,syncBuiltinESMExports}from'node:module';
    const cp=createRequire(import.meta.url)('node:child_process'),spawn=cp.spawn;
    cp.spawn=(file,args,opts)=>spawn(file,['--import',${JSON.stringify(pathToFileURL(injection).href)},...args],opts);syncBuiltinESMExports();
    const{LocalCommandStore}=await import(${JSON.stringify(moduleUrl)});const h=await new LocalCommandStore(${JSON.stringify(f.config)}).start(${JSON.stringify(request)});console.log(h.commandId);`);
  const id = await until(child.line), h = f.store.connect(id); f.handles.push(h);
  const exited = await child.exit; assert.equal(exited.code, 0, exited.stderr); await until(() => existsSync(proof));
  const expected = phase === 'after-terminal' ? 'completed' : 'unknown';
  await until(() => h.readOutput().status === expected);
  const result = h.readOutput(); assert.equal(result.stdout, 'final-output');
  if (phase !== 'after-stdout') assert.equal(result.stderr, 'final-diagnostic');
  assert.equal((await f.store.start(request)).readOutput().status, expected);
  assert.equal(readFileSync(join(f.workspace, 'counter'), 'utf8'), 'x');
});
