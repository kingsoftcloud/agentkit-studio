/** Production DSH ledger, lifecycle, command tools, SDK adapter and supervisors.
 * The E2B network/file peer is an explicit double; commands are real Bash. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDshNodeE2BCommandTools } from '../src/providers/dsh-node-e2b-command-tools.mjs';
import { createDshE2BCommandTools } from '../packages/agentkit-harness/src/native/e2b-command-tools.mjs';
import { commandDigest, commandStateRoot } from '../src/providers/dsh-node-command-ledger.mjs';
import { skillE2BSdk } from './fixtures/native-skill-e2b-sdk.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) { const end = performance.now() + 15000;
  while (!predicate()) { assert.ok(performance.now() < end, 'expected command boundary'); await pause(20); } }
function commandRecords(root) {
  return existsSync(root) ? readdirSync(root, { recursive: true })
    .filter(path => /^commands\/[a-f0-9]{64}\/[a-f0-9]{64}\/e2b-processes\/commands\/[a-f0-9]{64}\/[a-f0-9]{64}\/record\.json$/u.test(path.split(sep).join('/')))
    .map(path => ({ path: join(root, path), record: JSON.parse(readFileSync(join(root, path), 'utf8')) })) : [];
}
function setup(t, { peer: options = {}, ...extra } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-e2b-command-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot);
  let loads = 0;
  const peer = skillE2BSdk(t, { root: join(root, 'peer'), signalExitCodes: true, before(method) {
    if (method === 'create' || method === 'run') {
      const files = readdirSync(stateDir, { recursive: true }).filter(path => /^commands\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\/record\.json$/u.test(path.split(sep).join('/')));
      assert.ok(files.some(file => JSON.parse(readFileSync(join(stateDir, file), 'utf8')).request.call.name === 'run_command'));
      if (method === 'run') assert.ok(commandRecords(stateDir).length, 'durable command intent before SDK run');
    }
  }, ...options });
  const config = { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }, agentId: 'agent', agentRevision: 3,
    workspaceRoot, stateDir, env: { KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'fixed-template', KSADK_SANDBOX_TIMEOUT: '15',
      E2B_API_URL: 'https://fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'never-persist-secret', HOST_SECRET: 'never-inherit' },
    loadSdk: async () => { loads++; return peer.sdk; }, ...extra };
  const ports = [], open = overrides => { const port = createDshNodeE2BCommandTools({ ...config, ...overrides }); ports.push(port); return port; };
  const port = open(), execution = (name, args, callId = 'call', sessionId = 'session') => ({ name, arguments: args, callId,
    agent: { session: { id: sessionId } }, signal: new AbortController().signal });
  const run = (name, args, callId = 'call', sessionId = 'session', target = port) => target.execute(name, args, execution(name, args, callId, sessionId));
  const ledgerFile = (callId = 'call', sessionId = 'session') => join(commandStateRoot(stateDir, workspaceRoot, config.agentId).root,
    commandDigest({ agentId: config.agentId, sessionId }), commandDigest(callId), 'record.json');
  t.after(async () => { ports.forEach(port => port.close());
    await until(() => commandRecords(stateDir).every(({ record }) => ['completed','failed','canceled','timed_out','unknown','output_limit'].includes(record.status)));
    rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceRoot, stateDir, config, peer, port, open, run, execution, ledgerFile, get loads() { return loads; } };
}

test('real E2B foreground command, exact output and original DSH identities survive duplicate/cold calls without SDK reentry', async t => {
  const h = setup(t); assert.equal(h.loads, 0); assert.equal(h.port.binding.backend, 'e2b');
  const status = await h.run('sandbox_status', {}, 'status'); assert.equal(status.status, 'ok');
  assert.equal(status.content.backend, 'e2b'); assert.equal(status.content.sandbox_phase, 'absent'); assert.equal(h.peer.calls.length, 0);
  const args = { command: 'printf x >> counter; printf "你好😀:$HOST_SECRET:$EXPLICIT"; exit 7', env: { EXPLICIT: 'caller' } };
  const first = await h.run('run_command', args); assert.equal(first.status, 'ok', JSON.stringify(first));
  assert.equal(first.content.stdout, '你好😀::caller'); assert.equal(first.content.exit_code, 7);
  assert.equal(readFileSync(join(h.root, 'peer/skill-peer-1/tmp/counter'), 'utf8'), 'x');
  const saved = readFileSync(h.ledgerFile(), 'utf8'), record = JSON.parse(saved);
  assert.equal(record.phase, 'finished'); assert.equal(record.request.agentId, 'agent'); assert.equal(record.request.sessionId, 'session');
  assert.equal(record.taskId, first.content.task_id); assert.equal(record.request.call.callId, 'call');
  for (const key of ['scope','runId','turnId','buildId','executionFence']) assert.equal(key in record.request, false);
  assert.doesNotMatch(saved, /never-persist-secret|never-inherit/u);
  const creates = h.peer.calls.filter(call => call.method === 'create'); assert.equal(creates.length, 1);
  assert.equal(creates[0].options.metadata.nativeOwner, undefined); assert.ok(creates[0].options.metadata.dshOwner);
  const count = h.peer.calls.length, loads = h.loads; h.port.close();
  assert.deepEqual(await h.run('run_command', args, 'call', 'session', h.open()), first); assert.equal(h.peer.calls.length, count); assert.equal(h.loads, loads);
  assert.equal(readFileSync(h.ledgerFile(), 'utf8'), saved);
  assert.equal((await h.run('run_command', { command: 'printf bad >> counter' }, 'call', 'session', h.open())).status, 'error');
  const source = new URL('../src/providers/dsh-node-e2b-command-tools.mjs', import.meta.url).href;
  const code = `import {createDshNodeE2BCommandTools} from ${JSON.stringify(source)};const config=JSON.parse(process.argv[1]),args=JSON.parse(process.argv[2]);
    config.ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};config.loadSdk=()=>{throw Error('cold duplicate cannot import SDK')};
    const result=await createDshNodeE2BCommandTools(config).execute('run_command',args,{agent:{session:{id:'session'}},name:'run_command',callId:'call',arguments:args,signal:new AbortController().signal});
    process.stdout.write(JSON.stringify({pid:process.pid,result}));`;
  const cold = JSON.parse(execFileSync(process.execPath, ['--input-type=module','-e',code,JSON.stringify({ ...h.config, ctx: undefined, loadSdk: undefined }),JSON.stringify(args)],
    { encoding: 'utf8', env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python' } }));
  assert.notEqual(cold.pid, process.pid); assert.deepEqual(cold.result, first); assert.equal(readFileSync(h.ledgerFile(), 'utf8'), saved);
});

test('concurrent owners cannot execute one call twice; distinct Agent/Session ownership remains separate', async t => {
  const h = setup(t), args = { command: 'printf x >> counter; sleep 0.2; printf done' };
  const [first, duplicate] = await Promise.all([h.run('run_command', args), h.run('run_command', args, 'call', 'session', h.open())]);
  assert.deepEqual(first, duplicate); assert.equal(first.status, 'ok'); assert.equal(h.peer.calls.filter(call => call.method === 'run').length, 1);
  assert.equal((await h.run('run_command', args, 'call', 'other')).status, 'ok');
  assert.equal((await h.run('run_command', args, 'call', 'session', h.open({ agentId: 'other-agent' }))).status, 'ok');
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 3);
});

test('background UTF-8 byte cursors, cold reads, task ownership and confirmed cancel keep the original command deadline', async t => {
  const h = setup(t), args = { command: 'printf "你好😀"; sleep 30', background: true, background_timeout: 10 };
  const launch = await h.run('run_command', args); assert.equal(launch.status, 'ok'); const task_id = launch.content.task_id;
  assert.equal(launch.backgroundCommandRef.sourceCallId, 'call'); assert.equal(launch.backgroundCommandRef.sourceRunId, undefined);
  const reopened = h.open(); h.port.close();
  await until(() => commandRecords(h.stateDir).some(({ path }) => existsSync(join(dirname(path), 'stdout')) && readFileSync(join(dirname(path), 'stdout'), 'utf8') === '你好😀'));
  const first = await h.run('read_command_output', { task_id, max_bytes: 4 }, 'read', 'session', reopened);
  assert.equal(first.status, 'ok'); assert.equal(first.content.stdout, '你'); assert.equal(first.content.stdout_cursor, 3);
  const second = await h.run('read_command_output', { task_id, stdout_cursor: 3, max_bytes: 4 }, 'read2', 'session', reopened);
  assert.equal(second.content.stdout, '好'); assert.equal(second.content.stdout_cursor, 6);
  const before = commandRecords(h.stateDir)[0].record, count = h.peer.calls.length;
  assert.equal((await h.run('stop_command', { task_id }, 'foreign', 'other', reopened)).status, 'error');
  assert.equal((await h.run('read_command_output', { task_id }, 'foreign', 'session', h.open({ agentId: 'other-agent' }))).status, 'error');
  for (const options of [{ agentRevision: 4 }, { buildId: 'other-build' }, { env: { ...h.config.env, E2B_API_URL: 'https://foreign.fixture.invalid' } }])
    assert.equal((await h.run('read_command_output', { task_id }, 'foreign', 'session', h.open(options))).status, 'error');
  assert.equal(h.peer.calls.length, count);
  const stop = await h.run('stop_command', { task_id }, 'stop', 'session', reopened);
  assert.equal(stop.status, 'ok'); assert.equal(stop.content.cancel_requested, true);
  const done = await h.run('read_command_output', { task_id, wait_seconds: 3 }, 'final', 'session', reopened);
  assert.equal(done.content.status, 'canceled'); assert.equal(done.content.exit_code, 143);
  const after = commandRecords(h.stateDir)[0].record; assert.equal(after.createdAt, before.createdAt); assert.equal(after.timeoutMs, before.timeoutMs);
  assert.equal(h.peer.calls.filter(call => call.method === 'kill-command').length, 1);
  assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 0);
});

test('large output retains exact full JSON in a Session-owned artifact', async t => {
  const h = setup(t), first = await h.run('run_command', { command: "awk 'BEGIN {for(i=0;i<40000;i++) printf \"界\"}'" });
  assert.equal(first.status, 'ok'); assert.equal(first.content.output_budget.truncated, true);
  const full = readFileSync(first.content.output_budget.artifact_uri, 'utf8'), stdout = Buffer.from(JSON.parse(full).stdout);
  assert.equal(stdout.length, 120000); assert.equal(createHash('sha256').update(stdout).digest('hex'), createHash('sha256').update('界'.repeat(40000)).digest('hex'));
  assert.equal(first.artifactRefs[0].sizeBytes, Buffer.byteLength(full)); assert.ok(Buffer.byteLength(JSON.stringify(first.content)) <= 24000);
});

test('cancel and Host retirement after a real foreground effect retain unknown receipts and do not kill or relaunch the remote process', async t => {
  for (const mode of ['cancel', 'retire']) {
    const h = setup(t), args = { command: 'printf effect > effect; sleep 30' }, exec = h.execution('run_command', args);
    const controller = new AbortController(); exec.signal = controller.signal;
    const pending = h.port.execute(exec.name, args, exec);
    await until(() => existsSync(join(h.root, 'peer/skill-peer-1/tmp/effect')));
    if (mode === 'cancel') controller.abort(); else h.port.close();
    const first = await pending; assert.equal(first.status, 'uncertain'); assert.match(first.content.task_id, /^[a-f0-9]{64}$/u);
    const count = h.peer.calls.length, saved = readFileSync(h.ledgerFile(), 'utf8');
    assert.deepEqual(await h.run('run_command', args, 'call', 'session', h.open()), first);
    assert.equal(h.peer.calls.length, count); assert.equal(readFileSync(h.ledgerFile(), 'utf8'), saved);
    assert.equal(h.peer.calls.filter(call => call.method === 'kill-command' || call.method === 'kill').length, 0);
  }
});

test('foreground process timeout is enforced by its supervisor and a proven exit remains distinguishable from unknown', async t => {
  const h = setup(t), args = { command: 'printf effect > effect; sleep 30', timeout: 1 };
  const first = await h.run('run_command', args); assert.equal(first.status, 'ok', JSON.stringify(first));
  assert.equal(first.content.status, 'timed_out'); assert.equal(first.content.exit_code, 143); assert.equal(first.content.evidence_incomplete, false);
  assert.equal(h.peer.calls.filter(call => call.method === 'kill-command').length, 1);
  const saved = readFileSync(h.ledgerFile(), 'utf8'), count = h.peer.calls.length;
  assert.deepEqual(await h.run('run_command', args, 'call', 'session', h.open()), first);
  assert.equal(h.peer.calls.length, count); assert.equal(readFileSync(h.ledgerFile(), 'utf8'), saved);
});

for (const mode of ['deny','args','execArguments','session','signal','close','cancel']) test(`approval ${mode} cannot enter the SDK or create an execution intent`, async t => {
  const ready = deferred(), answer = deferred(), h = setup(t, { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: () => { ready.resolve(); return answer.promise; } } } });
  const args = { command: 'printf forbidden' }, exec = h.execution('run_command', args), controller = new AbortController(); exec.signal = controller.signal;
  const pending = h.port.execute(exec.name, args, exec); await ready.promise;
  if (mode === 'args') args.command = 'changed'; if (mode === 'execArguments') exec.arguments = { command: 'changed' };
  if (mode === 'session') exec.agent.session = { id: 'session' }; if (mode === 'signal') exec.signal = new AbortController().signal;
  if (mode === 'close') h.port.close(); if (mode === 'cancel') controller.abort();
  answer.resolve(mode === 'deny' ? 'denied' : 'allowed-once'); const result = await pending;
  assert.equal(result.status, 'error'); assert.equal(h.loads, 0); assert.equal(h.peer.calls.length, 0); assert.equal(existsSync(h.ledgerFile()), false);
});

test('late unknown sandbox creation cannot restart after cancel or cold reopen, and retains its real late sandbox ID', async t => {
  const ready = deferred(), gate = deferred(), h = setup(t, { peer: { createGate: gate, before(method) { if (method === 'create') ready.resolve(); } } });
  const args = { command: 'printf forbidden' }, exec = h.execution('run_command', args), controller = new AbortController(); exec.signal = controller.signal;
  const pending = h.port.execute(exec.name, args, exec); await ready.promise; controller.abort(); const first = await pending;
  assert.equal(first.status, 'uncertain'); assert.match(first.content.task_id, /^[a-f0-9]{64}$/u);
  const cold = await h.run('run_command', args, 'call', 'session', h.open()); assert.deepEqual(cold, first);
  gate.resolve(); const ledgerRoot = dirname(dirname(h.ledgerFile())), ownerRoot = join(ledgerRoot, 'e2b-sandbox');
  const ownerFile = join(ownerRoot, readdirSync(ownerRoot)[0], 'owner.json');
  await until(() => JSON.parse(readFileSync(ownerFile, 'utf8')).sandboxId === 'skill-peer-1');
  assert.equal(JSON.parse(readFileSync(ownerFile, 'utf8')).phase, 'unknown');
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1); assert.equal(h.peer.calls.filter(call => call.method === 'run').length, 0);
});

test('real foreground Host SIGKILL after a script effect leaves its original ledger intent; cold reopen never imports or starts SDK', async t => {
  const h = setup(t), args = { command: 'printf effect > effect; sleep 30' }, module = new URL('../src/providers/dsh-node-e2b-command-tools.mjs', import.meta.url).href,
    peerModule = new URL('./fixtures/native-skill-e2b-sdk.mjs', import.meta.url).href;
  const code = `import {createDshNodeE2BCommandTools} from ${JSON.stringify(module)};import {skillE2BSdk} from ${JSON.stringify(peerModule)};
    const config=JSON.parse(process.argv[1]),args=JSON.parse(process.argv[2]);const peer=skillE2BSdk({after(){}},{root:process.argv[3]});
    config.ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};config.loadSdk=async()=>peer.sdk;
    await createDshNodeE2BCommandTools(config).execute('run_command',args,{agent:{session:{id:'session'}},name:'run_command',callId:'call',arguments:args,signal:new AbortController().signal});`;
  const child = spawn(process.execPath, ['--input-type=module','-e',code,JSON.stringify({ ...h.config, ctx: undefined, loadSdk: undefined }),JSON.stringify(args),join(h.root,'child-peer')],
    { env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python' }, stdio: ['ignore','ignore','pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes); t.after(() => child.kill('SIGKILL'));
  const effect = join(h.root, 'child-peer/skill-peer-1/tmp/effect'); await until(() => existsSync(effect) || child.exitCode !== null);
  assert.equal(child.exitCode, null, stderr); const closed = once(child, 'exit'); child.kill('SIGKILL'); const [exitCode, signal] = await closed;
  assert.equal(exitCode, null); assert.equal(signal, 'SIGKILL'); const saved = readFileSync(h.ledgerFile(), 'utf8');
  assert.equal(JSON.parse(saved).phase, 'executing'); const result = await h.run('run_command', args);
  assert.equal(result.status, 'uncertain'); assert.equal(result.content.task_id, JSON.parse(saved).taskId);
  assert.equal(h.loads, 0); assert.equal(h.peer.calls.length, 0); assert.equal(readFileSync(effect, 'utf8'), 'effect');
  assert.equal(readFileSync(h.ledgerFile(), 'utf8'), saved);
  for (const { path, record } of commandRecords(h.stateDir)) {
    if (Number.isInteger(record.pid)) try { process.kill(-record.pid, 'SIGKILL'); } catch {}
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('shared DSH command port rejects invented Native identity and reentrant/async authority before effects', async () => {
  for (const mode of ['native','mutation','async']) {
    let effects = 0;
    const tools = createDshE2BCommandTools({ agentId: 'agent', sessionId: 'session', owner: { ensure: () => { effects++; }, inspect: () => null },
      storeFactory: () => { effects++; }, authorize: async () => 'allow', resolveOwnedCommand: () => {},
      assertAuthority: request => { if (mode === 'mutation') request.future.value++; return mode === 'async' ? Promise.reject(Error('observed')) : true; } });
    const definition = tools.definitions.find(d => d.name === 'run_command');
    const result = await tools.execute({ agentId: 'agent', sessionId: 'session', operationKey: 'operation', call: { callId: 'call', name: 'run_command', arguments: { command: 'true' } },
      definition, signal: new AbortController().signal, future: { value: 1 }, ...(mode === 'native' ? { executionFence: 1 } : {}) });
    assert.equal(result.status, 'error'); assert.equal(effects, 0);
  }
});
