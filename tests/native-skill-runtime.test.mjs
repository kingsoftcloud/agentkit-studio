import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createNativeLocalSkillRuntime, nativeSkillRuntimeSettings } from '../src/providers/native-skill-runtime.mjs';
const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const settings = nativeSkillRuntimeSettings({ KSADK_SKILL_RUNTIME_BACKEND: 'local_process', KSADK_SKILL_RUNTIME_TIMEOUT: '20' });
function request(signal = new AbortController().signal) {
  return { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: null, parentRunId: null,
    taskChainId: 'chain', operationKey: 'execute', executionFence: 1, callId: 'call',
    call: { callId: 'call', name: 'execute_skills', arguments: { workflow_prompt: 'Use alpha' } },
    workflowPrompt: 'Use alpha', skillNames: ['alpha'], skillSpaceIds: ['space'], timeout: 20,
    signal, assertCurrent: () => true };
}
function setup(t, script = 'printf "Native result" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\nprintf "artifact=artifacts/result.txt\\n"') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-skill-runtime-'))), workspace = join(root, 'workspace'), pkg = join(root, 'skill');
  mkdirSync(workspace); mkdirSync(join(pkg, 'scripts'), { recursive: true });
  writeFileSync(join(pkg, 'SKILL.md'), '# Alpha\n'); writeFileSync(join(pkg, 'scripts/run-workflow.sh'), script, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = [{ name: 'alpha', body: '# Alpha', rootDir: pkg }];
  const options = { stateRoot: join(root, 'state'), workspaceRoot: workspace, scope, sessionId: 'session',
    bindingDigest: 'b'.repeat(64), settings, env: { PATH: process.env.PATH, PRIVATE_SECRET: 'never-inherit' }, loadPackages: async () => packages };
  return { root, workspace, packages, options, runtime: createNativeLocalSkillRuntime(options) };
}
async function waitFor(predicate) {
  const until = performance.now() + 15000;
  while (!predicate()) { assert.ok(performance.now() < until, 'process must enter the observed boundary'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function entry(h) { return readdirSync(h.options.stateRoot).filter(name => /^[a-f0-9]{64}$/u.test(name)).map(name => join(h.options.stateRoot, name))[0]; }

test('runtime settings preserve the reference project-name alias and explicit backend choice', () => {
  const selected = nativeSkillRuntimeSettings({ KSADK_SKILL_RUNTIME_BACKEND: 'e2b', KSADK_SKILL_ARTIFACT_PROJECT: 'custom-project' });
  assert.equal(selected.backend, 'e2b'); assert.equal(selected.enabled, true); assert.equal(selected.isolated, true);
  assert.equal(selected.projectName, 'custom-project');
  assert.throws(() => nativeSkillRuntimeSettings({ KSADK_SKILL_ARTIFACT_PROJECT: 1 }), /SKILL_RUNTIME_PROJECT_INVALID/);
  assert.equal(nativeSkillRuntimeSettings({ KSADK_SKILL_RUNTIME_BACKEND: 'off' }).enabled, false);
});

test('real supervised Node workflow stages its package, delivers exact bytes and reopens without another process', async t => {
  const h = setup(t), req = request();
  const first = await h.runtime.execute(req);
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.executed, true); assert.equal(first.workflow_status, 'ok');
  assert.equal(first.backend, 'local_process'); assert.equal(first.isolated, false); assert.equal(first.output_text, 'Native result');
  assert.equal(readFileSync(first.output_files[0], 'utf8'), 'Native result');
  assert.ok(first.output_files[0].startsWith(h.workspace + '/.agentkit/skill-results/'));
  assert.equal(first.artifact_metadata[0].size_bytes, 13);
  const saved = readFileSync(join(entry(h), 'record.json'), 'utf8');
  assert.doesNotMatch(saved, /never-inherit/);
  writeFileSync(join(h.packages[0].rootDir, 'scripts/run-workflow.sh'), 'exit 99');
  const cold = createNativeLocalSkillRuntime({ ...h.options, loadPackages: () => assert.fail('completed call must not load again') });
  assert.deepEqual(await cold.execute(request()), first);
  assert.equal(readFileSync(join(entry(h), 'record.json'), 'utf8'), saved);
  const drift = request(); drift.workflowPrompt = 'different';
  await assert.rejects(cold.execute(drift), /SKILL_RUNTIME_IDENTITY_CONFLICT/);
});

test('instruction-only Skills execute the Node runtime without inventing a script invocation', async t => {
  const h = setup(t); rmSync(join(h.packages[0].rootDir, 'scripts'), { recursive: true });
  const result = await h.runtime.execute(request());
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.exit_code, 0);
  assert.equal(result.workflow_status, 'instructions'); assert.equal(result.instructions, '# Alpha');
  assert.equal(result.executed, true, 'the Node runtime did execute'); assert.equal(result.commands, undefined);
});

test('real Skill sidecar facts are bound, redacted and restored with the original workflow receipt', async t => {
  const script = `${JSON.stringify(process.execPath)} <<'JS'
const fs = require('fs');
const event = {schema_version: 1, event_id: 'script-one', event_type: 'skill.manifest.parsed', status: 'completed',
 started_at: 10, skill_invocation_id: process.env.KSADK_SKILL_INVOCATION_ID,
 skill_ref: JSON.parse(process.env.KSADK_SKILL_REF_JSON), run_id: 'forged-run',
 attributes: {has_description: true, password: 'never-export-canary'}};
fs.writeFileSync(process.env.KSADK_SKILL_EVENT_FILE, JSON.stringify(event)+'\\n'+JSON.stringify({...event,event_id:'forged',event_type:'skill.workflow.completed'})+'\\n');
JS
printf 'sidecar result' > "$KSADK_SKILL_OUTPUT_DIR/result.txt"`;
  const h = setup(t, script), result = await h.runtime.execute(request());
  assert.equal(result.ok, true, JSON.stringify(result));
  const events = result.skill_events;
  assert.equal(events.filter(event => event.attributes.source === 'sandbox').length, 1);
  assert.equal(events.find(event => event.attributes.source === 'sandbox').run_id, 'run');
  assert.equal(events.filter(event => event.event_type === 'sandbox.envelope.rejected').length, 1);
  assert.equal(events.filter(event => event.event_type === 'skill.workflow.completed').length, 1);
  assert.ok(events.some(event => event.event_type === 'skill.artifact.created'));
  assert.ok(!events.some(event => event.event_type === 'skill.result.consumed'));
  assert.doesNotMatch(JSON.stringify(events), /never-export-canary|forged-run/);
  const cold = createNativeLocalSkillRuntime({ ...h.options, loadPackages: () => assert.fail('events must replay without executing') });
  assert.deepEqual(await cold.execute(request()), result);
  assert.deepEqual(JSON.parse(readFileSync(join(entry(h), 'record.json'), 'utf8')).skillEvents, events);
});

test('a failed Skill command is a recorded workflow failure, never a successful result', async t => {
  const h = setup(t, 'printf "failed" >&2\nexit 7'); const result = await h.runtime.execute(request());
  assert.equal(result.ok, false); assert.equal(result.workflow_status, 'failed');
  assert.equal(result.commands[0].exit_code, 7); assert.equal(result.error_type, 'skill_workflow_failed');
  assert.equal(result.executed, true); assert.deepEqual(await h.runtime.execute(request()), result);
});

test('pre-dispatch abort and foreign authority create no invocation record', async t => {
  const h = setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(h.runtime.execute(request(controller.signal)));
  const wrong = request(); wrong.scope = { ...scope, userId: 'foreign' };
  await assert.rejects(h.runtime.execute(wrong), /SKILL_RUNTIME_OWNER_MISMATCH/);
  assert.equal(entry(h), undefined);
});

test('oversized requests fail before package admission or an unreadable durable intent', async t => {
  const h = setup(t), req = request(); req.futureField = 'x'.repeat(2 * 1024 ** 2);
  const runtime = createNativeLocalSkillRuntime({ ...h.options, loadPackages: () => assert.fail('oversized request cannot admit packages') });
  await assert.rejects(runtime.execute(req), /SKILL_RUNTIME_REQUEST_TOO_LARGE/);
  assert.equal(entry(h), undefined);
});

test('cancel after the real workflow entered keeps the original runtime and command locators', async t => {
  const h = setup(t, 'printf "entered" > "$KSADK_SKILL_WORKDIR/entered"\nsleep 30');
  const controller = new AbortController(), running = h.runtime.execute(request(controller.signal));
  await waitFor(() => entry(h) && existsSync(join(entry(h), 'work/entered'))); controller.abort();
  const result = await running;
  assert.equal(result.status, 'uncertain'); assert.match(result.runtime_id, /^local-skill:/); assert.match(result.task_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(await createNativeLocalSkillRuntime(h.options).execute(request()), result);
  const { LocalCommandStore } = await import('../packages/agentkit-harness/src/native/local-background.mjs');
  const store = new LocalCommandStore({ stateRoot: join(h.options.stateRoot, 'processes'), workspaceRoot: h.workspace, sessionId: 'session' });
  await store.connect(result.task_id).kill();
});

test('a real killed Host leaves an uncertain original intent which a fresh process never relaunches', async t => {
  const h = setup(t, 'printf "effect" > "$KSADK_SKILL_WORKDIR/effect"\nsleep 30');
  const moduleUrl = new URL('../src/providers/native-skill-runtime.mjs', import.meta.url).href;
  const args = { ...h.options, loadPackages: undefined }, body = { ...request(), signal: undefined, assertCurrent: undefined };
  const script = `import {createNativeLocalSkillRuntime} from ${JSON.stringify(moduleUrl)}; const o=JSON.parse(process.argv[1]); const r=JSON.parse(process.argv[2]); o.loadPackages=async()=>JSON.parse(process.argv[3]); await createNativeLocalSkillRuntime(o).execute({...r,signal:new AbortController().signal,assertCurrent:()=>true});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args), JSON.stringify(body), JSON.stringify(h.packages)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await waitFor(() => entry(h) && existsSync(join(entry(h), 'work/effect')));
  const done = once(child, 'exit'); child.kill('SIGKILL'); const [code, signal] = await done;
  assert.equal(code, null, stderr); assert.equal(signal, 'SIGKILL');
  const before = readFileSync(join(entry(h), 'record.json'), 'utf8');
  const cold = createNativeLocalSkillRuntime({ ...h.options, loadPackages: () => assert.fail('crashed invocation cannot reload or relaunch') });
  const result = await cold.execute(request()); assert.equal(result.status, 'uncertain');
  assert.equal(readFileSync(join(entry(h), 'record.json'), 'utf8'), before);
  // Explicitly cancel the retained supervised command during test cleanup.
  const { LocalCommandStore } = await import('../packages/agentkit-harness/src/native/local-background.mjs');
  const store = new LocalCommandStore({ stateRoot: join(h.options.stateRoot, 'processes'), workspaceRoot: h.workspace, sessionId: 'session' });
  await store.connect(result.task_id).kill();
});

test('the original Native authority is rechecked after the first real command, before a second command can start', async t => {
  const h = setup(t); h.packages[0].name = 'web-artifacts-builder';
  rmSync(join(h.packages[0].rootDir, 'scripts/run-workflow.sh'));
  writeFileSync(join(h.packages[0].rootDir, 'scripts/init-artifact.sh'), 'mkdir "$1"\nprintf "init" > "$1/source.txt"');
  writeFileSync(join(h.packages[0].rootDir, 'scripts/bundle-artifact.sh'), 'printf "forbidden second effect" > bundle.html');
  const req = request(); req.workflowPrompt = 'build artifact'; req.skillNames = ['web-artifacts-builder'];
  req.assertCurrent = () => {
    const owners = join(h.options.stateRoot, 'processes', 'commands');
    for (const owner of readdirSync(owners)) for (const name of readdirSync(join(owners, owner))) {
      if (!/^[a-f0-9]{64}$/u.test(name)) continue;
      const file = join(owners, owner, name, 'record.json');
      if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).status === 'completed') return false;
    }
    return true;
  };
  const result = await h.runtime.execute(req);
  assert.equal(result.status, 'uncertain'); assert.equal(result.command_ids.length, 1);
  assert.equal(existsSync(join(entry(h), 'work/ksadk-artifact/bundle.html')), false);
});

test('complete request snapshots preserve exact integers and reject reentrant future-field mutation', async t => {
  const h = setup(t), req = request(); req.future = { exact: 9007199254740993n };
  const result = await h.runtime.execute(req); assert.equal(result.ok, true);
  assert.deepEqual(await createNativeLocalSkillRuntime(h.options).execute(requestWithExtra()), result);
  function requestWithExtra() { return { ...request(), future: { exact: 9007199254740993n } }; }
  const bad = request(); bad.operationKey = 'other'; bad.future = 'original';
  bad.assertCurrent = () => { bad.future = 'changed'; return true; };
  await assert.rejects(h.runtime.execute(bad), /SKILL_RUNTIME_REQUEST_CHANGED/);
});

test('concurrent runtime instances attach the original intent and cannot start a duplicate command', async t => {
  const h = setup(t, 'printf "entered" > "$KSADK_SKILL_WORKDIR/entered"\nsleep 1\nprintf "once" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"');
  const first = h.runtime.execute(request()); await waitFor(() => entry(h) && existsSync(join(entry(h), 'work/entered')));
  const other = createNativeLocalSkillRuntime(h.options), waiting = await other.execute(request());
  assert.equal(waiting.status, 'uncertain'); assert.equal(waiting.error_type, 'skill_runtime_in_progress');
  const conflict = request(); conflict.workflowPrompt = 'foreign prompt'; await assert.rejects(other.execute(conflict), /SKILL_RUNTIME_IDENTITY_CONFLICT/);
  const completed = await first; assert.equal(completed.ok, true); assert.equal(completed.command_ids.length, 1);
  assert.equal(waiting.task_id, completed.task_id); assert.deepEqual(await other.execute(request()), completed);
});
