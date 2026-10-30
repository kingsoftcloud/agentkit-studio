/** Real snippet interpreters/supervisors; E2B network/control plane is an
 * explicit filesystem peer double, with no remote OS isolation claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDshNodeCodeTools } from '../src/providers/dsh-node-code-tools.mjs';
import { createDshNodeBuiltins } from '../src/providers/dsh-node-builtins.mjs';
import { commandDigest, commandStateRoot } from '../src/providers/dsh-node-command-ledger.mjs';
import { skillE2BSdk } from './fixtures/native-skill-e2b-sdk.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = performance.now() + 15000;
  while (!check()) { assert.ok(performance.now() < end, 'expected actual snippet boundary'); await pause(20); } }
function setup(t, overrides = {}, peerOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-node-code-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot); let loads = 0;
  const ledgerFile = (id = 'call', agentId = 'agent', sessionId = 'session') => join(commandStateRoot(stateDir, workspaceRoot, agentId).root,
    commandDigest({ agentId, sessionId }), commandDigest(id), 'record.json');
  const peer = skillE2BSdk(t, { root: join(root, 'peer'), commandPath: `${dirname(process.execPath)}:/usr/bin:/bin`, signalExitCodes: true,
    before(method) { if (method === 'create' || method === 'write' || method === 'run') {
      const record = JSON.parse(readFileSync(ledgerFile(), 'utf8'));
      assert.equal(record.phase, 'executing'); assert.equal(record.request.call.name, 'sandbox_run_code');
      assert.match(record.taskId, /^[a-f0-9]{64}$/u);
    } }, ...peerOptions });
  const config = { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }, agentId: 'agent', agentRevision: 3,
    workspaceRoot, stateDir, env: { KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'fixed', KSADK_SANDBOX_TIMEOUT: '15',
      E2B_API_URL: 'https://fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'never-persist-secret', HOST_SECRET: 'never-inherit' },
    loadSdk: async () => { loads++; return peer.sdk; }, ...overrides };
  const ports = [], open = extra => { const port = createDshNodeCodeTools({ ...config, ...extra }); ports.push(port); return port; }, port = open();
  const execution = (args, callId = 'call', sessionId = 'session') => ({ agent: { session: { id: sessionId } }, callId,
    name: 'sandbox_run_code', arguments: args, signal: new AbortController().signal });
  const run = (args, extra = {}) => (extra.port ?? port).execute('sandbox_run_code', args, execution(args, extra.callId, extra.sessionId));
  t.after(() => { ports.forEach(port => port.close()); rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceRoot, stateDir, config, peer, port, open, execution, run, ledgerFile, get loads() { return loads; } };
}

test('Bash snippet preserves exact source/env and a proven nonzero exit; duplicate/cold receipts never reenter SDK', async t => {
  const h = setup(t), args = { code: 'printf x >> counter; printf "你好😀:$EXPLICIT:$HOST_SECRET"; exit 7', language: ' shell ', env: { EXPLICIT: 'caller' } };
  const first = await h.run(args); assert.equal(first.status, 'ok', JSON.stringify(first)); assert.equal(first.content.stdout, '你好😀:caller:');
  assert.equal(first.content.exit_code, 7); assert.equal(first.content.execution_model, 'snippet_runner'); assert.equal(first.content.language, 'bash');
  const remote = join(h.root, 'peer/skill-peer-1', first.content.path.slice(1)); assert.equal(readFileSync(remote, 'utf8'), args.code);
  assert.equal(readFileSync(join(h.root, 'peer/skill-peer-1/tmp/counter'), 'utf8'), 'x');
  assert.equal(existsSync(first.content.path), false, 'the snippet path cannot be written on the Host');
  const saved = readFileSync(h.ledgerFile(), 'utf8'), record = JSON.parse(saved); assert.equal(record.binding.backend, 'e2b');
  assert.doesNotMatch(saved, /never-persist-secret|never-inherit/u); assert.equal(record.request.scope, undefined);
  const count = h.peer.calls.length, loads = h.loads; assert.deepEqual(await h.run(args, { port: h.open() }), first);
  assert.equal(h.peer.calls.length, count); assert.equal(h.loads, loads); assert.equal(readFileSync(h.ledgerFile(), 'utf8'), saved);
  assert.equal((await h.run({ ...args, code: 'printf changed' })).status, 'error');
  const source = new URL('../src/providers/dsh-node-code-tools.mjs', import.meta.url).href;
  const code = `import{createDshNodeCodeTools}from${JSON.stringify(source)};const config=JSON.parse(process.argv[1]),args=JSON.parse(process.argv[2]);
    config.ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};config.loadSdk=()=>{throw Error('cold SDK entry forbidden')};
    const result=await createDshNodeCodeTools(config).execute('sandbox_run_code',args,{agent:{session:{id:'session'}},name:'sandbox_run_code',callId:'call',arguments:args,signal:new AbortController().signal});
    process.stdout.write(JSON.stringify({pid:process.pid,result}));`;
  const cold = JSON.parse(execFileSync(process.execPath, ['--input-type=module','-e',code, JSON.stringify({ ...h.config, ctx: undefined, loadSdk: undefined }), JSON.stringify(args)],
    { encoding: 'utf8', env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python' } }));
  assert.notEqual(cold.pid, process.pid); assert.deepEqual(cold.result, first); assert.equal(readFileSync(h.ledgerFile(), 'utf8'), saved);
});

test('JavaScript aliases execute real Node with exact Unicode output and concurrent calls execute once', async t => {
  const h = setup(t), args = { code: 'require("node:fs").appendFileSync("counter","x"); process.stdout.write("中文😀");', language: 'nodejs' };
  const [first, duplicate] = await Promise.all([h.run(args), h.run(args, { port: h.open() })]);
  assert.equal(first.status, 'ok', JSON.stringify(first)); assert.equal(first.content.stdout, '中文😀'); assert.equal(first.content.language, 'javascript');
  assert.deepEqual(first, duplicate); assert.equal(h.peer.calls.filter(row => row.method === 'run').length, 1);
  assert.equal(readFileSync(join(h.root, 'peer/skill-peer-1/tmp/counter'), 'utf8'), 'x');
});

test('Python remains a remote language, with default/aliases encoded without importing a Host Python runtime', async t => {
  for (const language of [undefined, 'py', 'python3']) {
    const h = setup(t, {}, { commandGate(command) { assert.match(command, /exec python '\/tmp\/ksadk-run-code-[a-f0-9]{64}\.py'/u);
      throw Error('explicit peer does not run a Host Python interpreter'); } });
    const result = await h.run({ code: 'print("remote Python")', ...(language ? { language } : {}) });
    assert.equal(result.status, 'uncertain'); assert.equal(h.peer.calls.filter(row => row.method === 'run').length, 1);
    const count = h.peer.calls.length; assert.deepEqual(await h.run({ code: 'print("remote Python")', ...(language ? { language } : {}) }), result);
    assert.equal(h.peer.calls.length, count);
  }
});

test('unsupported language/arguments and local selection cannot create a sandbox or launch a snippet', async t => {
  const h = setup(t);
  for (const args of [{ code: 'x', language: 'ruby' }, { code: '' }, { code: 'x', background: true }, { code: 'x', timeout: 1.5 }])
    assert.equal((await h.run(args)).status, 'error');
  assert.equal(h.peer.calls.length, 0);
  const local = h.open({ env: {} }), result = await h.run({ code: 'printf forbidden', language: 'bash' }, { port: local });
  assert.equal(result.content.error_type, 'isolated_sandbox_required'); assert.equal(result.content.executed, false);
  assert.equal(h.peer.calls.length, 0);
});

test('real Agent/Session owners use separate snippet sandboxes and revised/foreign Build bindings cannot borrow a receipt', async t => {
  const h = setup(t, {}, { before() {} }), args = { code: 'printf owned', language: 'bash' };
  const original = await h.run(args); assert.equal(original.status, 'ok'); const count = h.peer.calls.length;
  for (const options of [{ agentRevision: 4 }, { buildId: 'foreign-build' }, { env: { ...h.config.env, E2B_API_URL: 'https://other.fixture.invalid' } }])
    assert.equal((await h.run(args, { port: h.open(options) })).status, 'error');
  assert.equal(h.peer.calls.length, count);
  assert.equal((await h.run(args, { sessionId: 'other-session' })).status, 'ok');
  assert.equal((await h.run(args, { port: h.open({ agentId: 'other-agent' }) })).status, 'ok');
  assert.equal(h.peer.calls.filter(row => row.method === 'create').length, 3);
});

test('policy denial, approval-time identity drift and asynchronous lifetime never authorize SDK entry', async t => {
  for (const mode of ['deny','drift','lifetime']) {
    const h = setup(t); let exec;
    const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) }, approval: { request: async () => {
      if (mode === 'drift') exec.agent.session = { id: 'session' }; return mode === 'deny' ? 'denied' : 'allowed-once'; } } };
    if (mode === 'lifetime') {
      assert.throws(() => h.open({ ctx, isClosed: () => Promise.reject(Error('observed')) }), /output_is_closed_invalid/u);
      assert.equal(h.loads, 0); assert.equal(existsSync(h.ledgerFile()), false); continue;
    }
    const port = h.open({ ctx });
    const args = { code: 'printf forbidden', language: 'bash' }; exec = h.execution(args);
    assert.equal((await port.execute('sandbox_run_code', args, exec)).status, 'error'); assert.equal(h.loads, 0); assert.equal(existsSync(h.ledgerFile()), false);
  }
});

test('full snippet output beyond64KiB retains exact bytes in its Session-owned artifact', async t => {
  const h = setup(t), result = await h.run({ code: 'process.stdout.write("界".repeat(40000));', language: 'js' });
  assert.equal(result.status, 'ok'); assert.equal(result.content.output_budget.truncated, true);
  const full = JSON.parse(readFileSync(result.content.output_budget.artifact_uri, 'utf8'));
  assert.equal(Buffer.byteLength(full.stdout), 120000); const sha = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha(full.stdout), sha('界'.repeat(40000))); assert.equal(full.language, 'javascript'); assert.equal(full.execution_model, 'snippet_runner');
});

test('large source uses the SDK file API rather than exceeding the remote OS argv limit', async t => {
  const h = setup(t), code = '#'.repeat(180000) + '\nprintf "large-source😀"', result = await h.run({ code, language: 'bash' });
  assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.content.stdout, 'large-source😀');
  assert.equal(readFileSync(join(h.root, 'peer/skill-peer-1', result.content.path.slice(1)), 'utf8'), code);
  assert.equal(h.peer.calls.filter(row => row.method === 'write').length, 1);
  const commands = h.peer.calls.filter(row => row.method === 'run'); assert.equal(commands.length, 1);
  assert.ok(Buffer.byteLength(commands[0].command) < 1024); assert.equal(commands[0].command.includes(code), false);
});

test('cancellation during source publication never proceeds to execution or republishes on cold replay', async t => {
  let controller;
  const h = setup(t, {}, { before(method) { if (method === 'write') controller.abort(); } }),
    args = { code: 'printf forbidden > effect', language: 'bash' }, exec = h.execution(args);
  controller = new AbortController(); exec.signal = controller.signal;
  const result = await h.port.execute('sandbox_run_code', args, exec); assert.equal(result.status, 'uncertain');
  assert.equal(h.peer.calls.filter(row => row.method === 'write').length, 1); assert.equal(h.peer.calls.filter(row => row.method === 'run').length, 0);
  const count = h.peer.calls.length; assert.deepEqual(await h.run(args, { port: h.open() }), result); assert.equal(h.peer.calls.length, count);
  assert.equal(existsSync(join(h.root, 'peer/skill-peer-1/tmp/effect')), false);
});

test('local rejection settles canceled or retired approval and observes a late failure without entering Python', { timeout: 5000 }, async t => {
  for (const mode of ['cancel', 'retire']) {
    const h = setup(t); let entered = false, reject;
    const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) }, approval: { request: () => {
      entered = true; return new Promise((_resolve, no) => { reject = no; }); } } };
    const port = h.open({ env: {}, ctx }), args = { code: 'printf forbidden', language: 'bash' }, exec = h.execution(args);
    const controller = new AbortController(); exec.signal = controller.signal;
    const pending = port.execute('sandbox_run_code', args, exec); await until(() => entered);
    if (mode === 'cancel') controller.abort(); else port.close();
    assert.equal((await pending).status, 'error'); reject(Error('late observed approval error')); await pause(20);
    assert.equal(h.loads, 0); assert.equal(existsSync(h.ledgerFile()), false);
  }
});

test('cancel/Host retirement after a real snippet effect preserve unknown task and do not relaunch or kill it', async t => {
  for (const mode of ['cancel','retire']) {
    const h = setup(t), args = { code: 'printf x > effect; sleep 30', language: 'bash' }, exec = h.execution(args), controller = new AbortController(); exec.signal = controller.signal;
    const pending = h.port.execute('sandbox_run_code', args, exec); await until(() => existsSync(join(h.root, 'peer/skill-peer-1/tmp/effect')));
    if (mode === 'cancel') controller.abort(); else h.port.close();
    const result = await pending; assert.equal(result.status, 'uncertain'); assert.match(result.content.task_id, /^[a-f0-9]{64}$/u);
    const count = h.peer.calls.length, bytes = readFileSync(h.ledgerFile(), 'utf8');
    assert.deepEqual(await h.run(args, { port: h.open() }), result); assert.equal(h.peer.calls.length, count); assert.equal(readFileSync(h.ledgerFile(), 'utf8'), bytes);
    assert.equal(h.peer.calls.filter(row => row.method === 'kill' || row.method === 'kill-command').length, 0);
  }
});

test('snippet timeout preserves a proven exit and the original immutable receipt', async t => {
  const h = setup(t), args = { code: 'printf x > effect; sleep 30', language: 'bash', timeout: 1 }, result = await h.run(args);
  assert.equal(result.status, 'ok'); assert.equal(result.content.status, 'timed_out'); assert.equal(result.content.exit_code, 143);
  assert.equal(result.content.evidence_incomplete, false); assert.equal(h.peer.calls.filter(row => row.method === 'kill-command').length, 1);
  assert.deepEqual(await h.run(args), result);
});

test('real Host SIGKILL after snippet effect leaves an intent; cold replay cannot import SDK', async t => {
  const h = setup(t), args = { code: 'printf x > effect; sleep 30', language: 'bash' };
  const source = new URL('../src/providers/dsh-node-code-tools.mjs', import.meta.url).href, peerSource = new URL('./fixtures/native-skill-e2b-sdk.mjs', import.meta.url).href;
  const code = `import{createDshNodeCodeTools}from${JSON.stringify(source)};import{skillE2BSdk}from${JSON.stringify(peerSource)};
    const config=JSON.parse(process.argv[1]),args=JSON.parse(process.argv[2]);config.ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};
    const peer=skillE2BSdk({after(){}},{root:process.argv[3]});config.loadSdk=async()=>peer.sdk;
    await createDshNodeCodeTools(config).execute('sandbox_run_code',args,{agent:{session:{id:'session'}},name:'sandbox_run_code',callId:'call',arguments:args,signal:new AbortController().signal});`;
  const child = spawn(process.execPath, ['--input-type=module','-e',code, JSON.stringify({ ...h.config, ctx: undefined, loadSdk: undefined }), JSON.stringify(args), join(h.root,'peer')], { stdio: ['ignore','ignore','pipe'] });
  t.after(() => child.kill('SIGKILL')); let stderr = ''; child.stderr.on('data', bytes => stderr += bytes);
  await until(() => existsSync(join(h.root, 'peer/skill-peer-1/tmp/effect'))); assert.equal(child.exitCode, null, stderr);
  const closed = once(child, 'exit'); child.kill('SIGKILL'); assert.deepEqual(await closed, [null,'SIGKILL']);
  const bytes = readFileSync(h.ledgerFile(), 'utf8'); assert.equal(JSON.parse(bytes).phase, 'executing');
  const result = await h.run(args, { port: h.open({ loadSdk: () => assert.fail('unfinished original snippet cannot reenter SDK') }) });
  assert.equal(result.status, 'uncertain'); assert.equal(readFileSync(h.ledgerFile(), 'utf8'), bytes); assert.equal(h.loads, 0);
  for (const path of readdirSync(h.stateDir, { recursive: true }).filter(path => /code-processes\/commands\/.*\/record\.json$/u.test(path))) {
    const record = JSON.parse(readFileSync(join(h.stateDir,path),'utf8')); if (Number.isInteger(record.pid)) try { process.kill(-record.pid, 'SIGKILL'); } catch {}
  }
});

test('actual builtin composition owns local run_code rejection and E2B code-only readiness', async t => {
  const h = setup(t);
  for (const backend of ['local_process','e2b']) {
    const port = createDshNodeBuiltins({ ...h.config, env: { ...h.config.env, KSADK_SANDBOX_BACKEND: backend }, toolBindings: ['run_code','component_status'] });
    t.after(() => port.close()); assert.equal(port.supports('sandbox_run_code'), true);
    assert.equal(port.supports('run_code'), false, 'reserved PTC name is never owned');
    const args = {}, exec = h.execution(args); exec.name = 'component_status';
    const status = await port.execute('component_status', args, exec); assert.equal(status.status, 'ok');
    assert.equal(status.content.sandbox.enabled, backend === 'e2b'); assert.deepEqual(status.content.sandbox.tools, backend === 'e2b' ? ['sandbox_run_code'] : []);
    assert.equal(status.content.summary.isolated_execution, backend === 'e2b' ? 'enabled' : 'not_enabled');
  }
});
