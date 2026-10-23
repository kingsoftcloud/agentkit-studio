/** Real production orchestration, lifecycle, SDK adapter, command supervisors,
 * bash and file bytes. The E2B SDK control plane/file API peer is an explicit
 * double, not online E2B or remote OS isolation acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { createDshNodeSkillWorkflowTools } from '../src/providers/dsh-node-skill-workflow-tools.mjs';
import { DSH_SKILL_E2B_RUNTIME } from '../src/providers/native-skill-e2b-runtime.mjs';
import { createDshE2BSandboxOwner, DSH_E2B_SANDBOX_OWNER } from '../packages/agentkit-harness/src/native/e2b-sandbox-owner.mjs';
import { runtimeSkill } from '../src/skill-files.mjs';
import { skillE2BSdk } from './fixtures/native-skill-e2b-sdk.mjs';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { createHash } from 'node:crypto';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
  const deadline = performance.now() + 15000;
  while (!predicate()) { assert.ok(performance.now() < deadline, 'expected E2B process boundary'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
function runtimeRecords(root) {
  return existsSync(root) ? readdirSync(root, { recursive: true })
    .filter(path => /^skill-workflows\/[a-f0-9]{64}\/runtime\/[a-f0-9]{64}\/record\.json$/u.test(path.split(sep).join('/'))).flatMap(path => {
    const file = join(root, path), record = JSON.parse(readFileSync(file, 'utf8'));
    return record.contract === DSH_SKILL_E2B_RUNTIME ? [{ file, record }] : [];
  }) : [];
}
function setup(t, { script, peer: peerOptions = {}, ...extra } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-skill-e2b-'))), workspaceRoot = join(root, 'workspace'), pkg = join(root, 'skill');
  mkdirSync(workspaceRoot); mkdirSync(join(pkg, 'scripts'), { recursive: true });
  const content = '---\nname: alpha\ndescription: Alpha task\n---\n# Alpha\n';
  writeFileSync(join(pkg, 'SKILL.md'), content);
  writeFileSync(join(pkg, 'scripts/run-workflow.sh'), script ?? 'printf x >> "$KSADK_SKILL_WORKDIR/effect"\nprintf "DSH E2B 😀" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\nprintf "\\000\\377\\001" > "$KSADK_SKILL_OUTPUT_DIR/raw.bin"', { mode: 0o700 });
  const stateDir = join(root, 'state'), peer = skillE2BSdk(t, { root: join(root, 'peer'), before(method) {
    if (['create', 'run', 'write', 'kill'].includes(method)) {
      const records = runtimeRecords(stateDir); assert.ok(records.length); assert.ok(records.some(({ record }) => record.phase === 'executing'));
      if (method === 'run') assert.ok(records.some(({ record }) => record.commands.length));
    }
  }, ...peerOptions });
  let loads = 0;
  const config = { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }, agentId: 'agent', agentRevision: 3,
    workspaceRoot, stateDir, skillDefinitions: [runtimeSkill({ name: 'alpha', content, path: join(pkg, 'SKILL.md') })],
    env: { KSADK_SANDBOX_BACKEND: 'local_process', KSADK_SKILL_RUNTIME_BACKEND: 'e2b', KSADK_SKILL_RUNTIME_TIMEOUT: '15',
      KSADK_SKILL_RUNTIME_TEMPLATE_ID: 'node-skill-template', E2B_API_URL: 'https://e2b.fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'secret-do-not-persist' },
    loadSdk: async () => { loads++; return peer.sdk; }, ...extra };
  const ports = [], open = options => { const port = createDshNodeSkillWorkflowTools({ ...config, ...options }); ports.push(port); return port; };
  const port = open(), args = { workflow_prompt: 'Use alpha', skill_names: ['alpha'] };
  const execution = (body = args, callId = 'call', sessionId = 'session') => ({ agent: { session: { id: sessionId } }, name: 'execute_skills', callId,
    arguments: body, signal: new AbortController().signal });
  const run = (body = args, exec = execution(body), target = port) => target.execute('execute_skills', body, exec);
  t.after(async () => { for (const port of ports) port.close();
    await until(() => runtimeRecords(stateDir).every(({ record }) => record.phase === 'finished'));
    rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceRoot, pkg, stateDir, config, peer, port, args, execution, run, open, get loads() { return loads; }, records: () => runtimeRecords(stateDir) };
}

test('DSH E2B uses real Agent/Session/call, exact file bytes and confirmed cleanup; completed call never makes another SDK request', async t => {
  const h = setup(t); assert.equal(h.loads, 0); assert.equal(h.port.binding.runtime.backend, 'e2b');
  const first = await h.run(); assert.equal(first.status, 'ok', canonical(first));
  assert.equal(first.content.backend, 'e2b'); assert.equal(first.content.isolated, true); assert.match(first.content.runtime_id, /^dsh-e2b-skill:/u);
  assert.equal(first.content.sandbox.cleanup_status, 'completed'); assert.equal(first.content.command_ids.length, 3);
  const artifacts = first.content.output_files.map(file => readFileSync(file));
  assert.ok(artifacts.some(bytes => bytes.equals(Buffer.from('DSH E2B 😀')))); assert.ok(artifacts.some(bytes => bytes.equals(Buffer.from([0, 255, 1]))));
  const [{ file, record }] = h.records(); assert.equal(record.request.agentId, 'agent'); assert.equal(record.request.sessionId, 'session');
  assert.equal(record.request.callId, 'call'); assert.equal(record.binding.backendContract, DSH_SKILL_E2B_RUNTIME);
  for (const key of ['scope', 'runId', 'turnId', 'buildId', 'executionFence', 'parentRunId', 'taskChainId']) assert.equal(key in record.request, false);
  const ownerRoot = join(dirname(file), 'sandbox'), owner = JSON.parse(readFileSync(join(ownerRoot, readdirSync(ownerRoot)[0], 'owner.json'), 'utf8'));
  assert.equal(owner.schemaVersion, DSH_E2B_SANDBOX_OWNER); assert.equal(owner.agentId, 'agent'); assert.equal(owner.scope, undefined);
  assert.deepEqual(owner.createIdentity, { agentId: 'agent', sessionId: 'session', callId: 'call', operationKey: 'dsh-skill-workflow:call' });
  const created = h.peer.calls.find(call => call.method === 'create');
  assert.equal(created.options.metadata.dshOwner, owner.ownerKey); assert.equal(created.options.metadata.nativeOwner, undefined);
  assert.equal(created.options.metadata.runtime, 'agentkit-dsh'); assert.equal(created.template, 'node-skill-template');
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1); assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 1);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /secret-do-not-persist/u);
  const count = h.peer.calls.length, saved = readFileSync(file, 'utf8'); h.port.close();
  const cold = h.open(); assert.deepEqual(await h.run(h.args, h.execution(), cold), first); assert.equal(h.peer.calls.length, count);
  assert.equal(readFileSync(file, 'utf8'), saved);
});

test('policy rejection and canceled late approval cause zero SDK loads, lifecycle records or commands', async t => {
  const answer = deferred(); let asked = false;
  const h = setup(t, { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: () => { asked = true; return answer.promise; } } } });
  const controller = new AbortController(), exec = h.execution(); exec.signal = controller.signal;
  const pending = h.run(h.args, exec); await until(() => asked); controller.abort(); assert.equal((await pending).status, 'error');
  answer.resolve('allowed-once'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.loads, 0); assert.equal(h.peer.calls.length, 0); assert.deepEqual(h.records(), []);
});

test('late unknown creation retains its actual sandbox identity and no duplicate or cold call can create another sandbox', async t => {
  const blocked = deferred(), entered = deferred();
  const h = setup(t, { peer: { createGate: blocked, before: method => { if (method === 'create') entered.resolve(); } } });
  const controller = new AbortController(), exec = h.execution(); exec.signal = controller.signal;
  const pending = h.run(h.args, exec); await entered.promise;
  const concurrent = await h.run(h.args, h.execution(), h.open()); assert.equal(concurrent.status, 'uncertain');
  controller.abort(); const result = await pending; assert.equal(result.status, 'uncertain');
  blocked.resolve(); await until(() => h.records()[0].record.phase === 'finished' && h.peer.sandboxes.size === 1);
  const ownerRoot = join(dirname(h.records()[0].file), 'sandbox'), ownerFile = join(ownerRoot, readdirSync(ownerRoot)[0], 'owner.json');
  await until(() => JSON.parse(readFileSync(ownerFile, 'utf8')).sandboxId === 'skill-peer-1');
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8')); assert.equal(owner.phase, 'unknown');
  const cold = await h.run(h.args, h.execution(), h.open()); assert.equal(cold.status, 'uncertain');
  assert.equal(cold.content.runtime_id, result.content.runtime_id); assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(h.peer.calls.filter(call => call.method === 'run' || call.method === 'kill').length, 0);
});

test('unconfirmed cleanup and a proven script failure preserve original outcomes without another execution or cleanup attempt', async t => {
  for (const options of [{ peer: { killResult: 'true' } }, { script: 'printf failure >&2\nexit 7' }]) {
    const h = setup(t, options), result = await h.run();
    assert.equal(result.status, options.script ? 'error' : 'uncertain');
    if (options.script) { assert.equal(result.content.commands[0].exit_code, 7); assert.equal(result.content.sandbox.cleanup_status, 'completed'); }
    else assert.equal(result.content.sandbox.cleanup_status, 'not_confirmed');
    const count = h.peer.calls.length; assert.deepEqual(await h.run(h.args, h.execution(), h.open()), result);
    assert.equal(h.peer.calls.length, count); assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 1);
  }
});

test('same call ID in other Sessions/Agents is separate; revision and endpoint changes cannot reuse the old receipt', async t => {
  const h = setup(t), first = await h.run(), second = await h.run(h.args, h.execution(h.args, 'call', 'other'));
  const third = await h.run(h.args, h.execution(), h.open({ agentId: 'other-agent' }));
  assert.equal(second.status, 'ok'); assert.equal(third.status, 'ok');
  assert.equal(new Set([first, second, third].map(result => result.content.runtime_id)).size, 3);
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 3);
  const count = h.peer.calls.length;
  for (const options of [{ agentRevision: 4 }, { buildId: 'other-build' }, { env: { ...h.config.env, E2B_API_URL: 'https://foreign.fixture.invalid' } }]) {
    assert.equal((await h.run(h.args, h.execution(), h.open(options))).status, 'uncertain');
    assert.equal(h.peer.calls.length, count);
  }
});

test('cancel, Host retirement and timeout after a real peer script effect cannot use stale cleanup authority or relaunch', async t => {
  for (const mode of ['cancel', 'retire', 'timeout']) {
    const host = new AbortController(), h = setup(t, { script: 'printf x > "$KSADK_SKILL_WORKDIR/effect"\nsleep 30', signal: host.signal });
    const env = { ...h.config.env, KSADK_SKILL_RUNTIME_TIMEOUT: mode === 'timeout' ? '5' : '15' };
    const port = h.open({ env }), controller = new AbortController(), exec = h.execution(); exec.signal = controller.signal;
    const pending = h.run(h.args, exec, port);
    await until(() => {
      const record = h.records()[0]?.record;
      return record && existsSync(join(h.root, 'peer/skill-peer-1/tmp', 'agentkit-skill-' + record.runtimeId.split(':').at(-1), 'work/effect'));
    });
    if (mode === 'cancel') controller.abort(); if (mode === 'retire') host.abort();
    const result = await pending; assert.equal(result.status, 'uncertain'); assert.match(result.content.runtime_id, /^dsh-e2b-skill:/u);
    await until(() => h.records()[0].record.phase === 'finished');
    const count = h.peer.calls.length, cold = await h.run(h.args, h.execution(), h.open({ env, signal: new AbortController().signal }));
    assert.equal(cold.status, 'uncertain'); assert.equal(cold.content.runtime_id, result.content.runtime_id);
    assert.equal(h.peer.calls.length, count); assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 0);
  }
});

test('actual SIGKILL after E2B peer script entry leaves an uncertain durable DSH call and a cold owner makes zero SDK requests', async t => {
  const h = setup(t, { script: 'printf effect > "$KSADK_SKILL_WORKDIR/effect"\nsleep 30' });
  const peerModule = new URL('./fixtures/native-skill-e2b-sdk.mjs', import.meta.url).href;
  const workflowModule = new URL('../src/providers/dsh-node-skill-workflow-tools.mjs', import.meta.url).href;
  const marker = join(h.root, 'script-entered');
  const script = `import {createDshNodeSkillWorkflowTools} from ${JSON.stringify(workflowModule)};
    import {skillE2BSdk} from ${JSON.stringify(peerModule)};import {writeFileSync} from 'node:fs';
    const config=JSON.parse(process.argv[1]),args=JSON.parse(process.argv[2]);
    const peer=skillE2BSdk({after(){}},{root:process.argv[3],before(method){},commandGate(command){if(command.includes('run-workflow.sh'))writeFileSync(process.argv[4],'entered');}});
    config.ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};config.loadSdk=async()=>peer.sdk;
    await createDshNodeSkillWorkflowTools(config).execute('execute_skills',args,{agent:{session:{id:'session'}},name:'execute_skills',callId:'call',arguments:args,signal:new AbortController().signal});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ ...h.config, ctx: undefined, loadSdk: undefined }), JSON.stringify(h.args), join(h.root, 'child-peer'), marker],
    { env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes); t.after(() => child.kill('SIGKILL'));
  let effect;
  await until(() => {
    const record = h.records()[0]?.record;
    if (!record) return false;
    effect = join(h.root, 'child-peer/skill-peer-1/tmp', 'agentkit-skill-' + record.runtimeId.split(':').at(-1), 'work/effect');
    return existsSync(marker) && existsSync(effect);
  });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); const [code, signal] = await exit;
  assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL');
  const [{ file, record }] = h.records(), saved = readFileSync(file, 'utf8'); assert.equal(record.phase, 'executing');
  const result = await h.run(); assert.equal(result.status, 'uncertain'); assert.equal(result.content.runtime_id, record.runtimeId);
  assert.equal(readFileSync(file, 'utf8'), saved); assert.equal(readFileSync(effect, 'utf8'), 'effect');
  assert.equal(h.loads, 0); assert.equal(h.peer.calls.length, 0);
  // Cleanup test-owned command processes explicitly, after the no-replay proof.
  for (const path of readdirSync(dirname(file), { recursive: true }).filter(path => path.endsWith('record.json'))) {
    const value = JSON.parse(readFileSync(join(dirname(file), path), 'utf8'));
    if (Number.isInteger(value.pid) && value.pid > 0) try { process.kill(-value.pid, 'SIGKILL'); } catch {}
  }
  rmSync(dirname(file), { recursive: true, force: true });
});

test('DSH sandbox owner rejects reentrant mutation and async authority before any SDK effect', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-e2b-owner-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = () => ({ agentId: 'agent', sessionId: 'session', operationKey: 'operation', call: { name: 'run_command', callId: 'call', arguments: { command: 'true' } },
    definition: { name: 'run_command' }, future: { value: 1 }, signal: new AbortController().signal });
  for (const [index, authority] of [req => { req.future.value = 2; return true; }, () => Promise.reject(Error('observed')), req => { req.signal = new AbortController().signal; return true; }].entries()) {
    const owner = createDshE2BSandboxOwner({ stateRoot: join(root, 'state-'+index), workspaceRoot, agentId: 'agent', sessionId: 'session', bindingDigest: 'b'.repeat(64),
      assertAuthority: authority, createSandbox: () => assert.fail('unproven authority cannot create'), killSandbox: () => assert.fail('cannot cleanup') });
    await assert.rejects(owner.ensure(request())); assert.equal(owner.inspect(), null);
  }
});

test('explicit DSH sandbox adoption requires its own metadata proof and never reconciles or relaunches a command', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-e2b-adoption-'))), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = { agentId: 'agent', sessionId: 'session', operationKey: 'create-call', call: { callId: 'call', name: 'execute_skills', arguments: {} },
    definition: { name: 'execute_skills' }, signal: new AbortController().signal };
  let creates = 0, useNativeMetadata = true;
  const config = { stateRoot: join(root, 'state'), workspaceRoot, agentId: 'agent', sessionId: 'session', bindingDigest: 'b'.repeat(64),
    assertAuthority: () => true, createSandbox: () => { creates++; throw Object.assign(Error('lost response'), { sandboxId: 'sandbox-a' }); },
    killSandbox: () => assert.fail('adoption cannot cleanup'), assertReconciliationAuthority: () => true,
    inspectSandbox: () => ({ sandboxId: 'sandbox-a', state: 'running', metadata: useNativeMetadata
      ? { nativeOwner: owner.ownerKey, nativeCreateOperation: createDigest }
      : { dshOwner: owner.ownerKey, dshCreateOperation: createDigest } }) };
  const owner = createDshE2BSandboxOwner(config); await assert.rejects(owner.ensure(request), /reconciliation/u);
  const before = owner.inspectReconciliation(), createDigest = createHash('sha256').update(canonical(before.record.createIdentity)).digest('hex');
  const decision = { sandboxId: 'sandbox-a', expectedRecordDigest: before.recordDigest };
  await assert.rejects(owner.reconcileAdoption(request, decision), /e2b_owner_reconciliation_proof_invalid/u);
  assert.deepEqual(owner.inspectReconciliation(), before); useNativeMetadata = false;
  assert.deepEqual(await owner.reconcileAdoption(request, decision), { sandboxId: 'sandbox-a', adopted: true, commandsReconciled: false });
  assert.deepEqual(await createDshE2BSandboxOwner(config).ensure(request), { sandboxId: 'sandbox-a', created: false });
  assert.equal(creates, 1);
});
