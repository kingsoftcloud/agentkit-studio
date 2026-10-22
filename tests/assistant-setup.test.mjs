import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantSetup, ASSISTANT_WELCOME_REQUEST } from '../src/assistant-setup.mjs';
import { createAgentStore } from '../src/agent-store.mjs';
import { createStudioBuild } from '../src/studio-build.mjs';
import { sha256 } from '../src/portable-resources.mjs';

async function fixture(t, { loseWelcome = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-setup-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const values = { cloudAccessKey: 'synthetic-access', cloudSecretKey: 'synthetic-secret', cloudRegion: 'pre-online' };
  const model = { id: 'model', modelName: 'Example', apiKey: 'synthetic-model-key' };
  const records = new Map(), messages = [], calls = { create: 0, welcome: 0, upgrade: 0, upgradeInput: null };
  const release = id => ({ id, version: id, label: 'Fixture', enabled: true, channel: 'preview', runtimeIdentity: true,
    capabilities: ['personal-assistant/v1', 'personal-assistant-workspace-managed/v1'],
    image: `hub.kce.ksyun.com/test/runtime@sha256:${id === 'assistant-fixture' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
    port: 8080, platform: 'linux/amd64', runtimes: ['dsh-native'], bundleFormat: 'agentkit.portable-bundle/v1', minimumStudioVersion: '0.0.2', notices: [] });
  const catalog = { format: 'agentkit.runtime-images/v1', environment: 'pre-online', region: 'cn-beijing-6', defaultReleaseId: null, releases: [release('assistant-fixture')] };
  const deps = { storeDir: join(root, 'setup'), configuration: { resolve: async () => ({ values }) }, models: { profile: async () => model },
    agents: createAgentStore({ storeDir: join(root, 'agents') }), build: createStudioBuild({ storeDir: root }),
    serverClient: { listResource: async () => ({ items: [{ resourceId: 'memory', name: 'My memory', region: 'cn-beijing-6' }], total: 1 }) },
    deploymentClient: { getBootstrapConfig: async () => ({ data: {
      Product: 'agentkit-studio', ClientType: 'studio', Environment: 'pre-online', Region: 'cn-beijing-6',
      Capabilities: { ContainerStorage: { Contract: 'agentengine.container-storage/v1', Frameworks: ['harness'], MinSizeGi: 20, MaxSizeGi: 500, MaxReplicas: 1, PaymentType: 'Daily' } },
      Configs: { 'studio.runtime.images.v1': catalog },
    } }) },
    deployments: {
      prepare: async input => ({ ...input, previewId: 'preview', bundleId: 'bundle' }),
      prepareUpdate: async input => ({ ...input, previewId: 'upgrade-preview', bundleId: 'upgrade-bundle', releaseId: input.releaseId }),
      applyUpdate: async input => { calls.upgrade++; calls.upgradeInput = input; return { deploymentId: input.deploymentId, state: 'UPDATING' }; },
      get: async id => { if (!records.has(id)) throw Object.assign(Error(), { code: 'DEPLOYMENT_NOT_FOUND' }); return records.get(id); },
      create: async input => { calls.create++; const id = 'dep_' + sha256(input.idempotencyKey).slice(0, 32); const d = { id, state: 'PROVISIONING', cloudAgentId: 'ar-cloud-test' }; records.set(id, d); return d; },
      refresh: async id => { const d = { ...records.get(id), state: 'READY' }; records.set(id, d); return d; },
      agents: { connect: async () => ({ endpoint: 'https://assistant.test', token: 'synthetic-runtime-token', capabilities: ['personal-assistant/v1', 'personal-assistant-workspace-managed/v1'] }) },
    },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/snapshot')) return Response.json({ messages });
      const input = JSON.parse(init.body); assert.equal(input.requestId, ASSISTANT_WELCOME_REQUEST);
      calls.welcome++; messages.push({ requestId: input.requestId });
      if (loseWelcome) { loseWelcome = false; throw new TypeError('lost response containing synthetic-runtime-token'); }
      return Response.json({ accepted: true, requestId: input.requestId });
    },
  };
  return { root, values, deps, calls, catalog, release, service: createAssistantSetup(deps) };
}
async function until(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } assert.fail('setup did not settle'); }

test('opening is explicit, deduplicated, durable and welcomes only after cloud readiness', async t => {
  const f = await fixture(t), options = await f.service.options();
  assert.equal((await f.service.status()).state, 'NOT_STARTED'); assert.equal(f.calls.create, 0);
  const input = { confirmed: true, optionsId: options.optionsId, memoryId: 'memory' };
  await Promise.all([f.service.start(input), f.service.start(input)]);
  await until(async () => (await f.service.status()).ready);
  const restarted = createAssistantSetup(f.deps);
  assert.equal((await restarted.status()).ready, true);
  await restarted.start(input);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.calls.create, 1); assert.equal(f.calls.welcome, 1);
  assert.equal((await f.deps.agents.list())[0].spec.security.assistantPermissions.profile, 'workspace-managed/v1');
  const files = await readdir(join(f.root, 'setup'));
  const saved = (await Promise.all(files.filter(x => x.endsWith('.json')).map(x => readFile(join(f.root, 'setup', x), 'utf8')))).join('');
  for (const secret of ['synthetic-access', 'synthetic-secret', 'synthetic-model-key', 'synthetic-runtime-token']) assert.ok(!saved.includes(secret));
  f.values.cloudAccessKey = 'another-account';
  assert.equal((await restarted.status()).state, 'NOT_STARTED');
});

test('uncertain welcome response is reconciled without another instance or welcome turn', async t => {
  const f = await fixture(t, { loseWelcome: true }), options = await f.service.options();
  await f.service.start({ confirmed: true, optionsId: options.optionsId });
  await until(async () => (await f.service.status()).ready);
  assert.equal(f.calls.create, 1); assert.equal(f.calls.welcome, 1);
});

test('confirmed deletion permits explicit reactivation with a fresh deployment intent', async t => {
  const f = await fixture(t), options = await f.service.options();
  const input = { confirmed: true, optionsId: options.optionsId };
  await f.service.start(input);
  const ready = await until(async () => { const value = await f.service.status(); return value.ready && value; });
  (await f.deps.deployments.get(ready.deploymentId)).state = 'DELETED';
  assert.equal((await f.service.status()).state, 'DELETED');
  assert.equal(f.calls.create, 1);
  await Promise.all([f.service.start(input), f.service.start(input)]);
  const reopened = await until(async () => { const value = await f.service.status(); return value.ready && value; });
  assert.notEqual(reopened.deploymentId, ready.deploymentId);
  assert.equal(f.calls.create, 2);
});

test('unconfirmed, stale and foreign memory selections cannot create an instance', async t => {
  const f = await fixture(t), options = await f.service.options();
  await assert.rejects(f.service.start({ optionsId: options.optionsId }), { code: 'ASSISTANT_CONFIRM_REQUIRED' });
  await assert.rejects(f.service.start({ confirmed: true, optionsId: 'stale' }), { code: 'ASSISTANT_OPTIONS_CHANGED' });
  await assert.rejects(f.service.start({ confirmed: true, optionsId: options.optionsId, memoryId: 'foreign' }), { code: 'ASSISTANT_MEMORY_REQUIRED' });
  assert.equal(f.calls.create, 0);
});

test('an uncertain cloud create remains visible and never becomes another paid create', async t => {
  const f = await fixture(t), options = await f.service.options();
  const original = f.deps.deployments.create;
  f.deps.deployments.create = async input => ({ ...await original(input), cloudAgentId: null, state: 'CREATE_UNKNOWN', failure: { code: 'NETWORK_FAILED', message: '请核对已有实例' } });
  const input = { confirmed: true, optionsId: options.optionsId };
  await f.service.start(input);
  const result = await until(async () => { const state = await f.service.status(); return state.state === 'CREATE_UNKNOWN' ? state : null; });
  assert.equal(result.ready, false); assert.equal(f.calls.welcome, 0);
  const restarted = createAssistantSetup(f.deps);
  assert.equal((await restarted.status()).state, 'CREATE_UNKNOWN');
  assert.equal(f.calls.create, 1);
});

test('corrupt setup locks are actionable and cannot silently leave a permanent spinner', async t => {
  const f = await fixture(t), options = await f.service.options();
  const key = sha256(JSON.stringify(['', 'pre-online', '', f.values.cloudAccessKey]));
  await mkdir(f.deps.storeDir, { recursive: true });
  await writeFile(join(f.deps.storeDir, key + '.json.lock'), '{');
  await assert.rejects(f.service.start({ confirmed: true, optionsId: options.optionsId }), { code: 'ASSISTANT_SETUP_LOCK_INVALID' });
  assert.equal(f.calls.create, 0);
});

test('assistant reference is a read-only scoped lineage, including existing records without a purpose marker', async t => {
  const f = await fixture(t);
  assert.equal(await f.service.reference(), null);
  assert.equal(f.calls.create, 0);
  const options = await f.service.options();
  await f.service.start({ confirmed: true, optionsId: options.optionsId, memoryId: 'memory' });
  await until(async () => (await f.service.status()).ready);
  const ref = await f.service.reference();
  assert.ok(ref.agentId.startsWith('ar-local-'));
  assert.equal(ref.cloudAgentId, 'ar-cloud-test');
  assert.equal((await f.deps.agents.get(ref.agentId)).metadata.purpose, 'personal-assistant');
  f.values.cloudRegion = 'another-region';
  assert.equal(await f.service.reference(), null);
  assert.equal(f.calls.create, 1);
});

test('new managed assistants require matching image capability before creating billable resources', async t => {
  const f = await fixture(t), load = f.deps.deploymentClient.getBootstrapConfig;
  f.deps.deploymentClient.getBootstrapConfig = async () => {
    const result = await load(); result.data.Configs['studio.runtime.images.v1'].releases[0].capabilities = ['personal-assistant/v1']; return result;
  };
  await assert.rejects(f.service.options(), {code:'ASSISTANT_IMAGE_UNAVAILABLE'});
  assert.equal(f.calls.create,0); assert.equal((await f.deps.agents.list()).length,0);
});

test('an older assistant image upgrades in place and keeps the existing record scope', async t => {
  const f = await fixture(t), first = await f.service.options();
  await f.service.start({ confirmed: true, optionsId: first.optionsId, memoryId: 'memory' });
  await until(async () => (await f.service.status()).ready);
  assert.equal((await f.service.status()).releaseId, 'assistant-fixture');
  assert.equal(f.calls.upgrade, 0);

  f.catalog.releases = [...f.catalog.releases, f.release('assistant-fixture-2')];
  f.catalog.defaultReleaseId = 'assistant-fixture-2';
  const available = await f.service.options();
  assert.equal(available.releaseId, 'assistant-fixture-2');
  await assert.rejects(f.service.upgrade({ confirmed: true, optionsId: 'stale-options' }), { code: 'ASSISTANT_OPTIONS_CHANGED' });
  await assert.rejects(f.service.upgrade({}), { code: 'ASSISTANT_CONFIRM_REQUIRED' });

  const upgraded = await f.service.upgrade({ confirmed: true, optionsId: available.optionsId });
  assert.equal(f.calls.upgrade, 1);
  assert.equal(f.calls.upgradeInput.releaseId, 'assistant-fixture-2');
  assert.ok(f.calls.upgradeInput.previewId && f.calls.upgradeInput.bundleId && f.calls.upgradeInput.idempotencyKey);
  assert.equal(upgraded.releaseId, 'assistant-fixture-2');
  await until(async () => (await f.service.status()).ready);
  const settled = await f.service.status();
  assert.equal(settled.releaseId, 'assistant-fixture-2');
  assert.equal(settled.ready, true);
  assert.equal(f.calls.create, 1, 'an upgrade must never create a second cloud instance');
  assert.equal(f.calls.welcome, 1, 'an upgrade must not replay the welcome turn');
});

test('cloud execution is offered only when the image advertises capability 1', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.service.options()).grants, []);
  f.catalog.releases[0].capabilities.push('personal-assistant-code-execution/v1');
  assert.deepEqual((await f.service.options()).grants, ['code-execution']);
});

test('a granted assistant is created with the grant and only welcomes when the image confirms it', async t => {
  const f = await fixture(t);
  f.catalog.releases[0].capabilities.push('personal-assistant-code-execution/v1');
  const options = await f.service.options();
  await f.service.start({ confirmed: true, optionsId: options.optionsId, memoryId: 'memory', grants: ['code-execution'] });
  await until(async () => (await f.service.status()).state === 'ACTION_REQUIRED');
  const agent = (await f.deps.agents.list())[0];
  assert.deepEqual(agent.spec.security.assistantPermissions.grants, ['code-execution']);
  assert.equal(f.calls.welcome, 0, 'the image did not confirm the capability, so no welcome turn runs');
  // An image that confirms both the managed profile and the capability can welcome.
  f.deps.deployments.agents.connect = async () => ({ endpoint: 'https://assistant.test', token: 'synthetic-runtime-token',
    capabilities: ['personal-assistant/v1', 'personal-assistant-workspace-managed/v1', 'personal-assistant-code-execution/v1'] });
  const retried = createAssistantSetup(f.deps);
  await until(async () => (await retried.status()).ready);
  assert.equal(f.calls.welcome, 1);
});

test('an existing ready assistant can enable and later revoke the grant through a spec rollout', async t => {
  const f = await fixture(t), options = await f.service.options();
  await f.service.start({ confirmed: true, optionsId: options.optionsId, memoryId: 'memory' });
  await until(async () => (await f.service.status()).ready && f.calls.welcome === 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const before = await f.deps.agents.get((await f.deps.agents.list())[0].metadata.id);
  f.catalog.releases[0].capabilities.push('personal-assistant-code-execution/v1');
  await assert.rejects(f.service.setGrants({ confirmed: true, grants: ['browser'] }), { code: 'ASSISTANT_IMAGE_UPGRADE_REQUIRED' });
  const enabling = await f.service.setGrants({ confirmed: true, grants: ['code-execution'] });
  assert.deepEqual(enabling.grants, ['code-execution']);
  assert.equal(f.calls.upgrade, 1);
  await until(async () => (await f.service.status()).ready);
  const granted = await f.deps.agents.get(before.metadata.id);
  assert.deepEqual(granted.spec.security.assistantPermissions.grants, ['code-execution']);
  assert.equal(granted.metadata.revision, before.metadata.revision + 1);
  const revoking = await f.service.setGrants({ confirmed: true, grants: [] });
  assert.deepEqual(revoking.grants, []);
  assert.equal(f.calls.upgrade, 2);
  const revoked = await f.deps.agents.get(before.metadata.id);
  assert.equal(revoked.spec.security.assistantPermissions.grants, undefined);
  assert.equal(revoked.spec.security.assistantPermissions.profile, 'workspace-managed/v1');
});
