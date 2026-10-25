/** Real local scripts/process supervision. DSH policy services are explicit
 * unit doubles; the separate packed verifier covers the production registry. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, readdirSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createDshNodeSkillWorkflowTools, DSH_NODE_SKILL_WORKFLOW } from '../src/providers/dsh-node-skill-workflow-tools.mjs';
import { createDshLocalSkillRuntime, nativeSkillRuntimeSettings, DSH_LOCAL_SKILL_RUNTIME } from '../src/providers/native-skill-runtime.mjs';
import { createDshNodeBuiltins } from '../src/providers/dsh-node-builtins.mjs';
import { LocalCommandStore } from '../packages/agentkit-harness/src/native/local-background.mjs';
import { runtimeSkill } from '../src/skill-files.mjs';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';

const moduleUrl = new URL('../src/providers/dsh-node-skill-workflow-tools.mjs', import.meta.url).href;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function waitFor(predicate) {
  const until = performance.now() + 15000;
  while (!predicate()) { assert.ok(performance.now() < until, 'expected real process boundary'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
function records(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .filter(path => /^skill-workflows\/[a-f0-9]{64}\/runtime\/[a-f0-9]{64}\/record\.json$/u.test(path.split(sep).join('/'))).flatMap(path => {
    const file = join(root, path), record = JSON.parse(readFileSync(file, 'utf8'));
    return record.contract === DSH_LOCAL_SKILL_RUNTIME ? [{ file, record }] : [];
  });
}
function setup(t, { script, ...extra } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-skill-workflow-'))), workspaceRoot = join(root, 'workspace');
  const pkg = join(root, 'skill'), bin = join(root, 'bin'); mkdirSync(workspaceRoot); mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node')); symlinkSync('/bin/bash', join(bin, 'bash'));
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  const content = '---\nname: alpha\ndescription: Alpha task\n---\n# Alpha 😀\n';
  writeFileSync(join(pkg, 'SKILL.md'), content);
  writeFileSync(join(pkg, 'scripts/run-workflow.sh'), script ?? `printf x >> '${workspaceRoot}/effect'\nprintf 'DSH result 😀' > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\nprintf '\\000\\001\\377' > "$KSADK_SKILL_OUTPUT_DIR/raw.bin"\nprintf 'artifact=artifacts/result.txt\\nartifact=artifacts/raw.bin\\n'`, { mode: 0o700 });
  const config = { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }, agentId: 'agent', agentRevision: 3,
    workspaceRoot, stateDir: join(root, 'state'), skillDefinitions: [runtimeSkill({ name: 'alpha', content, path: join(pkg, 'SKILL.md') })],
    env: { KSADK_SKILL_RUNTIME_BACKEND: 'local_process', KSADK_SKILL_RUNTIME_TIMEOUT: '15', PATH: bin, PRIVATE_SECRET: 'never-inherit' }, ...extra };
  const ports = [], open = options => { const port = createDshNodeSkillWorkflowTools({ ...config, ...options }); ports.push(port); return port; };
  const port = open(), args = { workflow_prompt: 'Use alpha', skill_names: ['alpha'] };
  const execution = (body = args, callId = 'call', sessionId = 'session') => ({ agent: { session: { id: sessionId } }, callId,
    name: 'execute_skills', arguments: body, signal: new AbortController().signal });
  const run = (body = args, exec = execution(body), target = port) => target.execute('execute_skills', body, exec);
  t.after(async () => {
    for (const port of ports) port.close();
    // Cancel any retained supervisor before removing the private records.
    for (const { file, record } of records(config.stateDir)) if (record.commands.length) {
      const store = new LocalCommandStore({ stateRoot: join(file, '../..', 'processes'), workspaceRoot, sessionId: record.request.sessionId });
      for (const command of record.commands) await store.connect(command.taskId).kill();
    }
    await waitFor(() => records(config.stateDir).every(({ record }) => record.phase === 'finished'));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, pkg, config, port, open, args, execution, run, content, workspaceRoot, records: () => records(config.stateDir) };
}

test('real DSH owner executes exact local bytes once, persists no fabricated Native identity and cold-reopens', async t => {
  const h = setup(t), first = await h.run();
  assert.equal(first.status, 'ok', canonical(first)); assert.equal(first.content.isolated, false);
  assert.equal(first.content.backend, 'local_process'); assert.match(first.content.runtime_id, /^dsh-local-skill:/u);
  assert.equal(first.content.command_ids.length, 1);
  assert.equal(first.content.skill_events.at(-1).event_type, 'skill.workflow.completed');
  assert.ok(first.content.skill_events.every(event => event.run_id === '' && event.runtime_id.startsWith('dsh-local-skill:')),
    'DSH diagnostics preserve the real DSH owner and never invent a Native Run');
  const [saved] = h.records(); assert.equal(saved.record.contract, DSH_LOCAL_SKILL_RUNTIME);
  assert.equal(saved.record.request.agentId, 'agent'); assert.equal(saved.record.request.sessionId, 'session');
  assert.equal(saved.record.request.callId, 'call'); assert.equal(saved.record.binding.agentId, 'agent');
  for (const key of ['scope', 'runId', 'turnId', 'buildId', 'executionFence', 'parentRunId', 'taskChainId']) assert.equal(key in saved.record.request, false);
  const outputs = first.content.output_files.map(file => readFileSync(file));
  assert.ok(outputs.some(bytes => bytes.equals(Buffer.from('DSH result 😀'))));
  assert.ok(outputs.some(bytes => bytes.equals(Buffer.from([0, 1, 255]))));
  assert.equal(readFileSync(join(h.workspaceRoot, 'effect'), 'utf8'), 'x');
  assert.doesNotMatch(readFileSync(saved.file, 'utf8'), /never-inherit/u);
  assert.deepEqual(await h.run(), first); h.port.close();
  const reopened = h.open(); assert.deepEqual(await h.run(h.args, h.execution(), reopened), first);
  assert.equal(readFileSync(saved.file, 'utf8'), canonical(saved.record));
  const childCode = `import {createDshNodeSkillWorkflowTools} from ${JSON.stringify(moduleUrl)};
    const config=JSON.parse(process.argv[1]), args=JSON.parse(process.argv[2]);
    config.ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};
    const port=createDshNodeSkillWorkflowTools(config);
    const result=await port.execute('execute_skills',args,{agent:{session:{id:'session'}},callId:'call',name:'execute_skills',arguments:args,signal:new AbortController().signal});
    port.close();process.stdout.write(JSON.stringify({pid:process.pid,result}));`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', childCode, JSON.stringify({ ...h.config, ctx: undefined }), JSON.stringify(h.args)],
    { env: { ...process.env, PATH: h.config.env.PATH, AGENTKIT_KSADK_PYTHON: '/unavailable/python' }, timeout: 10000 });
  const proof = JSON.parse(child.stdout); assert.notEqual(proof.pid, process.pid); assert.deepEqual(proof.result, first);
  assert.equal(readFileSync(join(h.workspaceRoot, 'effect'), 'utf8'), 'x');
});

test('standing policy denies before state, one-shot approval does not grant another workflow, canceled late approval cannot dispatch', async t => {
  const answer = deferred(); let approvals = 0, held = false;
  const h = setup(t, { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) }, approval: { request: () => {
    approvals++; return held ? answer.promise : approvals === 2 ? 'allowed-once' : 'rejected';
  } } } });
  assert.equal((await h.run()).content.error_type, 'STUDIO_NATIVE_PERMISSION_DENIED'); assert.deepEqual(h.records(), []);
  assert.equal((await h.run()).status, 'ok');
  assert.equal((await h.run(h.args, h.execution(h.args, 'second'))).content.error_type, 'STUDIO_NATIVE_PERMISSION_DENIED');
  assert.equal(readFileSync(join(h.workspaceRoot, 'effect'), 'utf8'), 'x');
  held = true; const controller = new AbortController(), exec = h.execution(h.args, 'late'); exec.signal = controller.signal;
  const pending = h.run(h.args, exec); await waitFor(() => approvals === 4); controller.abort();
  assert.equal((await pending).status, 'error'); answer.resolve('allowed-once'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.records().length, 1); assert.equal(readFileSync(join(h.workspaceRoot, 'effect'), 'utf8'), 'x');
});

test('strict lifetime, original DSH identity, invalid input and prior cancellation cannot create a workflow intent', async t => {
  const h = setup(t);
  for (const verdict of [true, null, 'false', Promise.reject(Error('observed'))]) {
    const port = h.open({ isClosed: () => verdict }); assert.equal((await h.run(h.args, h.execution(), port)).status, 'error');
  }
  for (const mutate of [exec => { exec.agent = { ...exec.agent }; }, exec => { exec.agent.session = { id: 'session' }; },
    exec => { exec.callId = 'changed'; }, exec => { exec.signal = new AbortController().signal; },
    exec => { exec.arguments = { ...h.args, injected: true }; }]) {
    const exec = h.execution(), port = h.open({ isClosed: () => { mutate(exec); return false; } });
    assert.equal((await h.run(h.args, exec, port)).content.error_type, 'dsh_skill_workflow_request_drifted');
  }
  const aborted = new AbortController(); aborted.abort(); const exec = h.execution(); exec.signal = aborted.signal;
  assert.equal((await h.run(h.args, exec)).status, 'error');
  for (const args of [{ workflow_prompt: ' ' }, { workflow_prompt: 'alpha', service_url: 'https://foreign.invalid' }, { skill_names: ['alpha'] }]) {
    assert.equal((await h.run(args)).status, 'error');
  }
  assert.deepEqual(h.records(), []);
});

test('local Skill source is pinned; later script mutation cannot start a command', async t => {
  const h = setup(t); writeFileSync(join(h.pkg, 'scripts/run-workflow.sh'), 'printf forbidden');
  const result = await h.run(); assert.equal(result.status, 'uncertain');
  assert.equal(result.content.command_ids.length, 0); assert.equal(existsSync(join(h.workspaceRoot, 'effect')), false);
  assert.equal(h.records()[0].record.phase, 'finished');
});

test('same call ID in another Agent/Session gets independent ownership; a changed revision cannot replay the old receipt', async t => {
  const h = setup(t), first = await h.run(), otherSession = await h.run(h.args, h.execution(h.args, 'call', 'other-session'));
  const otherAgent = h.open({ agentId: 'other-agent' }), third = await h.run(h.args, h.execution(), otherAgent);
  assert.equal(otherSession.status, 'ok'); assert.equal(third.status, 'ok');
  assert.equal(new Set([first, otherSession, third].map(result => result.content.runtime_id)).size, 3);
  assert.equal(new Set([first, otherSession, third].flatMap(result => result.content.output_files)).size, 6);
  const before = h.records().map(({ file }) => readFileSync(file, 'utf8')).sort();
  for (const binding of [{ agentRevision: 4 }, { buildId: 'actual-frozen-build' }]) {
    const revised = h.open(binding), conflict = await h.run(h.args, h.execution(), revised);
    assert.equal(conflict.status, 'uncertain'); assert.equal(conflict.content.runtime_id, first.content.runtime_id);
  }
  assert.deepEqual(h.records().map(({ file }) => readFileSync(file, 'utf8')).sort(), before);
  assert.equal(readFileSync(join(h.workspaceRoot, 'effect'), 'utf8'), 'xxx');
});

test('a replaced private cache cannot return a stored receipt or dispatch another workflow', async t => {
  const h = setup(t), first = await h.run(); assert.equal(first.status, 'ok');
  const [{ file }] = h.records(), cacheRoot = join(file, '../../..'), retained = join(h.root, 'retained-cache'), foreign = join(h.root, 'foreign');
  mkdirSync(foreign); renameSync(cacheRoot, retained); symlinkSync(foreign, cacheRoot);
  try {
    assert.equal((await h.run()).status, 'error');
    assert.deepEqual(readdirSync(foreign), []); assert.equal(readFileSync(join(h.workspaceRoot, 'effect'), 'utf8'), 'x');
  } finally { rmSync(cacheRoot); renameSync(retained, cacheRoot); }
});

test('a noncooperative directory cannot hold cancellation or dispatch after a late response/rejection', async t => {
  for (const lateFailure of [false, true]) {
    const response = deferred(); let calls = 0;
    const h = setup(t, { skillDefinitions: [], skillSpaceIds: ['space'], connection: { bindingDigest: 'b'.repeat(64), client: {
      skillProtocol: 'rest', skillAction: () => { calls++; return response.promise; },
    } } });
    const controller = new AbortController(), exec = h.execution(); exec.signal = controller.signal;
    const pending = h.run(h.args, exec); await waitFor(() => calls === 1); controller.abort();
    const result = await pending; assert.equal(result.status, 'uncertain');
    const [{ record }] = h.records(); assert.equal(record.phase, 'executing'); assert.deepEqual(record.commands, []);
    if (lateFailure) response.reject(Error('late service failure'));
    else response.resolve({ Data: { SkillSpaceId: 'space', TotalCount: 0, Skills: [] } });
    await waitFor(() => h.records()[0].record.phase === 'finished');
    const cold = await h.run(); assert.equal(cold.status, 'uncertain');
    assert.equal(cold.content.runtime_id, result.content.runtime_id); assert.equal(calls, 1);
    assert.deepEqual(h.records()[0].record.commands, []);
  }
});

test('workflow deadline also bounds a noncooperative approval before any intent or command', async t => {
  const response = deferred(); let asked = false;
  const h = setup(t, { ctx: { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: () => { asked = true; return response.promise; } } } });
  const port = h.open({ env: { ...h.config.env, KSADK_SKILL_RUNTIME_TIMEOUT: '1' } });
  // Keep the test process alive; AbortSignal.timeout intentionally unrefs its timer.
  const keepAlive = setTimeout(() => {}, 5000); t.after(() => clearTimeout(keepAlive));
  const result = await h.run(h.args, h.execution(), port); assert.equal(asked, true); assert.equal(result.status, 'error');
  assert.deepEqual(h.records(), []); response.resolve('allowed-once'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.records(), []);
});

test('two actual runtime owners cannot duplicate a running workflow or return success for changed call arguments', async t => {
  const h = setup(t, { script: 'printf x >> "$KSADK_SKILL_WORKDIR/effect"\n/bin/sleep 1\nprintf done > "$KSADK_SKILL_OUTPUT_DIR/result.txt"' });
  const pending = h.run(); await waitFor(() => h.records().some(({ file }) => existsSync(join(file, '../work/effect'))));
  const second = h.open(), waiting = await h.run(h.args, h.execution(), second);
  assert.equal(waiting.status, 'uncertain'); assert.equal(waiting.content.error_type, 'skill_runtime_in_progress');
  const changed = { ...h.args, workflow_prompt: 'changed' };
  const conflict = await h.run(changed, h.execution(changed), second); assert.equal(conflict.status, 'uncertain');
  const done = await pending; assert.equal(done.status, 'ok'); assert.equal(waiting.content.runtime_id, done.content.runtime_id);
  assert.deepEqual(await h.run(h.args, h.execution(), second), done);
  assert.equal(readFileSync(join(h.records()[0].file, '../work/effect'), 'utf8'), 'x');
});

test('cancellation, Host retirement and workflow timeout retain original locators and never restart effects', async t => {
  for (const boundary of ['cancel', 'retire', 'timeout']) {
    const host = new AbortController(), h = setup(t, { script: 'printf x > "$KSADK_SKILL_WORKDIR/effect"\n/bin/sleep 30', signal: host.signal });
    const env = { ...h.config.env, KSADK_SKILL_RUNTIME_TIMEOUT: boundary === 'timeout' ? '5' : '15' };
    const port = h.open({ env }), controller = new AbortController(), exec = h.execution(); exec.signal = controller.signal;
    const pending = h.run(h.args, exec, port);
    await waitFor(() => h.records().some(({ file }) => existsSync(join(file, '../work/effect'))));
    if (boundary === 'cancel') controller.abort(); if (boundary === 'retire') host.abort();
    const result = await pending; assert.equal(result.status, 'uncertain'); assert.match(result.content.runtime_id, /^dsh-local-skill:/u);
    assert.match(result.content.task_id, /^[a-f0-9]{64}$/u); assert.equal(result.content.executed, undefined);
    await waitFor(() => h.records().every(({ record }) => record.phase === 'finished'));
    const cold = h.open({ env, signal: new AbortController().signal }), before = readFileSync(h.records()[0].file, 'utf8');
    const recovered = await h.run(h.args, h.execution(), cold); assert.equal(recovered.status, 'uncertain');
    assert.equal(recovered.content.runtime_id, result.content.runtime_id); assert.equal(recovered.content.task_id, result.content.task_id);
    assert.equal(readFileSync(h.records()[0].file, 'utf8'), before);
    assert.equal(readFileSync(join(h.records()[0].file, '../work/effect'), 'utf8'), 'x');
  }
});

test('real SIGKILL after a script effect leaves an uncertain original intent and a fresh owner never launches it', async t => {
  const h = setup(t, { script: 'printf x > "$KSADK_SKILL_WORKDIR/effect"\n/bin/sleep 30' });
  const code = `import {createDshNodeSkillWorkflowTools} from ${JSON.stringify(moduleUrl)};const config=JSON.parse(process.argv[1]),args=JSON.parse(process.argv[2]);
    config.ctx={sandboxPolicy:{resolve:()=>({mode:'workspace-write'})}};const port=createDshNodeSkillWorkflowTools(config);
    await port.execute('execute_skills',args,{agent:{session:{id:'session'}},callId:'call',name:'execute_skills',arguments:args,signal:new AbortController().signal});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ ...h.config, ctx: undefined }), JSON.stringify(h.args)],
    { env: { ...process.env, PATH: h.config.env.PATH, AGENTKIT_KSADK_PYTHON: '/unavailable/python' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => stderr += data); t.after(() => child.kill('SIGKILL'));
  await waitFor(() => h.records().some(({ file }) => existsSync(join(file, '../work/effect'))));
  const exited = once(child, 'exit'); child.kill('SIGKILL'); const [exit, signal] = await exited;
  assert.equal(exit, null, stderr); assert.equal(signal, 'SIGKILL');
  const [{ file, record }] = h.records(), before = readFileSync(file, 'utf8'); assert.equal(record.phase, 'executing');
  const result = await h.run(); assert.equal(result.status, 'uncertain'); assert.equal(result.content.runtime_id, record.runtimeId);
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(readFileSync(join(file, '../work/effect'), 'utf8'), 'x');
  // Cleanup is explicit, never a test pretending that execution resumed.
  const store = new LocalCommandStore({ stateRoot: join(file, '../..', 'processes'), workspaceRoot: h.workspaceRoot, sessionId: 'session' });
  await store.connect(record.taskId).kill();
  // A crashed intent deliberately stays executing/unknown; remove it only in
  // fixture cleanup after proving that cold invocation did not change it.
  rmSync(join(file, '..'), { recursive: true, force: true });
});

test('shared runtime rejects foreign/fabricated ownership before any package admission', async t => {
  const h = setup(t), runtime = createDshLocalSkillRuntime({ stateRoot: join(h.root, 'direct-state'), workspaceRoot: h.workspaceRoot,
    agentId: 'agent', sessionId: 'session', bindingDigest: 'a'.repeat(64), settings: nativeSkillRuntimeSettings(h.config.env),
    loadPackages: () => assert.fail('foreign identity cannot admit packages') });
  const request = { agentId: 'agent', sessionId: 'session', callId: 'call', operationKey: 'op', call: { callId: 'call', name: 'execute_skills', arguments: h.args },
    signal: new AbortController().signal, assertCurrent: () => true };
  for (const changed of [{ agentId: 'foreign' }, { sessionId: 'foreign' }, { runId: 'fabricated' }, { executionFence: 1 }, { callId: 'other' }]) {
    await assert.rejects(runtime.execute({ ...request, ...changed }), /SKILL_RUNTIME_OWNER_MISMATCH/u);
  }
});

test('composition mounts admitted local/E2B workflows independently and never substitutes the selected backend', async t => {
  const h = setup(t);
  for (const backend of ['local_process', 'e2b']) {
    const port = createDshNodeBuiltins({ ...h.config, toolBindings: ['component_status', 'execute_skills'],
      env: { ...h.config.env, KSADK_SKILL_RUNTIME_BACKEND: backend, KSADK_SKILL_RUNTIME_TEMPLATE_ID: 'explicit-skill-template',
        E2B_API_URL: 'https://fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'test-only-key' } }); t.after(() => port.close());
    assert.equal(port.supports('execute_skills'), true);
    const exec = h.execution({}); exec.name = 'component_status'; const result = await port.execute(exec.name, {}, exec);
    assert.equal(result.content.skill_runtime.enabled, true); assert.equal(result.content.skill_runtime.backend, backend);
    assert.equal(result.content.skill_runtime.template_bound, backend === 'e2b');
    assert.equal(result.content.summary.isolated_execution, backend === 'e2b' ? 'enabled' : 'not_enabled');
    assert.deepEqual(result.content.skill_space.tools, ['execute_skills']);
    assert.equal(result.content.skill_runtime.request_protocol, DSH_NODE_SKILL_WORKFLOW);
  }
  const readsOnly = createDshNodeBuiltins({ ...h.config, toolBindings: ['component_status'], env: h.config.env }); t.after(() => readsOnly.close());
  assert.equal(readsOnly.supports('execute_skills'), false);
});
