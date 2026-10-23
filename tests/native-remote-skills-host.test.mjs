// Production Native gateway + authenticated Node Skill Service + loader,
// NativeKernel and SQLite. HTTP is real localhost; the explicit transport proxy
// preserves/asserts the signed KOP request before routing to the local peer.
// DSH's registry is a declared pipeline double, not a packed Host proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, NativeKernel, emptyUsage } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeDshTools } from '../src/providers/native-dsh-tools.mjs';
import { createNativeSkillConnection, prepareNativeSkillHost } from '../src/providers/native-skill-host.mjs';
import { createZip } from '../src/zip.mjs';
import { runtimeSkill } from '../src/skill-files.mjs';
import { skillE2BSdk } from './fixtures/native-skill-e2b-sdk.mjs';

const instructions = '---\nname: alpha\ndescription: Alpha task\n---\n# Alpha\nRead the supplied JSON.';
const zip = createZip([{ name: 'SKILL.md', data: instructions }, { name: 'scripts/run.mjs', data: 'console.log(42)' }]);
const sha = createHash('sha256').update(zip).digest('hex');
const final = () => ({ kind: 'final_candidate', text: 'Done.', toolCalls: [], usage: emptyUsage() });
async function setup(t, { wrongHash = false, denied = false, rest = false, workflow = false, localOnly = false, e2b = false, inputs = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'remote-skills-host-'))), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot);
  if (inputs) writeFileSync(join(workspaceRoot, 'source.bin'), Buffer.from([0, 255, 128, 1]));
  const stateDir = join(root, 'state'), filename = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(filename), gateway, approvals = 0, modelCalls = 0;
  const requests = [], outputs = [], registry = new Map(), agent = { session: { id: 'session' } };
  const archive = workflow ? createZip([{ name: 'SKILL.md', data: instructions }, { name: 'scripts/run-workflow.sh',
    data: inputs ? 'cat "$KSADK_SKILL_INPUT_DIR/nested/source.bin" > "$KSADK_SKILL_OUTPUT_DIR/result.bin"'
      : 'printf "Executed in Native Node runtime" > "$KSADK_SKILL_OUTPUT_DIR/result.txt"\nprintf "artifact=artifacts/result.txt\\n"' }]) : zip;
  const archiveSha = createHash('sha256').update(archive).digest('hex');
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const saved = store.load(scope, 'run');
    assert.equal(saved.snapshot.phase, 'executing_tools');
    const intent = saved.intents.find(intent => intent.operationKey === saved.snapshot.pendingIntent);
    assert.equal(intent.status, 'running'); assert.equal(intent.claimedFence, saved.lease.fence);
    if (req.url.startsWith('/archive')) {
      assert.equal(req.headers.authorization, undefined, 'cloud credentials cannot accompany archive downloads');
      res.end(archive); return;
    }
    assert.equal(req.method, 'GET');
    if (rest) {
      assert.equal(req.headers.authorization, 'Bearer original-token');
      assert.equal(req.headers['x-amz-date'], undefined);
      assert.ok(req.url.startsWith('/api/v1/'));
    } else assert.match(req.headers.authorization, /Credential=original-key\//u);
    assert.equal(req.headers['x-ksc-account-id'], 'original-account');
    const url = new URL(req.url, origin), action = rest ? url.pathname.split('/').at(-1) : url.searchParams.get('Action');
    if (!rest) assert.equal(url.searchParams.get('Version'), '2024-06-12');
    let data;
    if (action === 'ListSkillSpaces') data = { SkillSpaces: [{ SkillSpaceId: 'space', SkillSpaceName: 'Bound' }] };
    else if (action === 'ListSkillsBySpaceId') {
      assert.equal(url.searchParams.get('SpaceId'), 'space');
      assert.equal(url.searchParams.get('PageNumber'), rest ? null : '1');
      data = { SkillSpaceId: 'space', TotalCount: 1, Skills: [{ SkillId: 'skill-alpha', VersionId: 'v1', Name: 'alpha',
        Description: 'Alpha task', Status: 'active', ContentHash: `sha256:${wrongHash ? '0'.repeat(64) : archiveSha}` }] };
    } else {
      assert.equal(action, 'GetSkillDownloadUrl'); assert.equal(url.searchParams.get('SkillId'), 'skill-alpha');
      assert.equal(url.searchParams.get('VersionId'), 'v1');
      data = { DownloadUrl: 'https://archive.example/alpha.zip?signature=private-download' };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ Code: 0, Data: data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const values = { cloudAccessKey: 'original-key', cloudSecretKey: 'original-secret', cloudAccountId: 'original-account',
    cloudRegion: 'cn-beijing-6', cloudServerUrl: 'https://aicp.api.ksyun.com' };
  const proxy = (value, init) => {
    const url = new URL(value);
    assert.equal(init.redirect, 'error');
    assert.ok(url.hostname === 'aicp.api.ksyun.com' || url.hostname === 'archive.example' || rest && url.origin === origin);
    return fetch(origin + (url.hostname === 'archive.example' ? '/archive' : url.pathname + url.search), init);
  };
  const env = rest ? { KSADK_SKILL_SERVICE_URL: `${origin}/docs`, KSADK_SKILL_SERVICE_TOKEN: 'original-token' } : {};
  const connection = await createNativeSkillConnection({ configuration: { resolve: async () => ({ values }) }, env, fetchImpl: proxy });
  if (rest) { env.KSADK_SKILL_SERVICE_URL = 'https://foreign.example'; env.KSADK_SKILL_SERVICE_TOKEN = 'changed-token'; }
  // Prove activation pins source/account/credentials, rather than reading this
  // same mutable object when a later model tool call eventually arrives.
  values.cloudAccessKey = 'changed-key'; values.cloudAccountId = 'changed-account'; values.cloudServerUrl = 'https://foreign.example';
  const ctx = { effect: install => install(), sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    approval: { request: async () => { approvals++; return 'allowed-once'; } }, tools: {
      register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); },
      async execute(input) {
        if (denied) return { isError: true, content: [{ type: 'text', text: 'Policy denied' }] };
        const tool = registry.get(input.name);
        try { const value = await tool.execute(input.arguments, input);
          return { isError: false, value, content: tool.output.render(input.arguments, value) }; }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error.code ?? error.message }] }; }
      },
    } };
  const config = { agentId: scope.agentId, agentRevision: 1, skillSpaceIds: localOnly ? [] : ['space'] };
  const peer = e2b ? skillE2BSdk(t, { root: join(root, 'e2b-peer'), before(method) {
    if (!['create', 'run', 'write', 'kill'].includes(method)) return;
    const saved = store.load(scope, 'run'); assert.equal(saved.snapshot.phase, 'executing_tools');
    const intent = saved.intents.find(item => item.operationKey === saved.snapshot.pendingIntent);
    assert.equal(intent.status, 'running'); assert.equal(intent.claimedFence, saved.lease.fence);
  } }) : null;
  if (localOnly) {
    const directory = join(root, 'local-alpha'); mkdirSync(join(directory, 'scripts'), { recursive: true });
    const path = join(directory, 'SKILL.md'); writeFileSync(path, instructions);
    writeFileSync(join(directory, 'scripts/run-workflow.sh'), 'printf "Local Skill without remote service" > "$KSADK_SKILL_OUTPUT_DIR/local.txt"');
    config.skillDefinitions = [runtimeSkill({ name: 'alpha', content: instructions, path })];
  }
  const bind = () => { gateway = createNativeDshTools({ ctx, config, workspaceRoot, stateDir,
    commandEnvironment: e2b ? { KSADK_SKILL_RUNTIME_BACKEND: 'e2b', KSADK_SKILL_RUNTIME_TEMPLATE_ID: 'node-only-skills',
      E2B_API_URL: 'https://api.fixture.invalid', E2B_DOMAIN: 'fixture.invalid', E2B_API_KEY: 'never-save-peer-key' }
      : workflow || localOnly ? { KSADK_SKILL_RUNTIME_BACKEND: 'local_process' } : {},
    ...(peer ? { e2bLoadSdk: async () => peer.sdk } : {}),
    ...(!localOnly ? { skillConnection: connection } : {}), skillFetch: proxy,
    ...(inputs ? { skillInputFiles: [{ source: 'source.bin', targetPath: '/workspace/inputs/nested/source.bin' }] } : {}) }); };
  bind();
  async function run(calls) {
    const definitions = gateway.definitions(agent, [...registry.values()]);
    const data = fixture({ tools: definitions, limits: { maxModelCalls: calls.length + 2, effectTimeoutMs: 920000 } });
    const bound = gateway.forAgent(agent, { scope, store });
    const kernel = new NativeKernel({ store, digest, owner: 'skills-host', ports: { ...bound,
      model: { generate: async request => {
        const previous = request.messages.filter(message => message.role === 'tool').at(-1);
        // A policy denial is a valid plain-text tool message rather than the
        // typed JSON receipt produced after entering an owned builtin body.
        if (previous) outputs.push(previous.content.startsWith('{') ? JSON.parse(previous.content) : { text: previous.content });
        const index = modelCalls++;
        if (index >= calls.length) return final();
        return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `skill-call-${index}`,
          name: calls[index][0], arguments: calls[index][1] ?? {} }] };
      } },
    } });
    kernel.start(data.snapshot, data.config);
    return kernel.runUntilIdle(scope, 'run');
  }
  t.after(async () => { await gateway.close(); store.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  return { run, requests, outputs, root, config, connection, peer, get approvals() { return approvals; }, get gateway() { return gateway; },
    get store() { return store; }, async reopen() {
      const original = canonical(store.load(scope, 'run')); const count = requests.length;
      await gateway.close(); store.close(); store = new SqliteRunStore(filename); bind();
      const kernel = new NativeKernel({ store, digest, owner: 'replacement', ports: {
        model: { generate: () => assert.fail('completed recovery cannot call model') },
        tools: { execute: () => assert.fail('completed recovery cannot call tools') },
      } });
      await kernel.runUntilIdle(scope, 'run');
      assert.equal(canonical(store.load(scope, 'run')), original); assert.equal(requests.length, count);
    } };
}

test('actual signed Skill Service and archive HTTP enter through Native gateway and restore without executing again', async t => {
  const h = await setup(t);
  const result = await h.run([
    ['list_skill_spaces'], ['list_skills'], ['search_skills', { query: 'alpha' }],
    ['preview_skill', { skill_name: 'alpha' }], ['load_skill', { skill_name: 'alpha' }],
    ['execute_skills', { workflow_prompt: 'Use alpha' }],
  ]);
  assert.equal(result.phase, 'completed'); assert.equal(h.outputs.length, 6);
  assert.equal(h.outputs[0].spaces[0].space_id, 'space'); assert.equal(h.outputs[1].skills[0].name, 'alpha');
  assert.equal(h.outputs[2].results[0].name, 'alpha'); assert.equal(h.outputs[3].execution_context, 'manifest_preview');
  const loaded = h.outputs[4]; assert.equal(loaded.ok, true); assert.equal(loaded.instructions, instructions);
  assert.equal(loaded.version_id, 'v1'); assert.equal(loaded.skill_id, 'skill-alpha'); assert.equal(loaded.space_id, 'space');
  assert.equal(readFileSync(join(loaded.root_dir, 'scripts/run.mjs'), 'utf8'), 'console.log(42)');
  assert.equal(h.outputs[5].error_type, 'skill_runtime_unavailable'); assert.equal(h.approvals, 1);
  assert.equal(h.requests.filter(row => row.url.startsWith('/archive')).length, 1);
  assert.doesNotMatch(canonical(h.store.load(scope, 'run')), /original-secret|original-key|private-download/u);
  assert.deepEqual(h.gateway.remoteSkillBinding.userSpaceIds, ['space']);
  await h.reopen();
});

test('a corrupt remote Skill package fails hash verification without providing instructions', async t => {
  const h = await setup(t, { wrongHash: true });
  await h.run([['load_skill', { skill_name: 'alpha' }]]);
  assert.equal(h.outputs[0].ok, false); assert.equal(h.outputs[0].error_type, 'SKILL_ARCHIVE_HASH_MISMATCH');
  assert.equal(h.outputs[0].instructions, undefined);
});

test('Host-bound custom Skill Service preserves REST shape and pinned token through actual Native calls', async t => {
  const h = await setup(t, { rest: true });
  const result = await h.run([['list_skills'], ['load_skill', { skill_name: 'alpha' }]]);
  assert.equal(result.phase, 'completed'); assert.equal(h.outputs[0].skills[0].name, 'alpha');
  assert.equal(h.outputs[1].instructions, instructions);
  assert.equal(h.requests.filter(row => row.url.startsWith('/archive')).length, 1);
  assert.doesNotMatch(canonical(h.store.load(scope, 'run')), /original-token|changed-token|original-secret|private-download/u);
  await h.reopen();
});

test('the DSH denial path never enters Skill Service or the archive loader', async t => {
  const h = await setup(t, { denied: true }); const result = await h.run([['load_skill', { skill_name: 'alpha' }]]);
  assert.equal(result.phase, 'completed'); assert.equal(h.requests.length, 0);
  assert.match(canonical(h.store.load(scope, 'run').receipts), /Policy denied/u);
});

test('model arguments cannot choose a Skill Space outside the Host binding', async t => {
  const h = await setup(t); await h.run([['list_skills', { space_id: 'foreign-space' }]]);
  assert.equal(h.requests.length, 0); assert.equal(h.outputs[0].error_type, 'SKILL_SPACE_NOT_BOUND');
});

test('remote Skill mounting requires an actual connection, snapshots spaces, and participates in Host pinning', async () => {
  const config = { agentId: 'agent', agentRevision: 1, skillSpaceIds: ['space'] };
  assert.equal(prepareNativeSkillHost({ config: { agentId: 'agent' }, env: {} }), null);
  assert.throws(() => prepareNativeSkillHost({ config, env: {} }), /NATIVE_SKILL_CONNECTION_REQUIRED/u);
  const create = key => createNativeSkillConnection({ configuration: { resolve: async () => ({ values: { cloudAccessKey: key } }) } });
  const first = await create('first'), second = await create('second');
  assert.notEqual(first.bindingDigest, second.bindingDigest);
  const prepared = prepareNativeSkillHost({ config, env: {}, connection: first });
  config.skillSpaceIds.push('injected'); assert.deepEqual(prepared.binding.userSpaceIds, ['space']);
  assert.equal(prepared.definitions.length, 6); assert.equal(prepared.binding.runtime.enabled, false); prepared.close();
});

test('execute_skills enters the actual Native intent and delivers a remote package through supervised Node execution', async t => {
  const h = await setup(t, { workflow: true });
  const result = await h.run([['execute_skills', { workflow_prompt: 'Use alpha', skill_names: ['alpha'] }]]);
  assert.equal(result.phase, 'completed'); assert.equal(h.outputs.length, 1);
  const executed = h.outputs[0]; assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(executed.workflow_status, 'ok'); assert.equal(executed.executed_skill, 'alpha');
  assert.equal(executed.output_text, 'Executed in Native Node runtime');
  assert.equal(readFileSync(executed.output_files[0], 'utf8'), executed.output_text);
  assert.match(executed.runtime_id, /^local-skill:/); assert.match(executed.task_id, /^[a-f0-9]{64}$/);
  const saved = h.store.load(scope, 'run'); assert.equal(saved.intents.filter(item => item.kind === 'tool').length, 1);
  const intent = saved.intents.find(item => item.kind === 'tool');
  const receipts = saved.receipts.filter(item => item.operationKey === intent.operationKey);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'committed');
  assert.equal(h.gateway.remoteSkillBinding.runtime.backend, 'local_process'); assert.equal(h.gateway.remoteSkillBinding.runtime.enabled, true);
  assert.equal(h.requests.filter(row => row.url.startsWith('/archive')).length, 1);
  assert.doesNotMatch(canonical(saved), /original-secret|original-key|private-download/u);
  await h.reopen();
});

test('a bound local Skill executes through the Native gateway with no Skill Service connection or HTTP', async t => {
  const h = await setup(t, { localOnly: true });
  const result = await h.run([['execute_skills', { workflow_prompt: 'Use alpha', skill_names: ['alpha'] }]]);
  assert.equal(result.phase, 'completed'); assert.equal(h.outputs[0].ok, true, JSON.stringify(h.outputs[0]));
  assert.equal(h.outputs[0].output_text, 'Local Skill without remote service');
  assert.equal(readFileSync(h.outputs[0].output_files[0], 'utf8'), h.outputs[0].output_text);
  assert.equal(h.requests.length, 0); assert.equal(h.gateway.remoteSkillBinding.serviceBindingDigest, null);
  await h.reopen();
});

test('E2B Skills are mounted through the actual Native gateway, pin the independent backend and restore without another SDK effect', async t => {
  const h = await setup(t, { workflow: true, e2b: true });
  const result = await h.run([['execute_skills', { workflow_prompt: 'Use alpha', skill_names: ['alpha'] }]]);
  assert.equal(result.phase, 'completed'); const executed = h.outputs[0];
  assert.equal(executed.ok, true, JSON.stringify(executed)); assert.equal(executed.backend, 'e2b');
  assert.equal(executed.isolated, true); assert.equal(executed.workflow_status, 'ok');
  assert.equal(executed.output_text, 'Executed in Native Node runtime');
  assert.equal(readFileSync(executed.output_files[0], 'utf8'), executed.output_text);
  assert.match(executed.runtime_id, /^e2b-skill:/); assert.equal(executed.remote_runtime_id, 'skill-peer-1');
  assert.equal(executed.command_ids.length, 2); assert.equal(executed.sandbox.cleanup_status, 'completed');
  assert.equal(h.gateway.remoteSkillBinding.runtime.backend, 'e2b');
  assert.equal(h.gateway.remoteSkillBinding.runtime.host.template, 'node-only-skills');
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1);
  assert.equal(h.peer.calls.filter(call => call.method === 'run').length, 2);
  assert.equal(h.peer.calls.filter(call => call.method === 'kill').length, 1);
  const saved = h.store.load(scope, 'run'), intent = saved.intents.find(item => item.kind === 'tool');
  assert.equal(saved.receipts.filter(item => item.operationKey === intent.operationKey && item.status === 'committed').length, 1);
  assert.doesNotMatch(canonical(saved), /never-save-peer-key|original-secret|private-download/u);
  const count = h.peer.calls.length; await h.reopen(); assert.equal(h.peer.calls.length, count);
});

test('a local Skill can use the independent E2B runtime without mounting a remote Skill Service', async t => {
  const h = await setup(t, { localOnly: true, e2b: true });
  const result = await h.run([['execute_skills', { workflow_prompt: 'Use alpha', skill_names: ['alpha'] }]]);
  assert.equal(result.phase, 'completed'); assert.equal(h.outputs[0].ok, true, JSON.stringify(h.outputs[0]));
  assert.equal(h.outputs[0].backend, 'e2b'); assert.equal(h.outputs[0].output_text, 'Local Skill without remote service');
  assert.equal(h.requests.length, 0); assert.equal(h.gateway.remoteSkillBinding.serviceBindingDigest, null);
  assert.equal(h.peer.calls.filter(call => call.method === 'create').length, 1);
});

test('trusted Native gateway inputs pass through the real intent, approval and Skill Host into the E2B workflow', async t => {
  const h = await setup(t, { workflow: true, e2b: true, inputs: true });
  const result = await h.run([['execute_skills', { workflow_prompt: 'Use alpha', skill_names: ['alpha'] }]]);
  assert.equal(result.phase, 'completed'); const executed = h.outputs[0]; assert.equal(executed.ok, true, canonical(executed));
  assert.deepEqual(readFileSync(executed.output_files[0]), Buffer.from([0, 255, 128, 1]));
  assert.equal(h.approvals, 1); assert.equal(executed.input_files.files[0].path, '/workspace/inputs/nested/source.bin');
  assert.equal(h.gateway.remoteSkillBinding.inputs.contract, 'agentkit.native-skill-input-files/v1');
  const saved = h.store.load(scope, 'run'), intent = saved.intents.find(item => item.kind === 'tool');
  assert.equal(saved.receipts.filter(item => item.operationKey === intent.operationKey && item.status === 'committed').length, 1);
  const count = h.peer.calls.length; rmSync(join(h.root, 'workspace', 'source.bin')); await h.reopen();
  assert.equal(h.peer.calls.length, count, 'completed Native Run cannot reload input or replay the SDK');
});
