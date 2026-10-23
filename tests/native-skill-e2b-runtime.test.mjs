import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeE2BSkillRuntime } from '../src/providers/native-skill-e2b-runtime.mjs';
import { prepareNativeE2BHost } from '../src/providers/native-e2b-host.mjs';
import { canonical, parseNativeJson } from '../packages/agentkit-harness-core/dist/index.mjs';
import { skillE2BSdk } from './fixtures/native-skill-e2b-sdk.mjs';
const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
function gate() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate) {
  const end = performance.now() + 10000;
  while (!predicate()) { assert.ok(performance.now() < end, 'the observed runtime boundary must be reached'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function request(signal = new AbortController().signal) {
  return { scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null,
    taskChainId: 'chain', operationKey: 'execute', executionFence: 1, callId: 'call',
    call: { callId: 'call', name: 'execute_skills', arguments: { workflow_prompt: 'Use alpha' } },
    lockedDefinition: { name: 'execute_skills', effect: 'write' },
    workflowPrompt: 'Use alpha', skillNames: ['alpha'], skillSpaceIds: ['space'], timeout: 20,
    signal, assertCurrent: () => true, future: { integer: 9007199254740993n } };
}
function setup(t, peerOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-skill-e2b-'))), workspace = join(root, 'workspace'), pkg = join(root, 'skill');
  mkdirSync(workspace); mkdirSync(join(pkg, 'scripts'), { recursive: true });
  writeFileSync(join(pkg, 'SKILL.md'), '# Alpha\n');
  writeFileSync(join(pkg, 'scripts/run-workflow.sh'), 'printf "Native E2B: 中文\\n" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\nprintf "\\000\\377\\001" > "$KSADK_SKILL_OUTPUT_DIR/result.bin"\nprintf "artifact=%s/result.txt\\n" "$KSADK_SKILL_OUTPUT_DIR"', { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = [{ name: 'alpha', body: '# Alpha', rootDir: pkg }], stateRoot = join(root, 'state');
  const peer = skillE2BSdk(t, { root: join(root, 'remote'), before(method) {
    if (!['create', 'run', 'write', 'kill'].includes(method)) return;
    const records = readdirSync(stateRoot).filter(name => /^[a-f0-9]{64}$/u.test(name)); assert.equal(records.length, 1);
    const intent = parseNativeJson(readFileSync(join(stateRoot, records[0], 'record.json'), 'utf8'));
    assert.equal(intent.phase, 'executing'); assert.equal(intent.request.future.integer, 9007199254740993n);
    if (method === 'run') assert.ok(intent.commands.length, 'command intent must precede SDK run');
  }, ...peerOptions });
  const prepared = prepareNativeE2BHost({ env: { KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'node-only-template',
    E2B_API_URL: 'https://api.fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'never-persist-this' }, loadSdk: async () => peer.sdk });
  const options = { stateRoot, workspaceRoot: workspace, scope, sessionId: 'session', bindingDigest: 'b'.repeat(64),
    settings: { backend: 'e2b', enabled: true, isolated: true, timeoutSeconds: 20, projectName: 'artifact-project' },
    prepared, inProcessTransport: true, loadPackages: async () => packages };
  return { root, workspace, pkg, peer, options, runtime: createNativeE2BSkillRuntime(options) };
}
test('trusted workspace inputs are pinned before create, uploaded exactly, consumed by a real script and never replayed', async t => {
  const bytes = Buffer.from([0, 255, 1, 128]), digest = createHash('sha256').update(bytes).digest('hex');
  const h = setup(t, { before(method) {
    if (method !== 'create') return;
    const dir = readdirSync(h.options.stateRoot).find(name => /^[a-f0-9]{64}$/u.test(name));
    const record = parseNativeJson(readFileSync(join(h.options.stateRoot, dir, 'record.json'), 'utf8'));
    assert.equal(record.inputs.contract, 'agentkit.native-skill-input-files/v1');
    assert.equal(record.inputs.files[0].sha256, digest, 'pinned manifest precedes sandbox creation');
    writeFileSync(join(h.workspace, 'input.bin'), 'later source edit');
  } });
  writeFileSync(join(h.workspace, 'input.bin'), bytes); writeFileSync(join(h.workspace, 'empty'), '');
  writeFileSync(join(h.pkg, 'scripts/run-workflow.sh'),
    'cat "$KSADK_SKILL_INPUT_DIR/nested/input.bin" > "$KSADK_SKILL_OUTPUT_DIR/result.bin"\n'
    + 'test -f "$KSADK_SKILL_INPUT_DIR/empty" && test ! -s "$KSADK_SKILL_INPUT_DIR/empty"\n'
    + 'printf "%s" "$KSADK_SKILL_INPUT_FILES" > "$KSADK_SKILL_OUTPUT_DIR/paths.json"');
  const req = request(); req.inputFiles = [{ source: 'input.bin', targetPath: '/workspace/inputs/nested/input.bin', sha256: digest },
    { source: 'empty', targetPath: '/workspace/inputs/empty' }];
  const result = await h.runtime.execute(req); assert.equal(result.ok, true, canonical(result));
  assert.deepEqual(readFileSync(result.output_files.find(path => path.endsWith('result.bin'))), bytes);
  assert.deepEqual(JSON.parse(readFileSync(result.output_files.find(path => path.endsWith('paths.json')), 'utf8')),
    req.inputFiles.map(item => item.targetPath));
  assert.deepEqual(result.input_files.files.map(item => [item.path, item.size_bytes]), [['/workspace/inputs/nested/input.bin', 4], ['/workspace/inputs/empty', 0]]);
  const uploaded = h.peer.calls.filter(call => call.method === 'write' && call.path.startsWith('/workspace/inputs/'));
  assert.deepEqual(uploaded.map(item => [item.path, item.size]), [['/workspace/inputs/nested/input.bin', 4], ['/workspace/inputs/empty', 0]]);
  const before = h.peer.calls.length; rmSync(join(h.workspace, 'input.bin'));
  assert.deepEqual(await createNativeE2BSkillRuntime(h.options).execute(req), result);
  assert.equal(h.peer.calls.length, before, 'cold duplicate does not read original source, create, upload or run');
});
test('an input outside the actual workspace fails without creating or uploading to a sandbox', async t => {
  const h = setup(t), req = request(); writeFileSync(join(h.root, 'private'), 'private');
  req.inputFiles = [{ source: '../private', targetPath: '/workspace/inputs/private' }];
  const result = await h.runtime.execute(req); assert.equal(result.status, 'uncertain');
  assert.equal(result.error_type, 'SKILL_INPUT_SOURCE_OUTSIDE_WORKSPACE'); assert.deepEqual(h.peer.calls, []);
});

test('existing template input directories are usable without overwriting a template file', async t => {
  const h = setup(t, { afterCreate(local) { mkdirSync(join(local, 'workspace/inputs/nested'), { recursive: true, mode: 0o700 }); } });
  writeFileSync(join(h.workspace, 'source.bin'), 'original'); const req = request();
  req.inputFiles = [{ source: 'source.bin', targetPath: '/workspace/inputs/nested/source.bin' }];
  const result = await h.runtime.execute(req); assert.equal(result.ok, true, canonical(result));
  assert.equal(h.peer.calls.filter(call => call.method === 'write' && call.path === req.inputFiles[0].targetPath).length, 1);
});

test('a template input ancestor symlink cannot redirect directory creation or an upload', async t => {
  let outside;
  const h = setup(t, { afterCreate(local) {
    outside = join(local, 'foreign'); mkdirSync(outside); mkdirSync(join(local, 'workspace/inputs'), { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(local, 'workspace/inputs/nested'));
  } });
  writeFileSync(join(h.workspace, 'source.bin'), 'private'); const req = request();
  req.inputFiles = [{ source: 'source.bin', targetPath: '/workspace/inputs/nested/child/source.bin' }];
  const result = await h.runtime.execute(req); assert.equal(result.ok, false);
  assert.equal(result.error_type, 'SKILL_RUNTIME_REMOTE_PREPARATION_FAILED');
  assert.deepEqual(readdirSync(outside), []); assert.equal(h.peer.calls.filter(call => call.method === 'write').length, 0);
});

for (const boundary of ['before-create', 'after-upload']) {
  test(`SIGKILL ${boundary} keeps the exact pinned input intent and a fresh process performs no SDK replay`, async t => {
    const h = setup(t), bytes = Buffer.from([0, 255, 128, 1]); writeFileSync(join(h.workspace, 'source.bin'), bytes);
    const req = request(); req.inputFiles = [{ source: 'source.bin', targetPath: '/workspace/inputs/source.bin' }];
    const id = h.runtime.locate(req).runtime_id.slice('e2b-skill:'.length), recordPath = join(h.options.stateRoot, id, 'record.json');
    const { signal, assertCurrent, ...requestBody } = req;
    const input = { boundary, root: h.root, options: Object.fromEntries(['stateRoot', 'workspaceRoot', 'scope', 'sessionId', 'bindingDigest', 'settings']
      .map(key => [key, h.options[key]])), request: requestBody, packages: [{ name: 'alpha', body: '# Alpha', rootDir: h.pkg }] };
    const marker = join(h.root, 'boundary.json'), audit = join(h.root, 'sdk.log');
    const code = `
      import {createNativeE2BSkillRuntime} from ${JSON.stringify(new URL('../src/providers/native-skill-e2b-runtime.mjs', import.meta.url).href)};
      import {prepareNativeE2BHost} from ${JSON.stringify(new URL('../src/providers/native-e2b-host.mjs', import.meta.url).href)};
      import {skillE2BSdk} from ${JSON.stringify(new URL('./fixtures/native-skill-e2b-sdk.mjs', import.meta.url).href)};
      import {parseNativeJson,canonical} from ${JSON.stringify(new URL('../packages/agentkit-harness-core/dist/index.mjs', import.meta.url).href)};
      import {appendFileSync,writeFileSync} from 'node:fs';
      const input=parseNativeJson(process.argv[1]), recover=process.argv[2]==='recover';
      const blocked=new Promise(()=>{}), marker=()=>writeFileSync(input.root+'/boundary.json',JSON.stringify({pid:process.pid,boundary:input.boundary}));
      const peer=skillE2BSdk({after(){}},{root:input.root+'/remote',
        before(method){appendFileSync(input.root+'/sdk.log',method+'\\n'); if(recover)throw Error('cold recovery cannot touch SDK');
          if(input.boundary==='before-create' && method==='create')marker();},
        ...(input.boundary==='before-create'?{createGate:{promise:blocked}}:{}),
        async afterWrite(path){if(input.boundary==='after-upload' && path.startsWith('/workspace/inputs/')){marker();await blocked;}}});
      const prepared=prepareNativeE2BHost({env:{KSADK_SANDBOX_BACKEND:'e2b',KSADK_SANDBOX_TEMPLATE_ID:'node-only-template',
        E2B_API_URL:'https://api.fixture.invalid',E2B_DOMAIN:'fixture.invalid',E2B_API_KEY:'never-persist-this'},loadSdk:async()=>peer.sdk});
      const timer=setInterval(()=>{},1000);
      try{const result=await createNativeE2BSkillRuntime({...input.options,prepared,inProcessTransport:true,
        loadPackages:async()=>{if(recover)throw Error('cold recovery cannot reload packages');return input.packages;}})
        .execute({...input.request,signal:new AbortController().signal,assertCurrent:()=>true});
        if(recover)process.stdout.write(canonical({pid:process.pid,result}));}finally{clearInterval(timer);}`;
    const start = mode => spawn(process.execPath, ['--input-type=module', '-e', code, canonical(input), mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    const child = start('execute'); let stderr = ''; child.stderr.on('data', bytes => stderr += bytes);
    t.after(() => { try { child.kill('SIGKILL'); } catch {} });
    await until(() => existsSync(marker)); const reached = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(reached.pid, child.pid); assert.equal(reached.boundary, boundary);
    const intent = parseNativeJson(readFileSync(recordPath, 'utf8')); assert.equal(intent.phase, 'executing');
    assert.equal(intent.inputs.contract, 'agentkit.native-skill-input-files/v1');
    assert.equal(intent.inputs.files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(readFileSync(join(h.options.stateRoot, id, 'inputs', '0')), bytes);
    if (boundary === 'after-upload') assert.deepEqual(readFileSync(join(h.root, 'remote/skill-peer-1/workspace/inputs/source.bin')), bytes);
    else assert.equal(existsSync(join(h.root, 'remote')), false);
    const exiting = once(child, 'exit'); child.kill('SIGKILL'); const [exitCode, exitSignal] = await exiting;
    assert.equal(exitCode, null, stderr); assert.equal(exitSignal, 'SIGKILL');
    const saved = readFileSync(recordPath, 'utf8'), sdkSaved = readFileSync(audit, 'utf8'); rmSync(join(h.workspace, 'source.bin'));
    const cold = start('recover'); let output = '', coldError = '';
    cold.stdout.on('data', bytes => output += bytes); cold.stderr.on('data', bytes => coldError += bytes);
    t.after(() => { try { cold.kill('SIGKILL'); } catch {} });
    const [coldCode] = await once(cold, 'exit'); assert.equal(coldCode, 0, coldError);
    const recovered = parseNativeJson(output); assert.notEqual(recovered.pid, reached.pid);
    assert.equal(recovered.result.status, 'uncertain'); assert.equal(recovered.result.runtime_id, intent.runtimeId);
    assert.equal(recovered.result.task_id, intent.taskId); assert.deepEqual(recovered.result.command_ids, intent.commands.map(item => item.taskId));
    assert.equal(recovered.result.error_type, 'skill_runtime_outcome_unknown');
    assert.equal(readFileSync(recordPath, 'utf8'), saved); assert.equal(readFileSync(audit, 'utf8'), sdkSaved);
    if (process.env.NATIVE_SKILL_INPUT_PROOF_DIR) {
      mkdirSync(process.env.NATIVE_SKILL_INPUT_PROOF_DIR, { recursive: true });
      writeFileSync(join(process.env.NATIVE_SKILL_INPUT_PROOF_DIR, `${process.versions.node}-${boundary}.json`), JSON.stringify({
        boundary, originalPid: reached.pid, recoveryPid: recovered.pid, signal: exitSignal,
        inputSha256: intent.inputs.files[0].sha256, sdkCalls: sdkSaved.trim().split('\n'), result: recovered.result,
        originalIntentUnchanged: true, noSdkReplay: true }, null, 2));
    }
  });
}

test('E2B workflow uses production lifecycle/SDK adapter/command store, exact binary artifacts and confirmed cleanup; reopen never reruns', async t => {
  const h = setup(t), first = await h.runtime.execute(request());
  assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.backend, 'e2b'); assert.equal(first.isolated, true);
  assert.equal(first.output_text, 'Native E2B: 中文\n'); assert.equal(first.workflow_status, 'ok');
  const binary = first.output_files.find(path => path.endsWith('.bin'));
  assert.deepEqual(readFileSync(binary), Buffer.from([0, 255, 1]));
  assert.equal(first.sandbox.cleanup_status, 'completed'); assert.equal(first.command_ids.length, 3);
  assert.equal(first.task_id, first.command_ids[0]); assert.equal(first.remote_runtime_id, 'skill-peer-1');
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(h.peer.calls.filter(call => call.method === 'run').length, 3);
  assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 1);
  const count = h.peer.calls.length;
  const reopened = createNativeE2BSkillRuntime({ ...h.options, loadPackages: () => assert.fail('finished invocation must not reload') });
  assert.deepEqual(await reopened.execute(request()), first); assert.equal(h.peer.calls.length, count);
  const record = readFileSync(join(h.options.stateRoot, readdirSync(h.options.stateRoot).find(name => /^[a-f0-9]{64}$/u.test(name)), 'record.json'), 'utf8');
  assert.doesNotMatch(record, /never-persist-this/);
});

test('unknown sandbox creation and an unfinished original invocation never create a replacement', async t => {
  const entered = gate(), blocked = gate(); const h = setup(t, { createGate: blocked, before(method) { if (method === 'create') entered.resolve(); } });
  const controller = new AbortController(), pending = h.runtime.execute(request(controller.signal)); await entered.promise;
  const second = await createNativeE2BSkillRuntime(h.options).execute(request());
  assert.equal(second.status, 'uncertain'); assert.equal(second.error_type, 'skill_runtime_in_progress');
  controller.abort(new Error('cancel create')); const result = await pending;
  assert.equal(result.status, 'uncertain'); assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1);
  blocked.resolve(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.peer.sandboxes.size, 1);
  const replay = await createNativeE2BSkillRuntime({ ...h.options, loadPackages: () => assert.fail('no replacement load') }).execute(request());
  assert.deepEqual(replay, result); assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1);
  const ownerRoot = join(h.options.stateRoot, readdirSync(h.options.stateRoot).find(name => /^[a-f0-9]{64}$/u.test(name)), 'sandbox');
  const owner = JSON.parse(readFileSync(join(ownerRoot, readdirSync(ownerRoot)[0], 'owner.json'), 'utf8'));
  assert.equal(owner.phase, 'unknown'); assert.equal(owner.sandboxId, 'skill-peer-1', 'late SDK identity must remain discoverable');
});

test('an unconfirmed cleanup never becomes workflow success and keeps the actual sandbox and command IDs', async t => {
  const h = setup(t, { killResult: 'true' }), result = await h.runtime.execute(request());
  assert.equal(result.status, 'uncertain'); assert.equal(result.ok, false); assert.equal(result.remote_runtime_id, 'skill-peer-1');
  assert.equal(result.command_ids.length, 3); assert.equal(result.sandbox.cleanup_status, 'not_confirmed');
  assert.deepEqual(await createNativeE2BSkillRuntime(h.options).execute(request()), result);
  assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 1, 'unknown cleanup must not be attempted again automatically');
});

test('authority loss after remote init prevents the bundle command and cleanup from using stale authority', async t => {
  let allowed = true;
  const h = setup(t, { afterCommand(command) { if (command.includes('init-artifact.sh')) allowed = false; } });
  writeFileSync(join(h.pkg, 'scripts/init-artifact.sh'), 'mkdir "$1"');
  writeFileSync(join(h.pkg, 'scripts/bundle-artifact.sh'), 'printf forbidden > bundle.html');
  h.options.loadPackages = async () => [{ name: 'web-artifacts-builder', body: '# web', rootDir: h.pkg }];
  const runtime = createNativeE2BSkillRuntime(h.options), req = request();
  req.workflowPrompt = 'build html artifact'; req.skillNames = ['web-artifacts-builder']; req.assertCurrent = () => allowed;
  const result = await runtime.execute(req); assert.equal(result.status, 'uncertain');
  assert.equal(h.peer.calls.filter(call => call.method === 'run' && call.command.includes('init-artifact.sh')).length, 1);
  assert.equal(h.peer.calls.filter(call => call.method === 'run' && call.command.includes('bundle-artifact.sh')).length, 0);
  assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 0);
});

test('pre-dispatch abort, changed complete context, missing authority and a foreign owner produce no SDK effects', async t => {
  const h = setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(h.runtime.execute(request(controller.signal)));
  const changed = request(); changed.assertCurrent = () => { changed.future.integer = 9007199254740992n; return true; };
  await assert.rejects(h.runtime.execute(changed), /SKILL_RUNTIME_REQUEST_CHANGED/);
  const foreign = request(); foreign.scope = { ...scope, userId: 'foreign' }; await assert.rejects(h.runtime.execute(foreign), /SKILL_RUNTIME_OWNER_MISMATCH/);
  const absent = request(); delete absent.assertCurrent; await assert.rejects(h.runtime.execute(absent), /SKILL_RUNTIME_AUTHORITY_REQUIRED/);
  assert.equal(h.peer.calls.length, 0);
});

test('the real two-command web workflow exports only the exact bundle without bringing back project dependencies', async t => {
  const h = setup(t);
  writeFileSync(join(h.pkg, 'scripts/init-artifact.sh'), 'mkdir -p "$1/node_modules/pkg"\nprintf dependency > "$1/node_modules/pkg/index.js"\nprintf intermediate > "$1/bundle.html"');
  writeFileSync(join(h.pkg, 'scripts/bundle-artifact.sh'), 'printf "<h1>Native E2B 中文</h1>" > bundle.html');
  h.options.loadPackages = async () => [{ name: 'web-artifacts-builder', body: '# web', rootDir: h.pkg }];
  const req = request(); req.workflowPrompt = 'build html artifact'; req.skillNames = ['web-artifacts-builder'];
  const result = await createNativeE2BSkillRuntime(h.options).execute(req);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.commands.length, 2);
  assert.equal(result.output_files.length, 1); assert.equal(readFileSync(result.output_files[0], 'utf8'), '<h1>Native E2B 中文</h1>');
  assert.equal(result.artifact_metadata.length, 1); assert.equal(result.artifact_metadata[0].source_path, 'artifact-project/bundle.html');
  assert.ok(h.peer.calls.filter(call => call.method === 'read').every(call => !call.path.includes('node_modules')));
});

test('a proven exit 7 stays a workflow failure with cleanup and never becomes an unknown successful result', async t => {
  const h = setup(t); writeFileSync(join(h.pkg, 'scripts/run-workflow.sh'), 'printf failure >&2\nexit 7');
  const result = await h.runtime.execute(request()); assert.equal(result.ok, false); assert.equal(result.workflow_status, 'failed');
  assert.equal(result.commands[0].exit_code, 7); assert.equal(result.commands[0].stderr, 'failure');
  assert.equal(result.sandbox.cleanup_status, 'completed'); assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 1);
});

test('instruction-only Skills retain their instructions and report only actual sandbox preparation receipts', async t => {
  const h = setup(t); rmSync(join(h.pkg, 'scripts'), { recursive: true });
  const result = await h.runtime.execute(request()); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.workflow_status, 'instructions'); assert.equal(result.instructions, '# Alpha');
  assert.equal(result.commands, undefined); assert.equal(result.command_ids.length, 1);
  assert.equal(h.peer.calls.filter(call => call.method === 'run').length, 1);
  assert.equal(result.sandbox.cleanup_status, 'completed');
});

test('a concurrent invocation attaches the original intent while a command is pending, then replays the exact completed result', async t => {
  const entered = gate(), release = gate();
  const h = setup(t, { async commandGate(command) { if (command.startsWith("'bash' ") && command.includes('/scripts/run-workflow.sh')) { entered.resolve(); await release.promise; } } });
  const running = h.runtime.execute(request()); await entered.promise;
  const second = await createNativeE2BSkillRuntime(h.options).execute(request());
  assert.equal(second.status, 'uncertain'); assert.equal(second.error_type, 'skill_runtime_in_progress');
  const different = request(); different.workflowPrompt = 'changed';
  await assert.rejects(createNativeE2BSkillRuntime(h.options).execute(different), /SKILL_RUNTIME_IDENTITY_CONFLICT/);
  release.resolve(); const result = await running; assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(second.task_id, result.task_id);
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(h.peer.calls.filter(call => call.method === 'run' && call.command.startsWith("'bash' ") && call.command.includes('/scripts/run-workflow.sh')).length, 1);
  assert.deepEqual(await createNativeE2BSkillRuntime(h.options).execute(request()), result);
});

test('canceling a running script preserves all original locators, cancels its command and never relaunches or uses canceled cleanup authority', async t => {
  const entered = gate(); const h = setup(t, { afterCommand() {}, commandGate(command) { if (command.startsWith("'bash' ") && command.includes('/scripts/run-workflow.sh')) entered.resolve(); } });
  writeFileSync(join(h.pkg, 'scripts/run-workflow.sh'), 'printf entered\nsleep 30');
  const controller = new AbortController(), pending = h.runtime.execute(request(controller.signal));
  await entered.promise; await until(() => h.peer.processes.size === 1); controller.abort(new Error('cancel actual remote script'));
  const result = await pending; assert.equal(result.status, 'uncertain'); assert.equal(result.command_ids.length, 3);
  assert.equal(result.remote_runtime_id, 'skill-peer-1'); assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 0);
  await until(() => h.peer.processes.size === 0);
  assert.deepEqual(await createNativeE2BSkillRuntime(h.options).execute(request()), result);
  assert.equal(h.peer.calls.filter(call => call.method === 'run' && call.command.startsWith("'bash' ") && call.command.includes('/scripts/run-workflow.sh')).length, 1);
});

test('whole-workflow timeout bounds a real running command and retains an uncertain original sandbox for reconciliation', async t => {
  const h = setup(t); writeFileSync(join(h.pkg, 'scripts/run-workflow.sh'), 'sleep 30');
  const runtime = createNativeE2BSkillRuntime({ ...h.options, settings: { ...h.options.settings, timeoutSeconds: 1 } });
  const result = await runtime.execute(request()); assert.equal(result.status, 'uncertain');
  assert.equal(result.error_type, 'SKILL_RUNTIME_DEADLINE'); assert.equal(result.remote_runtime_id, 'skill-peer-1');
  await until(() => h.peer.processes.size === 0); assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 0);
});

test('the package loader receives a pinned, cancellable exact request and cannot mutate its authority or future identity', async t => {
  const h = setup(t);
  const runtime = createNativeE2BSkillRuntime({ ...h.options, loadPackages: async request => {
    assert.equal(request.future.integer, 9007199254740993n); request.future.integer = 9007199254740992n;
    return [{ name: 'alpha', body: '# Alpha', rootDir: h.pkg }];
  } });
  const result = await runtime.execute(request()); assert.equal(result.status, 'uncertain');
  assert.equal(result.error_type, 'SKILL_RUNTIME_PACKAGE_REQUEST_CHANGED'); assert.equal(h.peer.calls.length, 0);
});

test('a real SIGKILL after the remote script effect leaves the original intent and cold recovery performs no SDK creation or command replay', async t => {
  const h = setup(t); writeFileSync(join(h.pkg, 'scripts/run-workflow.sh'), 'printf effect > "$KSADK_SKILL_WORKDIR/entered"\nsleep 30');
  const req = request(), id = h.runtime.locate(req).runtime_id.slice('e2b-skill:'.length);
  const { signal, assertCurrent, ...requestBody } = req;
  const input = { root: h.root, options: Object.fromEntries(['stateRoot', 'workspaceRoot', 'scope', 'sessionId', 'bindingDigest', 'settings']
    .map(key => [key, h.options[key]])), request: requestBody, packages: [{ name: 'alpha', body: '# Alpha', rootDir: h.pkg }] };
  const code = `
    import {createNativeE2BSkillRuntime} from ${JSON.stringify(new URL('../src/providers/native-skill-e2b-runtime.mjs', import.meta.url).href)};
    import {prepareNativeE2BHost} from ${JSON.stringify(new URL('../src/providers/native-e2b-host.mjs', import.meta.url).href)};
    import {skillE2BSdk} from ${JSON.stringify(new URL('./fixtures/native-skill-e2b-sdk.mjs', import.meta.url).href)};
    import {parseNativeJson} from ${JSON.stringify(new URL('../packages/agentkit-harness-core/dist/index.mjs', import.meta.url).href)};
    const input=parseNativeJson(process.argv[1]);
    const peer=skillE2BSdk({after(){}},{root:input.root+'/remote'});
    const prepared=prepareNativeE2BHost({env:{KSADK_SANDBOX_BACKEND:'e2b',KSADK_SANDBOX_TEMPLATE_ID:'node-only-template',
      E2B_API_URL:'https://api.fixture.invalid',E2B_DOMAIN:'fixture.invalid',E2B_API_KEY:'never-persist-this'},loadSdk:async()=>peer.sdk});
    await createNativeE2BSkillRuntime({...input.options,prepared,inProcessTransport:true,loadPackages:async()=>input.packages})
      .execute({...input.request,signal:new AbortController().signal,assertCurrent:()=>true});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, canonical(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', remotePid; child.stderr.on('data', bytes => stderr += bytes);
  t.after(() => { try { child.kill('SIGKILL'); } catch {} if (remotePid) { try { process.kill(-remotePid, 'SIGKILL'); } catch {} } });
  const directory = join(h.options.stateRoot, id), recordPath = join(directory, 'record.json');
  const marker = join(h.root, 'remote', 'skill-peer-1', 'tmp', `agentkit-skill-${id}`, 'work', 'entered');
  await until(() => existsSync(marker));
  const intent = parseNativeJson(readFileSync(recordPath, 'utf8')); assert.equal(intent.phase, 'executing'); assert.equal(intent.commands.length, 3);
  const commandRoot = join(directory, 'processes', 'commands'), owner = readdirSync(commandRoot)[0];
  const commandPath = join(commandRoot, owner, intent.commands.at(-1).taskId, 'record.json');
  await until(() => { remotePid = JSON.parse(readFileSync(commandPath, 'utf8')).pid; return Number.isInteger(remotePid) && remotePid > 0; });
  const exit = once(child, 'exit'); child.kill('SIGKILL'); const [codeResult, signalResult] = await exit;
  assert.equal(codeResult, null, stderr); assert.equal(signalResult, 'SIGKILL');
  const saved = readFileSync(recordPath, 'utf8'), commandSaved = readFileSync(commandPath, 'utf8');
  const result = await createNativeE2BSkillRuntime({ ...h.options, loadPackages: () => assert.fail('crash recovery cannot reload') }).execute(request());
  assert.equal(result.status, 'uncertain'); assert.equal(result.remote_runtime_id, 'skill-peer-1');
  assert.deepEqual(result.command_ids, intent.commands.map(command => command.taskId));
  assert.equal(readFileSync(recordPath, 'utf8'), saved); assert.equal(readFileSync(commandPath, 'utf8'), commandSaved);
  assert.equal(h.peer.calls.length, 0); assert.equal(readFileSync(marker, 'utf8'), 'effect');
});
