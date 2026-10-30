import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink, lstat, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { prepareManagedRuntimeHost } from '../src/managed-runtime-host.mjs';
import { loadManagedRuntimeDefinition, createManagedAgentStore } from '../src/managed-runtime-definition.mjs';
import { createRuntimeResponsesContract } from '../src/runtime-responses-contract.mjs';
import { startBuildRuntimeHttp } from '../src/build-runtime-http.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installation = join(root, 'installation'), state = join(root, 'state'), manifest = join(root, 'agentengine.yaml');
  const modules = join(installation, 'node_modules');
  await mkdir(join(modules, '@deepseek-ai/dsh/lib'), { recursive: true });
  await mkdir(join(modules, '@kingsoftcloud/agentkit-studio'), { recursive: true });
  await writeFile(join(modules, '@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }));
  await writeFile(join(modules, '@deepseek-ai/dsh/lib/bin.js'), '// installed CLI fixture');
  // A strict CLI installation keeps the public lock dependency under its
  // declared packages. Real cross-process kernel locking has a Host verifier.
  const base = join(modules, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base');
  const persistence = join(base, 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl');
  const system = join(persistence, 'node_modules/@deepseek-ai/node-addon-system');
  await mkdir(system, { recursive: true });
  for (const [path, name] of [[base, '@deepseek-ai/dsh-base'], [persistence, '@deepseek-ai/dsh-session-persistence-jsonl']]) {
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
    await writeFile(join(path, 'index.js'), 'export {};');
  }
  await writeFile(join(system, 'package.json'), JSON.stringify({ name: '@deepseek-ai/node-addon-system', type: 'module', exports: { './flock': './flock.js' } }));
  await writeFile(join(system, 'flock.js'), 'export async function tryLockExclusive() {}');
  await writeFile(join(modules, '@kingsoftcloud/agentkit-studio/studio.plugin.json'), JSON.stringify({ requiredDsh: '0.2.1-rc.2' }));
  const raw = stringify({ name: 'employee', framework: 'dsh-native', artifact_type: 'ManagedRuntime',
    runtime: { name: 'dsh-native', version: 'studio-test.1' }, model: 'fixture-model', prompt: '原生声明提示词。' });
  await writeFile(manifest, raw);
  const env = { PATH: process.env.PATH, OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1', AGENTKIT_MODEL_API_KEY: 'fixture-key',
    AGENTKIT_RUNTIME_TOKEN: 'fixture-runtime-token-at-least-24-characters', AGENTENGINE_AGENT_ID: 'ar-managed-fixture', AGENTENGINE_AGENT_VERSION_ID: 'v1',
    AGENTENGINE_MANAGED_RUNTIME_NAME: 'dsh-native', AGENTENGINE_MANAGED_RUNTIME_VERSION: 'studio-test.1',
    AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANIFEST_SHA256: hash(raw),
    NODE_OPTIONS: '--require personal-hook', OPENAI_API_KEY: 'personal-key', KSYUN_SECRET_KEY: 'personal-cloud-key' };
  return { root, installation, state, manifest, env, raw };
}

test('canonical YAML prepares a real DSH profile without ZIPs, Build ids or persisted model secrets', async t => {
  const f = await fixture(t), plan = await prepareManagedRuntimeHost(f);
  assert.match(plan.entry, /@deepseek-ai\/dsh\/lib\/bin.js$/);
  assert.equal(plan.identity.manifestSha256, hash(f.raw));
  assert.equal(plan.identity.agentId, f.env.AGENTENGINE_AGENT_ID);
  assert.equal(plan.env.AGENTKIT_RUNTIME_BUILD_ID, undefined);
  assert.equal(plan.env.AGENTKIT_BUNDLE_SHA256, undefined);
  assert.equal(plan.env.AGENTKIT_MODEL_API_KEY, f.env.AGENTKIT_MODEL_API_KEY);
  for (const name of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'KSYUN_SECRET_KEY']) assert.equal(plan.env[name], undefined);
  const config = await readFile(join(plan.env.AGENTKIT_HOME, 'config.yaml'), 'utf8');
  assert.ok(!config.includes('fixture-only-key') && !JSON.stringify(plan.identity).includes('fixture-only-key'));
  assert.deepEqual(await readdir(plan.env.AGENTKIT_HOME), ['config.yaml']);
  assert.ok(!plan.args.some(arg => arg.includes('.zip')));
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  assert.equal((await lstat(join(profile, 'node_modules'))).isDirectory(), true,
    'manifest and ZIP inputs must use the same profile-owned code layout');
  const marker = JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json'), 'utf8'));
  assert.equal(marker.identity.agentId, plan.identity.agentId);
  assert.equal(marker.identity.versionId, plan.identity.versionId);
  assert.equal(marker.identity.manifestSha256, plan.identity.manifestSha256);
  assert.equal(marker.identity.bundleSha256, undefined);
});

for (const runtime of ['dsh-native', 'harness', 'codex']) test(`${runtime} migrates its retained profile and refreshes image code without replacing native state`, async t => {
  const f = await fixture(t), declaration = parse(f.raw);
  declaration.framework = declaration.runtime.name = runtime;
  const raw = stringify(declaration); await writeFile(f.manifest, raw);
  const env = { ...f.env, AGENTENGINE_MANAGED_RUNTIME_NAME: runtime, AGENTENGINE_MANIFEST_SHA256: hash(raw) };
  const plan = await prepareManagedRuntimeHost({ ...f, env }), profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  const history = join(plan.env.DSH_HOME, 'retained-native-history'); await writeFile(history, 'same-native-state');
  await rm(join(profile, '.agentkit-runtime-profile.json'));
  await rm(join(profile, 'node_modules'), { recursive: true });
  await symlink(join(f.installation, 'node_modules'), join(profile, 'node_modules'), 'dir');
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await prepareManagedRuntimeHost({ ...f, env });
  assert.equal((await lstat(join(profile, 'node_modules'))).isDirectory(), true);
  const next = join(f.root, 'next-installation'); await cp(f.installation, next, { recursive: true });
  await writeFile(join(next, 'node_modules/@kingsoftcloud/agentkit-studio/upgrade.mjs'), '// next image code');
  await prepareManagedRuntimeHost({ ...f, env, installation: next });
  assert.equal(await readFile(join(profile, 'node_modules/@kingsoftcloud/agentkit-studio/upgrade.mjs'), 'utf8'), '// next image code');
  assert.equal(await readFile(history, 'utf8'), 'same-native-state');
  assert.ok((await readdir(join(plan.env.DSH_HOME, 'profiles'))).filter(name => name.startsWith('.previous-')).length >= 2);
  await prepareManagedRuntimeHost({ ...f, env, installation: next });
  assert.equal(await readFile(history, 'utf8'), 'same-native-state');
});

for (const profile of ['dsh-native', 'harness', 'codex']) test(`${profile} forwards only declared MCP credentials into the actual Host launch plan`, async t => {
  const f = await fixture(t), declaration = parse(f.raw);
  declaration.framework = declaration.runtime.name = profile;
  declaration.resources = { mcp_servers: [{ id: 'crm', endpoint: 'https://crm.example.test/mcp', env_refs: { Authorization: 'MCP_CRM_TOKEN' } }] };
  const raw = stringify(declaration); await writeFile(f.manifest, raw);
  const env = { ...f.env, AGENTENGINE_MANAGED_RUNTIME_NAME: profile, AGENTENGINE_MANIFEST_SHA256: hash(raw),
    AGENTENGINE_RESOURCE_SERVER_URL: 'https://private-control.example.test',
    MCP_CRM_TOKEN: 'synthetic-declared-token', MCP_UNRELATED_TOKEN: 'synthetic-unrelated-token' };
  const plan = await prepareManagedRuntimeHost({ ...f, env });
  assert.equal(plan.env.MCP_CRM_TOKEN, env.MCP_CRM_TOKEN);
  assert.equal(plan.env.AGENTENGINE_RESOURCE_SERVER_URL, env.AGENTENGINE_RESOURCE_SERVER_URL);
  for (const name of ['MCP_UNRELATED_TOKEN', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'KSYUN_SECRET_KEY']) assert.equal(plan.env[name], undefined);
  const stored = await readFile(join(plan.env.AGENTKIT_HOME, 'config.yaml'), 'utf8');
  assert.ok(!stored.includes('synthetic-declared-token'));
  assert.ok(!JSON.stringify(plan.identity).includes('synthetic-declared-token'));
});

for (const value of [undefined, '', 'masked****value', 'bad\r\nheader']) test(`unusable declared MCP credential ${value === undefined ? 'missing' : JSON.stringify(value)} fails before state writes`, async t => {
  const f = await fixture(t), declaration = parse(f.raw);
  declaration.resources = { mcp_servers: [{ id: 'crm', endpoint: 'https://crm.example.test/mcp', env_refs: { Authorization: 'MCP_CRM_TOKEN' } }] };
  const raw = stringify(declaration); await writeFile(f.manifest, raw);
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_MANIFEST_SHA256: hash(raw), MCP_CRM_TOKEN: value } }),
    error => ['MANAGED_HOST_MCP_CREDENTIAL_MISSING', 'MANAGED_HOST_MCP_CREDENTIAL_INVALID'].includes(error.code));
  await assert.rejects(readFile(join(f.state, '.managed-runtime.json')), { code: 'ENOENT' });
});

test('a restart reuses native state; versions isolate state and rollback retains the previous history', async t => {
  const f = await fixture(t), first = await prepareManagedRuntimeHost(f);
  const history = join(first.env.DSH_HOME, 'native-history'); await writeFile(history, 'persisted-conversation');
  assert.equal((await prepareManagedRuntimeHost(f)).env.DSH_HOME, first.env.DSH_HOME);
  const second = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v2' } });
  assert.notEqual(second.env.DSH_HOME, first.env.DSH_HOME);
  const restored = await prepareManagedRuntimeHost(f);
  assert.equal(await readFile(join(restored.env.DSH_HOME, 'native-history'), 'utf8'), 'persisted-conversation');
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_ID: 'other-agent' } }), { code: 'MANAGED_HOST_STATE_CONFLICT' });
  const changed = f.raw.replace('原生声明提示词。', '改后的提示词。'); await writeFile(f.manifest, changed);
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_MANIFEST_SHA256: hash(changed) } }), { code: 'MANAGED_HOST_STATE_CONFLICT' });
  assert.equal(await readFile(history, 'utf8'), 'persisted-conversation');
});

test('a cloud resource binding requires its private Server root before creating native state', async t => {
  const f = await fixture(t), declaration = parse(f.raw);
  declaration.resources = { memory: { id: 'mem-fixture' } };
  const raw = stringify(declaration); await writeFile(f.manifest, raw);
  const env = { ...f.env, AGENTENGINE_MANIFEST_SHA256: hash(raw) };
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env }), { code: 'MANAGED_RESOURCE_SERVER_UNAVAILABLE' });
  await assert.rejects(readFile(join(f.state, '.managed-runtime.json')), { code: 'ENOENT' });
  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...env, AGENTENGINE_RESOURCE_SERVER_URL: 'https://private-control.example.test' } });
  assert.equal(plan.env.AGENTENGINE_RESOURCE_SERVER_URL, 'https://private-control.example.test');
});

test('input conflicts, absent credentials and personal directory links fail before admission', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTKIT_MODEL_API_KEY: '' } }), { code: 'MANAGED_HOST_MODEL_CREDENTIAL_MISSING' });
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTKIT_RUNTIME_BUILD_ID: 'build_0123456789abcdef0123' } }), { code: 'MANAGED_HOST_INPUT_CONFLICT' });
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: '' } }), { code: 'MANAGED_HOST_IDENTITY_INVALID' });
  await assert.rejects(readFile(join(f.state, '.managed-runtime.json')), { code: 'ENOENT' });
  await mkdir(join(f.root, 'personal')); await symlink(join(f.root, 'personal'), f.state);
  await assert.rejects(prepareManagedRuntimeHost(f), { code: 'MANAGED_HOST_STATE_INVALID' });
});

test('existing Harness/Codex consumers receive a read-only native definition view', async t => {
  const f = await fixture(t), runtime = await loadManagedRuntimeDefinition(f), store = createManagedAgentStore(runtime);
  const agent = await store.get(runtime.identity.agentId);
  assert.equal(agent.spec.instructions.system, '原生声明提示词。');
  assert.equal(agent.buildId, undefined);
  assert.equal(await store.get('other'), null);
  await store.captureRevision(agent);
  agent.spec.instructions.system = 'unauthorized overwrite';
  assert.equal((await store.get(runtime.identity.agentId)).spec.instructions.system, '原生声明提示词。');
  await assert.rejects(store.captureRevision(agent), { code: 'MANAGED_RUNTIME_READ_ONLY' });
  for (const method of ['create', 'update', 'remove']) await assert.rejects(store[method]({}), { code: 'MANAGED_RUNTIME_READ_ONLY' });
});

test('managed handles bind platform versions and the probe reports a manifest rather than a fake Build', async t => {
  const f = await fixture(t), runtime = await loadManagedRuntimeDefinition(f);
  const server = await startBuildRuntimeHttp({ agentId: runtime.identity.agentId, managedIdentity: runtime.identity,
    token: f.env.AGENTKIT_RUNTIME_TOKEN, model: 'fixture-model', port: 0, runner: async () => ({ output: 'result' }) });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address.port}/v1/agentkit/runtime`, { headers: { authorization: `Bearer ${f.env.AGENTKIT_RUNTIME_TOKEN}` } });
  const identity = await response.json();
  assert.equal(identity.format, 'agentengine.managed-runtime/v1');
  assert.equal(identity.versionId, 'v1'); assert.equal(identity.buildId, undefined); assert.equal(identity.bundleSha256, undefined);
  const contract = versionId => createRuntimeResponsesContract({ agentId: runtime.identity.agentId, versionId, definitionId: runtime.sha256,
    token: f.env.AGENTKIT_RUNTIME_TOKEN, model: 'fixture-model' });
  const first = contract('v1').parse({ input: 'first', session_id: 'same-session', request_id: 'r1' });
  assert.throws(() => contract('v2').parse({ input: 'next', previous_response_id: first.responseId }), { code: 'RESPONSES_HANDLE_INVALID' });
  assert.equal(first.metadata.agentkit.manifestSha256, runtime.sha256);
  assert.equal(first.metadata.agentkit.buildId, undefined);
});

test('managed requests are fenced to the target version and digest before native work', async t => {
  const f = await fixture(t), runtime = await loadManagedRuntimeDefinition(f);
  let writes = 0;
  const server = await startBuildRuntimeHttp({ agentId: runtime.identity.agentId, managedIdentity: runtime.identity,
    token: f.env.AGENTKIT_RUNTIME_TOKEN, model: 'fixture-model', port: 0, runner: async () => ({ output: 'unused' }),
    platformActions: { setRunControl() {}, async dispatch() { writes++; return { SessionId: 'created' }; } } });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address.port}`;
  const headers = { authorization: `Bearer ${f.env.AGENTKIT_RUNTIME_TOKEN}`, 'content-type': 'application/json',
    'x-agentengine-target-version-id': runtime.identity.versionId, 'x-agentengine-manifest-sha256': runtime.identity.manifestSha256 };
  for (const patch of [{ 'x-agentengine-target-version-id': '' }, { 'x-agentengine-target-version-id': 'old' }, { 'x-agentengine-manifest-sha256': '0'.repeat(64) }]) {
    assert.equal((await fetch(`${origin}/agentengine/api/v1/CreateSession`, { method: 'POST', headers: { ...headers, ...patch }, body: '{}' })).status, 409);
    assert.equal(writes, 0);
  }
  assert.equal((await fetch(`${origin}/agentengine/api/v1/CreateSession`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(writes, 1);
  assert.equal((await fetch(`${origin}/v1/agentkit/runtime`, { headers: { authorization: headers.authorization } })).status, 200);
});
