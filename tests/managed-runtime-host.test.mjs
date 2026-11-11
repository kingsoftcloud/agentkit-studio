import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink, lstat, cp, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { FROZEN_RUNTIME_READY } from '../src/host/frozen-runtime-lifecycle.mjs';
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
  await writeFile(join(modules, '@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }));
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
  await writeFile(join(modules, '@kingsoftcloud/agentkit-studio/studio.plugin.json'), JSON.stringify({ requiredDsh: '0.2.2-rc.1' }));
  const raw = stringify({ name: 'employee', framework: 'dsh-native', artifact_type: 'ManagedRuntime',
    runtime: { name: 'dsh-native', version: 'studio-test.1' }, model: 'fixture-model', prompt: '原生声明提示词。' });
  await writeFile(manifest, raw);
  const home = join(root, 'home'); await mkdir(home, { recursive: true });
  const env = { PATH: process.env.PATH, AGENTKIT_USER_HOME: home, OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1', AGENTKIT_MODEL_API_KEY: 'fixture-key',
    AGENTKIT_RUNTIME_TOKEN: 'fixture-runtime-token-at-least-24-characters', AGENTENGINE_AGENT_ID: 'ar-managed-fixture', AGENTENGINE_AGENT_VERSION_ID: 'v1',
    AGENTENGINE_MANAGED_RUNTIME_NAME: 'dsh-native', AGENTENGINE_MANAGED_RUNTIME_VERSION: 'studio-test.1',
    AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANIFEST_SHA256: hash(raw),
    NODE_OPTIONS: '--require personal-hook', OPENAI_API_KEY: 'personal-key', KSYUN_SECRET_KEY: 'personal-cloud-key',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://langfuse.example/api/public/otel/v1/traces',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20cGs6c2s=', OTEL_SERVICE_NAME: 'fixture-service',
    OTEL_RESOURCE_ATTRIBUTES: 'agentengine.agent_id=ar-managed-fixture',
    CLOUD_MONITOR_OTLP_TRACES_ENDPOINT: 'https://cloudmonitor.example/v1/traces', CLOUD_MONITOR_OTLP_HEADERS: 'Ksc-Appkey=app-1',
    DSH_OTEL_CA_PEM_BASE64: 'cGVt', OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE: '/etc/langfuse-trust/ca-bundle.pem',
    OTEL_EXPORTER_OTLP_CERTIFICATE: '/etc/langfuse-trust/ca-bundle.pem', UNRELATED_SECRET: 'must-not-leak' };
  return { root, installation, state, manifest, env, raw };
}

test('managed Harness boots with a service binding and no model credentials in Studio', async t => {
  const f = await fixture(t);
  const raw = stringify({ ...parse(f.raw), framework: 'harness', runtime: { name: 'harness', version: 'studio-test.1' } });
  await writeFile(f.manifest, raw);
  const env = { ...f.env, AGENTENGINE_MANAGED_RUNTIME_NAME: 'harness', AGENTENGINE_MANIFEST_SHA256: hash(raw),
    AGENTKIT_ENGINE_SERVICE_URL: 'https://harness.test:8787', AGENTKIT_ENGINE_SERVICE_TOKEN: 'fixture-harness-service-token',
    AGENTKIT_ENGINE_SERVICE_CA_FILE: '/var/run/agentkit-harness/ca.crt', NODE_EXTRA_CA_CERTS: '/etc/resource/ca.crt',
    AGENTKIT_ENGINE_SERVICE_WORKSPACE: join(f.env.AGENTKIT_USER_HOME, 'workspace') };
  delete env.OPENAI_BASE_URL;
  delete env.AGENTKIT_MODEL_API_KEY;
  const plan = await prepareManagedRuntimeHost({ ...f, env });
  const runtime = await loadManagedRuntimeDefinition({ manifest: f.manifest, env: plan.env });
  assert.equal(runtime.agent.spec.runtime.type, 'native-engine');
  assert.deepEqual(runtime.modelProfiles, []);
  assert.deepEqual(runtime.harnessModelSelection, { provider: 'agentkit-studio-harness-service', model: 'fixture-model' });
  assert.equal(plan.env.OPENAI_MODEL_NAME, undefined);
  assert.equal(plan.env.AGENTKIT_ENGINE_SERVICE_TOKEN, env.AGENTKIT_ENGINE_SERVICE_TOKEN);
  assert.equal(plan.env.AGENTKIT_ENGINE_SERVICE_CA_FILE, env.AGENTKIT_ENGINE_SERVICE_CA_FILE);
  assert.equal(plan.env.NODE_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
  const withUnusedModel = await prepareManagedRuntimeHost({ ...f, env: { ...env,
    OPENAI_BASE_URL: f.env.OPENAI_BASE_URL, AGENTKIT_MODEL_API_KEY: f.env.AGENTKIT_MODEL_API_KEY } });
  assert.equal(withUnusedModel.env.AGENTKIT_MODEL_API_KEY, undefined);
  assert.equal(withUnusedModel.env.OPENAI_BASE_URL, undefined);
});

test('canonical YAML prepares a real DSH profile without ZIPs, Build ids or persisted model secrets', async t => {
  const f = await fixture(t), plan = await prepareManagedRuntimeHost(f);
  assert.match(plan.entry, /@deepseek-ai\/dsh\/lib\/bin.js$/);
  assert.equal(plan.identity.manifestSha256, hash(f.raw));
  assert.equal(plan.identity.agentId, f.env.AGENTENGINE_AGENT_ID);
  assert.equal(plan.env.AGENTKIT_RUNTIME_BUILD_ID, undefined);
  assert.equal(plan.env.AGENTKIT_BUNDLE_SHA256, undefined);
  assert.equal(plan.env.AGENTKIT_MODEL_API_KEY, f.env.AGENTKIT_MODEL_API_KEY);
  for (const name of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'KSYUN_SECRET_KEY', 'UNRELATED_SECRET']) assert.equal(plan.env[name], undefined);
  // Platform-managed observability reaches the Host child so the OTel plugin can export.
  for (const name of ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES',
    'CLOUD_MONITOR_OTLP_TRACES_ENDPOINT', 'CLOUD_MONITOR_OTLP_HEADERS', 'DSH_OTEL_CA_PEM_BASE64',
    'OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE', 'OTEL_EXPORTER_OTLP_CERTIFICATE']) assert.equal(plan.env[name], f.env[name]);
  const config = await readFile(join(plan.env.AGENTKIT_HOME, 'config.yaml'), 'utf8');
  assert.ok(!config.includes('fixture-only-key') && !JSON.stringify(plan.identity).includes('fixture-only-key'));
  assert.deepEqual(await readdir(plan.env.AGENTKIT_HOME), ['config.yaml']);
  assert.ok(!plan.args.some(arg => arg.includes('.zip')));
  const profile = join(plan.env.DSH_HOME, 'profiles/agentkit-runtime');
  assert.equal((await lstat(join(profile, 'node_modules'))).isDirectory(), true,
    'manifest and ZIP inputs must use the same profile-owned code layout');
  const marker = JSON.parse(await readFile(join(profile, '.agentkit-runtime-profile.json'), 'utf8'));
  // One Agent-scoped DSH home reuses this profile across platform versions, so
  // ownership binds the Agent; the code stays pinned by dshVersion + image digest.
  assert.deepEqual(marker.identity, { agentId: plan.identity.agentId });
  assert.equal(typeof marker.dshVersion, 'string');
});

test('managed launch preserves an explicit command backend across the child Host boundary', async t => {
  const f = await fixture(t);
  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, KSADK_SANDBOX_BACKEND: 'e2b' } });
  assert.equal(plan.env.KSADK_SANDBOX_BACKEND, 'e2b');
  assert.equal(plan.env.KSYUN_SECRET_KEY, undefined);
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

test('an accepted update keeps DSH history while Studio receipts stay version-scoped', async t => {
  const f = await fixture(t), first = await prepareManagedRuntimeHost(f);
  // A fresh deployment adopts nothing and must not leave an adoption receipt.
  await assert.rejects(readFile(join(f.state, '.dsh-adopted.json')), { code: 'ENOENT' });
  const history = join(first.env.DSH_HOME, 'native-history'); await writeFile(history, 'persisted-conversation');
  // A same-version restart reuses the Agent-scoped DSH home.
  assert.equal((await prepareManagedRuntimeHost(f)).env.DSH_HOME, first.env.DSH_HOME);
  // Every accepted update mints a new platform VersionId. It must keep reading
  // the conversations recorded before the update instead of starting empty.
  const second = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v2' } });
  assert.equal(second.env.DSH_HOME, first.env.DSH_HOME, 'DSH history is Agent state, not deployment-version state');
  assert.equal(await readFile(join(second.env.DSH_HOME, 'native-history'), 'utf8'), 'persisted-conversation');
  assert.notEqual(second.env.AGENTKIT_HOME, first.env.AGENTKIT_HOME, 'Studio receipts and model config stay version-scoped');
  // Rollback reads the same continuous history, and the immutability guards hold.
  const restored = await prepareManagedRuntimeHost(f);
  assert.equal(await readFile(join(restored.env.DSH_HOME, 'native-history'), 'utf8'), 'persisted-conversation');
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_ID: 'other-agent' } }), { code: 'MANAGED_HOST_STATE_CONFLICT' });
  const changed = f.raw.replace('原生声明提示词。', '改后的提示词。'); await writeFile(f.manifest, changed);
  await assert.rejects(prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_MANIFEST_SHA256: hash(changed) } }), { code: 'MANAGED_HOST_STATE_CONFLICT' });
  assert.equal(await readFile(history, 'utf8'), 'persisted-conversation');
});

test('a platform version change reuses the profile and its user Settings instead of rebuilding image code', async t => {
  const f = await fixture(t), first = await prepareManagedRuntimeHost(f);
  const profile = join(first.env.DSH_HOME, 'profiles/agentkit-runtime');
  const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
  await writeFile(join(profile, 'cordis.patch.yml'), `${patch}- id: user-settings\n  config:\n    theme: kept\n`);
  const second = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v2' } });
  assert.equal(second.env.DSH_HOME, first.env.DSH_HOME);
  assert.match(await readFile(join(second.env.DSH_HOME, 'profiles/agentkit-runtime/cordis.patch.yml'), 'utf8'), /theme: kept/);
  assert.deepEqual((await readdir(join(second.env.DSH_HOME, 'profiles'))).filter(name => name.startsWith('.previous-')), [],
    'unchanged image code must not churn the profile on every accepted update');
});

test('the first boot after the layout change adopts the newest legacy version-scoped DSH state', async t => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'versions'), { recursive: true });
  await writeFile(join(f.state, '.managed-runtime.json'), JSON.stringify({ format: 'agentengine.managed-state/v1', agentId: f.env.AGENTENGINE_AGENT_ID }));
  const legacyVersion = async (versionId, stamp, seed) => {
    const revision = hash(versionId), root = join(f.state, 'versions', revision);
    await mkdir(join(root, 'agentkit'), { recursive: true });
    await writeFile(join(root, '.managed-version.json'), JSON.stringify({ format: 'agentengine.managed-version/v1',
      agentId: f.env.AGENTENGINE_AGENT_ID, versionId, manifestSha256: hash(f.raw),
      runtimeName: 'dsh-native', runtimeVersion: 'studio-test.1' }));
    await utimes(join(root, '.managed-version.json'), stamp, stamp);
    await seed(root);
    return { revision, root };
  };
  const sessionAt = root => join(root, 'dsh', 'sessions', '--home-node-workspace--', 'session-one', 'session.v4.jsonl.zstd');
  const older = await legacyVersion('v1', 1_700_000_000, async root => {
    await mkdir(dirname(sessionAt(root)), { recursive: true });
    await writeFile(sessionAt(root), 'pre-update-conversation');
    await mkdir(join(root, 'dsh', 'storages'), { recursive: true });
    await writeFile(join(root, 'dsh', 'storages', 'workspace.json'), '{"workspaces":[]}\n');
    await writeFile(join(root, 'dsh', '.credentials.yaml'), 'deepseek: legacy-key\n');
    const profile = join(root, 'dsh', 'profiles', 'agentkit-runtime');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'cordis.patch.yml'),
      `- id: schedule\n  inject: [${FROZEN_RUNTIME_READY}]\n- id: legacy-settings\n  config:\n    theme: legacy\n`);
  });
  // The buggy update created a newer empty version directory (Settings only);
  // the directory that actually holds the Agent's history must win.
  await legacyVersion('v2', 1_800_000_000, async root => {
    const profile = join(root, 'dsh', 'profiles', 'agentkit-runtime');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'cordis.patch.yml'), `- id: schedule\n  inject: [${FROZEN_RUNTIME_READY}]\n`);
  });
  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v3' } });
  assert.equal(plan.env.DSH_HOME, join(f.state, 'dsh'));
  assert.equal(await readFile(join(plan.env.DSH_HOME, 'sessions', '--home-node-workspace--', 'session-one', 'session.v4.jsonl.zstd'), 'utf8'),
    'pre-update-conversation');
  assert.equal(await readFile(join(plan.env.DSH_HOME, 'storages', 'workspace.json'), 'utf8'), '{"workspaces":[]}\n');
  assert.equal(await readFile(join(plan.env.DSH_HOME, '.credentials.yaml'), 'utf8'), 'deepseek: legacy-key\n');
  if (process.platform !== 'win32') {
    const adopted = await lstat(join(plan.env.DSH_HOME, 'sessions', '--home-node-workspace--', 'session-one', 'session.v4.jsonl.zstd'));
    const original = await lstat(sessionAt(older.root));
    assert.equal(adopted.ino, original.ino, 'adoption shares the inode instead of copying the log');
    assert.equal(adopted.nlink, 2);
  }
  assert.equal((await lstat(sessionAt(older.root))).isFile(), true,
    'the root of the adopted legacy directory is left intact for a pre-fix image rollback');
  assert.match(await readFile(join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/cordis.patch.yml'), 'utf8'), /theme: legacy/);
  const adoption = JSON.parse(await readFile(join(f.state, '.dsh-adopted.json'), 'utf8'));
  assert.equal(adoption.format, 'agentengine.dsh-state-adoption/v1');
  assert.equal(adoption.adoptedFrom, `versions/${older.revision}/dsh`);
  assert.equal(typeof adoption.adoptedAt, 'string');
  // Restarts reuse the adopted home without duplicating or re-adopting it.
  const again = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v3' } });
  assert.equal(again.env.DSH_HOME, plan.env.DSH_HOME);
  assert.equal(await readFile(join(again.env.DSH_HOME, 'storages', 'workspace.json'), 'utf8'), '{"workspaces":[]}\n');
});


test('adoption follows the most recently written legacy directory after a version rollback', async t => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'versions'), { recursive: true });
  await writeFile(join(f.state, '.managed-runtime.json'), JSON.stringify({ format: 'agentengine.managed-state/v1', agentId: f.env.AGENTENGINE_AGENT_ID }));
  const seedVersion = async (versionId, receiptStamp, conversation) => {
    const revision = hash(versionId), root = join(f.state, 'versions', revision), session =
      join(root, 'dsh', 'sessions', '--home-node-workspace--', 'session-one', 'session.v4.jsonl.zstd');
    await mkdir(join(root, 'agentkit'), { recursive: true });
    await writeFile(join(root, '.managed-version.json'), JSON.stringify({ format: 'agentengine.managed-version/v1',
      agentId: f.env.AGENTENGINE_AGENT_ID, versionId, manifestSha256: hash(f.raw),
      runtimeName: 'dsh-native', runtimeVersion: 'studio-test.1' }));
    await utimes(join(root, '.managed-version.json'), receiptStamp, receiptStamp);
    await mkdir(dirname(session), { recursive: true });
    await writeFile(session, conversation);
    return { revision, session };
  };
  // v2 was created after v1, but the platform rolled back to v1 and the user
  // kept talking there: real write times must outweigh the receipt order.
  const rolledBack = await seedVersion('v1', 1_700_000_000, 'conversation-after-rollback');
  const newer = await seedVersion('v2', 1_800_000_000, 'older-conversation');
  await utimes(rolledBack.session, 1_900_000_000, 1_900_000_000);
  await utimes(newer.session, 1_750_000_000, 1_750_000_000);
  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v3' } });
  assert.equal(await readFile(join(plan.env.DSH_HOME, 'sessions', '--home-node-workspace--', 'session-one', 'session.v4.jsonl.zstd'), 'utf8'),
    'conversation-after-rollback');
  assert.equal(JSON.parse(await readFile(join(f.state, '.dsh-adopted.json'), 'utf8')).adoptedFrom, `versions/${rolledBack.revision}/dsh`);
});

test('an adopted Settings patch survives a boot that died before profile preparation', async t => {
  const f = await fixture(t), legacyPatch =
    `- id: schedule\n  inject: [${FROZEN_RUNTIME_READY}]\n- id: legacy-settings\n  config:\n    theme: adopted\n`;
  await mkdir(join(f.state, 'versions'), { recursive: true });
  await writeFile(join(f.state, '.managed-runtime.json'), JSON.stringify({ format: 'agentengine.managed-state/v1', agentId: f.env.AGENTENGINE_AGENT_ID }));
  const revision = hash('v1'), root = join(f.state, 'versions', revision);
  await mkdir(join(root, 'agentkit'), { recursive: true });
  await writeFile(join(root, '.managed-version.json'), JSON.stringify({ format: 'agentengine.managed-version/v1',
    agentId: f.env.AGENTENGINE_AGENT_ID, versionId: 'v1', manifestSha256: hash(f.raw),
    runtimeName: 'dsh-native', runtimeVersion: 'studio-test.1' }));
  const legacyProfile = join(root, 'dsh', 'profiles', 'agentkit-runtime');
  await mkdir(legacyProfile, { recursive: true });
  await writeFile(join(legacyProfile, 'cordis.patch.yml'), legacyPatch);
  const first = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v2' } });
  assert.match(await readFile(join(first.env.DSH_HOME, 'profiles/agentkit-runtime/cordis.patch.yml'), 'utf8'), /theme: adopted/);
  // Simulate the process dying between publishing the adopted home and
  // preparing the profile: the receipt must still seed the user Settings.
  await rm(join(first.env.DSH_HOME, 'profiles'), { recursive: true });
  const retry = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v2' } });
  assert.match(await readFile(join(retry.env.DSH_HOME, 'profiles/agentkit-runtime/cordis.patch.yml'), 'utf8'), /theme: adopted/,
    'the adoption receipt must keep the user Settings recoverable');
});

test('a stale adoption receipt is corrected by the directory actually adopted', async t => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'versions'), { recursive: true });
  await writeFile(join(f.state, '.managed-runtime.json'), JSON.stringify({ format: 'agentengine.managed-state/v1', agentId: f.env.AGENTENGINE_AGENT_ID }));
  const seed = async (versionId, { session, patch }) => {
    const root = join(f.state, 'versions', hash(versionId));
    await mkdir(join(root, 'agentkit'), { recursive: true });
    await writeFile(join(root, '.managed-version.json'), JSON.stringify({ format: 'agentengine.managed-version/v1',
      agentId: f.env.AGENTENGINE_AGENT_ID, versionId, manifestSha256: hash(f.raw),
      runtimeName: 'dsh-native', runtimeVersion: 'studio-test.1' }));
    const profile = join(root, 'dsh', 'profiles', 'agentkit-runtime');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'cordis.patch.yml'),
      `- id: schedule\n  inject: [${FROZEN_RUNTIME_READY}]\n- id: settings\n  config:\n    theme: ${patch}\n`);
    if (session !== undefined) {
      const log = join(root, 'dsh', 'sessions', '--home-node-workspace--', 'session-one', 'session.v4.jsonl.zstd');
      await mkdir(dirname(log), { recursive: true });
      await writeFile(log, session);
    }
  };
  await seed('v1', { session: 'conversation', patch: 'from-v1' });
  // A previous boot died after recording a settings-only v2 candidate.
  await seed('v2', { patch: 'from-v2' });
  await writeFile(join(f.state, '.dsh-adopted.json'), JSON.stringify({ format: 'agentengine.dsh-state-adoption/v1',
    adoptedFrom: `versions/${hash('v2')}/dsh`, adoptedAt: new Date().toISOString() }));
  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v3' } });
  const receipt = JSON.parse(await readFile(join(f.state, '.dsh-adopted.json'), 'utf8'));
  assert.equal(receipt.adoptedFrom, `versions/${hash('v1')}/dsh`, 'the published home must own the final provenance');
  assert.match(await readFile(join(plan.env.DSH_HOME, 'profiles/agentkit-runtime/cordis.patch.yml'), 'utf8'), /from-v1/);
});

test('a symlinked Agent DSH home is refused instead of adopted', async t => {
  const f = await fixture(t);
  await mkdir(f.state, { recursive: true });
  await writeFile(join(f.state, '.managed-runtime.json'), JSON.stringify({ format: 'agentengine.managed-state/v1', agentId: f.env.AGENTENGINE_AGENT_ID }));
  await mkdir(join(f.root, 'linked-dsh'), { recursive: true });
  await symlink(join(f.root, 'linked-dsh'), join(f.state, 'dsh'));
  await assert.rejects(prepareManagedRuntimeHost(f), { code: 'MANAGED_HOST_STATE_INVALID' });
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

test('the managed session registry is Agent-scoped and adopts the newest legacy version', async t => {
  const f = await fixture(t);
  await mkdir(join(f.state, 'versions'), { recursive: true });
  await writeFile(join(f.state, '.managed-runtime.json'), JSON.stringify({ format: 'agentengine.managed-state/v1', agentId: f.env.AGENTENGINE_AGENT_ID }));
  const seedRegistry = async (versionId, stamp, sessionIds) => {
    const revision = hash(versionId), root = join(f.state, 'versions', revision);
    const sessions = join(root, 'agentkit', 'managed-sessions', 'sessions');
    await mkdir(sessions, { recursive: true });
    await writeFile(join(root, '.managed-version.json'), JSON.stringify({ format: 'agentengine.managed-version/v1',
      agentId: f.env.AGENTENGINE_AGENT_ID, versionId, manifestSha256: hash(f.raw),
      runtimeName: 'dsh-native', runtimeVersion: 'studio-test.1' }));
    for (const id of sessionIds) {
      const path = join(sessions, `${id}.json`);
      await writeFile(path, JSON.stringify({ format: 'agentengine.dsh-session/v1', sessionId: id,
        nativeSessionId: `native-${id}`, versionId, owner: 'a'.repeat(64), userId: 'u',
        epoch: '00000000-0000-4000-8000-000000000000', phase: 'ready',
        createdAt: '2026-11-11T00:00:00.000Z' }));
      await utimes(path, stamp, stamp);
    }
    return { revision, sessions };
  };
  const older = await seedRegistry('v1', 1_700_000_000, ['old-session']);
  await seedRegistry('v2', 1_800_000_000, ['newer-session']);

  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v3' } });
  // The registry leaves the version directory so an accepted UpdateAgent keeps
  // the Hosted UI able to list and open every earlier Session.
  assert.equal(plan.env.AGENTKIT_MANAGED_SESSIONS, join(f.state, 'managed-sessions'));
  assert.notEqual(plan.env.AGENTKIT_MANAGED_SESSIONS, join(plan.env.AGENTKIT_HOME, 'managed-sessions'));
  const adopted = await readdir(join(plan.env.AGENTKIT_MANAGED_SESSIONS, 'sessions'));
  assert.deepEqual(adopted.sort(), ['newer-session.json']);
  // The legacy directory stays readable so a pre-fix image can still roll back.
  assert.deepEqual((await readdir(older.sessions)).sort(), ['old-session.json']);

  // A restart reuses the Agent-scoped registry without re-adopting.
  const again = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v4' } });
  assert.equal(again.env.AGENTKIT_MANAGED_SESSIONS, plan.env.AGENTKIT_MANAGED_SESSIONS);
  assert.deepEqual((await readdir(join(again.env.AGENTKIT_MANAGED_SESSIONS, 'sessions'))).sort(), ['newer-session.json']);
});

test('a fresh Agent gets an empty Agent-scoped session registry', async t => {
  const f = await fixture(t);
  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v1' } });
  assert.equal(plan.env.AGENTKIT_MANAGED_SESSIONS, join(f.state, 'managed-sessions'));
  // The registry creates its own `sessions` lane on first write; adoption must
  // not copy a previous Agent's ownership rows into a fresh Agent.
  assert.equal((await lstat(plan.env.AGENTKIT_MANAGED_SESSIONS)).isDirectory(), true);
});

test('Codex tuning knobs reach the Host child so a long turn stays deployment-tunable', async t => {
  const f = await fixture(t);
  const overrides = {
    AGENTKIT_CODEX_TIMEOUT_MS: '1800000',
    AGENTKIT_CODEX_IDLE_TIMEOUT_MS: '1800000',
    AGENTKIT_CODEX_STREAM_IDLE_TIMEOUT_MS: '1800000',
    AGENTKIT_CODEX_MODEL_IDLE_TIMEOUT_MS: '1860000',
    AGENTKIT_CODEX_REASONING_SUMMARY: 'concise',
    AGENTKIT_CODEX_SANDBOX: 'workspace-write',
    AGENTKIT_CODEX_APPROVAL_POLICY: 'never',
    AGENTKIT_CODEX_MODEL: 'fixture-model',
  };
  const plan = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, ...overrides } });

  // The runtime reads these names; without them in the child env the documented
  // knobs are unreachable and a long turn can only be tuned by a new image.
  for (const [name, value] of Object.entries(overrides)) assert.equal(plan.env[name], value, name);
  // An unset knob stays absent instead of being materialized as an empty value.
  const bare = await prepareManagedRuntimeHost({ ...f, env: { ...f.env, AGENTENGINE_AGENT_VERSION_ID: 'v-other' } });
  assert.equal(bare.env.AGENTKIT_CODEX_STREAM_IDLE_TIMEOUT_MS, undefined);
});
