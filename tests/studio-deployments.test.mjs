import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles } from '../src/portable-bundle.mjs';
import { createOperationManager } from '../src/studio-operations.mjs';
import { createStudioDeployments } from '../src/studio-deployments.mjs';
import { createDeploymentStore } from '../src/deployment-store.mjs';
import { resolveDeploymentCredentials } from '../src/deployment-credentials.mjs';

async function fixture(t, { runtime = 'harness', createError, responseLost = false, health = true, gatewayHealth = false, authReady = true, initialStatus = 'RUNNING' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-deploy-')); t.after(() => rm(root, { force: true, recursive: true }));
  const agentId = 'ar-local-1234567890abcdef', cloudAgentId = 'ar-cloud-test';
  const values = { cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'test-ak', cloudSecretKey: 'test-sk', cloudBucket: 'private-test' };
  const configuration = { resolve: async () => ({ values }) };
  const profile = { id: 'model', provider: 'ksyun', modelName: 'bound-model', baseUrl: 'https://model.example/v1', credentialName: 'MODEL_KEY', apiKey: 'model-private' };
  const mcp = { resourceId: 'search', endpoint: 'https://search.example/mcp', apiKey: 'search-private' };
  const models = { profile: async () => profile }, adapters = { describeMcp: async () => mcp };
  const build = createStudioBuild({ storeDir: root }), bindings = { modelProfileId: 'model', mcpServers: ['search'] };
  const built = await build.build({ agentId, revision: 2, metadata: { id: agentId, name: 'Agent', local: true, revision: 2 }, spec: { runtime: { type: runtime }, bindings }, bindings });
  const portableBundles = createPortableBundles({ storeDir: root, build, models, adapters, configuration });
  const release = { id: '0.0.1-test', version: '0.0.1-test', label: 'Test', channel: 'preview', enabled: true, image: `hub-vpc-cn-beijing-6.kce.ksyun.com/test/runtime@sha256:${'a'.repeat(64)}`,
    platform: 'linux/amd64', port: 8080, runtimes: ['harness', 'dsh-native', 'codex'], bundleFormat: 'agentkit.portable-bundle/v1', minimumStudioVersion: '0.0.1', notices: ['Preview'] };
  const calls = [], remote = {}, key = 'platform-private-runtime-token', access = { ready: authReady, error: 'UNAUTHORIZED' };
  let deleted = false;
  const client = {
    inspectIdentity: async () => ({ kind: 'subaccount', accountId: 'owner', userUuid: 'actor', userName: 'operator' }),
    getBootstrapConfig: async () => ({ data: { Product: 'agentkit-studio', ClientType: 'studio', Region: 'cn-beijing-6', Environment: 'pre-online', Configs: { 'studio.runtime.images.v1': {
      format: 'agentkit.runtime-images/v1', environment: 'pre-online', region: 'cn-beijing-6', defaultReleaseId: release.id, releases: [release],
    } } } }),
    createAgent: async payload => {
      calls.push(['create', payload]);
      if (createError && !responseLost) throw createError;
      Object.assign(remote, { Basic: { AgentId: cloudAgentId, Name: payload.Name, Status: initialStatus, ReadyReplicas: initialStatus === 'RUNNING' ? 1 : 0 },
        Deployment: { ArtifactPath: payload.ContainerConfig.ImageAddr }, Advanced: { EnvironmentVariables: payload.Advanced.EnvironmentVariables },
        Network: { PublicEndpoint: `https://${cloudAgentId}.agent-pre.kspmas.ksyun.com` }, QuickAccess: { ApiKey: key } });
      if (createError) throw createError;
      return { data: { AgentId: cloudAgentId } };
    },
    findByName: async () => ({ data: { Agents: remote.Basic ? [remote] : [] } }),
    forAgent: id => {
      assert.equal(id, cloudAgentId);
      return {
        get: async () => { if (deleted) throw Object.assign(Error('missing'), { status: 404 }); return { data: remote }; },
        update: async patch => {
          calls.push(['update', patch]);
          const token = remote.Advanced.EnvironmentVariables.find(row => row.Key === 'AGENTKIT_RUNTIME_TOKEN');
          assert.equal(patch.EnvironmentVariablePatch.Upsert[0].Value, key);
          token.Value = '********'; // Real GetAgent masks sensitive variables.
          return { data: {} };
        },
        remove: async () => { calls.push(['delete']); deleted = true; return { data: { deleted: true } }; },
        logs: async () => ({ data: { Logs: [{ Content: `API ${key}, Authorization: Bearer private-token\ndsh web: http://127.0.0.1:34567/?token=private-launch-token\nhttps://example.test/?api_key=private-query&ok=1` }], Total: 1 } }),
      };
    },
  };
  const options = { storeDir: join(root, 'deployments'), build, portableBundles, models, adapters, configuration, client,
    operations: createOperationManager({ storeDir: join(root, 'operations') }),
    storageFactory: () => ({ upload: async (zip, reference) => { calls.push(['upload', reference]); return reference; } }),
    fetchImpl: async (url, init) => {
      calls.push(['health', String(url)]); assert.equal(init.headers.Authorization, `Bearer ${key}`);
      if (String(url).endsWith('/v1/responses')) {
        assert.deepEqual(JSON.parse(init.body), { input: '' });
        return Response.json({ error: { code: access.ready ? 'RESPONSES_SINGLE_USER_MESSAGE_REQUIRED' : access.error } }, { status: access.ready ? 400 : 401 });
      }
      return Response.json({ status: health ? gatewayHealth ? 'ok' : 'ready' : 'starting' });
    },
  };
  const service = createStudioDeployments(options);
  const input = { agentId, buildId: built.id, resources: { cpu: 2, memoryGiB: 8 } };
  const preview = await service.prepare(input);
  const request = { ...input, bundleId: preview.bundleId, releaseId: preview.releaseId, previewId: preview.previewId, idempotencyKey: 'request-test-123456' };
  async function settled() {
    for (let n = 0; n < 150; n++) {
      const records = await options.operations.list();
      if (records.length && records.every(row => ['succeeded', 'failed'].includes(row.status))) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('deployment operation did not settle');
  }
  return { root, service, options, input, preview, request, calls, remote, profile, mcp, values, settled, release, access };
}

test('three runtimes create from a frozen Build, synchronize the platform token, verify health and delete only the owned Agent', async t => {
  for (const runtime of ['harness', 'dsh-native', 'codex']) {
    const f = await fixture(t, { runtime });
    assert.equal(f.calls.length, 0, 'preflight must not upload, create or invoke a model');
    const first = await f.service.create(f.request); await f.settled();
    assert.equal((await f.service.get(first.id)).state, 'TOKEN_PENDING');
    const ready = await f.service.refresh(first.id); assert.equal(ready.state, 'READY');
    const cloud = (await f.service.agents.list()).items[0];
    assert.equal(cloud.metadata.id, ready.cloudAgentId);
    assert.equal(cloud.metadata.local, false);
    assert.equal(cloud.source, 'studio-deployment');
    assert.equal(cloud.deployment.model, 'bound-model');
    assert.equal(cloud.deployment.buildId, f.input.buildId);
    assert.equal(cloud.buildId, undefined, 'cloud must not accidentally execute a local Build');
    f.profile.modelName = 'desktop-model-changed';
    assert.equal((await f.service.agents.get(ready.cloudAgentId)).deployment.model, 'bound-model');
    assert.equal((await f.service.agents.connect(ready.cloudAgentId)).token, 'platform-private-runtime-token');
    f.profile.modelName = 'bound-model';
    assert.equal(JSON.stringify(cloud).includes('private-runtime-token'), false);
    const duplicate = await f.service.create(f.request); assert.equal(duplicate.id, first.id);
    assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
    const payload = f.calls.find(([action]) => action === 'create')[1];
    assert.equal(payload.ContainerConfig.ImageAddr, f.release.image);
    assert.equal(payload.Framework, runtime === 'codex' ? 'codex' : 'harness');
    assert.equal(payload.Advanced.EnvironmentVariables.find(row => row.Key === 'OPENAI_MODEL_NAME').Value, 'bound-model');
    const serialized = JSON.stringify(await f.service.list());
    const disk = await readFile(join(f.root, 'deployments', `${first.id}.json`), 'utf8');
    for (const secret of ['model-private', 'search-private', 'test-sk', 'platform-private-runtime-token']) {
      assert.equal(serialized.includes(secret), false); assert.equal(disk.includes(secret), false);
    }
    assert.equal((await stat(join(f.root, 'deployments', `${first.id}.json`))).mode & 0o077, 0);
    assert.equal((await f.service.remove(first.id)).state, 'DELETED');
    assert.equal((await f.service.agents.list()).items.length, 0);
    assert.equal((await f.service.agents.recover()).items[0].deployment.state, 'DELETED', 'deleted deployment history still restores its native preset');
    await assert.rejects(() => f.service.agents.connect(ready.cloudAgentId), { code: 'DEPLOYMENT_DELETED' });
    await f.service.remove(first.id); assert.equal(f.calls.filter(([action]) => action === 'delete').length, 1);
  }
});

test('root credentials stop both preflight and a changed identity before upload or creation', async t => {
  const f = await fixture(t);
  f.options.client.inspectIdentity = async () => ({ kind: 'main-account' });
  await assert.rejects(() => f.service.prepare(f.input), { code: 'CLOUD_SUBACCOUNT_REQUIRED' });
  assert.equal(f.calls.length, 0);
  let inspections = 0;
  f.options.client.inspectIdentity = async () => ++inspections === 1
    ? { kind: 'subaccount', accountId: 'owner', userUuid: 'actor', userName: 'operator' } : { kind: 'main-account' };
  const record = await f.service.create(f.request); await f.settled();
  assert.equal((await f.service.get(record.id)).state, 'FAILED');
  assert.equal(f.calls.length, 0);
});

test('cloud admission requires the current credential scope, live availability and frozen provenance', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  await assert.rejects(() => f.service.agents.connect('ar-cloud-test'), { code: 'DEPLOYMENT_NOT_READY' });
  await f.service.refresh(record.id);
  f.remote.Basic.Status = 'DELETING';
  await assert.rejects(() => f.service.agents.connect('ar-cloud-test'), { code: 'DEPLOYMENT_NOT_READY' });
  f.remote.Basic.Status = 'RUNNING'; f.remote.Deployment.ArtifactPath = 'other-image';
  await assert.rejects(() => f.service.agents.connect('ar-cloud-test'), { code: 'DEPLOYMENT_PROVENANCE_MISMATCH' });
  f.values.cloudAccessKey = 'another-operator';
  assert.equal((await f.service.agents.list()).items.length, 0);
  await assert.rejects(() => f.service.agents.connect('ar-cloud-test'), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' });
});

test('unknown create outcome persists across restart and never creates again on a repeated request', async t => {
  const f = await fixture(t, { createError: Error('connection lost with secret detail') });
  const record = await f.service.create(f.request); await f.settled();
  assert.equal((await f.service.get(record.id)).state, 'CREATE_UNKNOWN');
  const restarted = createStudioDeployments(f.options);
  await restarted.create(f.request); await restarted.refresh(record.id);
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
  assert.equal(JSON.stringify(await restarted.list()).includes('secret detail'), false);
});

test('changed image catalog or model endpoint invalidates confirmation before any cloud mutation', async t => {
  const f = await fixture(t);
  f.release.version = '0.0.1-next';
  await assert.rejects(() => f.service.create(f.request), { code: 'DEPLOYMENT_PREVIEW_STALE' });
  assert.equal(f.calls.length, 0);
  f.release.version = '0.0.1-test'; f.profile.baseUrl = 'https://another.example/v1';
  await assert.rejects(() => f.service.create(f.request), { code: 'DEPLOYMENT_RESOURCE_CHANGED' });
  assert.equal(f.calls.length, 0);
});

test('readiness needs an actual healthy endpoint and management rejects changed provenance or account', async t => {
  const f = await fixture(t, { health: false });
  const record = await f.service.create(f.request); await f.settled();
  assert.equal((await f.service.refresh(record.id)).state, 'STARTING');
  f.remote.Deployment.ArtifactPath = 'unrelated-image';
  await assert.rejects(() => f.service.remove(record.id), { code: 'DEPLOYMENT_PROVENANCE_MISMATCH' });
  assert.equal(f.calls.some(([action]) => action === 'delete'), false);
  f.values.cloudAccessKey = 'different-account';
  await assert.rejects(() => f.service.refresh(record.id), { code: 'DEPLOYMENT_ACCOUNT_CHANGED' });
});

test('frozen MCP credentials rotate only for the same endpoint and remain correctly formatted', async t => {
  const f = await fixture(t);
  const zip = Buffer.from((await f.options.portableBundles.download(f.input.agentId, f.input.buildId, f.preview.bundleId)).base64, 'base64');
  f.mcp.apiKey = 'rotated-private';
  const resolved = await resolveDeploymentCredentials({ ...f.options, zip });
  assert.ok(Object.values(resolved).includes('Bearer rotated-private'));
  f.mcp.endpoint = 'https://changed.example/mcp';
  await assert.rejects(() => resolveDeploymentCredentials({ ...f.options, zip }), { code: 'DEPLOYMENT_RESOURCE_CHANGED' });
});

test('gateway health does not prove runtime authorization or hide a pending platform update', async t => {
  const f = await fixture(t, { gatewayHealth: true });
  const record = await f.service.create(f.request); await f.settled();
  f.remote.Basic.Status = 'UPDATING';
  const updating = await f.service.refresh(record.id);
  assert.equal(updating.state, 'AVAILABLE_UPDATING');
  assert.equal(updating.tokenBound, true);
  assert.equal(updating.cloudStatus, 'UPDATING');
  f.remote.Basic.Status = 'RUNNING';
  assert.equal((await f.service.refresh(record.id)).state, 'READY');
  assert.equal(f.calls.filter(([action]) => action === 'update').length, 1, 'masked token must not cause repeated writes');
  const rejected = await fixture(t, { gatewayHealth: true, authReady: false });
  const denied = await rejected.service.create(rejected.request); await rejected.settled();
  assert.equal((await rejected.service.refresh(denied.id)).state, 'TOKEN_PENDING');
  assert.equal((await rejected.service.get(denied.id)).tokenBound, false);
});

test('a lost create response is reconciled only against matching immutable provenance, without a new create', async t => {
  const f = await fixture(t, { createError: Error('response lost'), responseLost: true });
  const record = await f.service.create(f.request); await f.settled();
  const restarted = createStudioDeployments(f.options);
  const find = f.options.client.findByName;
  f.options.client.findByName = async () => ({ data: { Agents: [f.remote], Total: 101 } });
  await assert.rejects(() => restarted.reconcile(record.id), { code: 'DEPLOYMENT_CREATE_UNCONFIRMED' });
  f.options.client.findByName = find;
  const digest = f.remote.Advanced.EnvironmentVariables.find(row => row.Key === 'AGENTKIT_BUNDLE_SHA256');
  const expected = digest.Value; digest.Value = 'foreign-bundle';
  await assert.rejects(() => restarted.reconcile(record.id), { code: 'DEPLOYMENT_PROVENANCE_MISMATCH' });
  assert.equal((await restarted.get(record.id)).cloudAgentId, null);
  digest.Value = expected;
  const reconciled = await restarted.reconcile(record.id);
  assert.equal(reconciled.cloudAgentId, 'ar-cloud-test');
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
  const logs = await restarted.logs(record.id);
  assert.equal(logs.lines.length, 1);
  assert.equal(logs.lines[0].includes('private'), false);
  assert.match(logs.lines[0], /已隐藏凭证/);
});

test('durable intent is atomic under concurrent submission; claims survive restart and corrupt records refuse replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deployment-record-')); t.after(() => rm(root, { force: true, recursive: true }));
  const store = createDeploymentStore({ storeDir: root }), plan = { agentId: 'local' };
  const results = await Promise.all(Array.from({ length: 8 }, () => store.create(plan, 'same-request-key')));
  assert.equal(results.filter(result => result.created).length, 1);
  const id = results[0].record.id;
  assert.equal(await store.claim(id, 'create'), true);
  assert.equal(await createDeploymentStore({ storeDir: root }).claim(id, 'create'), false);
  await assert.rejects(() => store.create({ agentId: 'other' }, 'same-request-key'), { code: 'DEPLOYMENT_IDEMPOTENCY_CONFLICT' });
  await writeFile(join(root, `${id}.json`), '{');
  await assert.rejects(() => store.create(plan, 'same-request-key'), { code: 'DEPLOYMENT_RECORD_CORRUPT' });
  assert.equal((await readdir(root)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('deletion waits for an in-flight health check so a late ready result cannot overwrite deleted state', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const checking = new Promise(resolve => { started = resolve; });
  const service = createStudioDeployments({ ...f.options, fetchImpl: async (...args) => {
    started(); await gate; return f.options.fetchImpl(...args);
  } });
  const refreshing = service.refresh(record.id); await checking;
  const deleting = service.remove(record.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(([action]) => action === 'delete'), false);
  release(); await refreshing;
  assert.equal((await deleting).state, 'DELETED');
  assert.equal((await service.get(record.id)).state, 'DELETED');
});

test('token synchronization waits for initial readiness; explicit repair requires a proven runtime mismatch and is single attempt', async t => {
  const f = await fixture(t, { initialStatus: 'CREATING', authReady: false });
  const record = await f.service.create(f.request); await f.settled();
  assert.equal(f.calls.some(([action]) => action === 'update'), false);
  f.remote.Basic.Status = 'RUNNING'; f.remote.Basic.ReadyReplicas = 1;
  await f.service.refresh(record.id);
  assert.equal(f.calls.filter(([action]) => action === 'update').length, 1);
  await f.service.refresh(record.id);
  await assert.rejects(() => f.service.repairAccess(record.id), { code: 'DEPLOYMENT_ACCESS_REPAIR_UNAVAILABLE' });
  f.access.error = 'RUNTIME_UNAUTHORIZED';
  assert.equal((await f.service.repairAccess(record.id)).state, 'TOKEN_PENDING');
  assert.equal(f.calls.filter(([action]) => action === 'update').length, 2);
  await assert.rejects(() => f.service.repairAccess(record.id), { code: 'DEPLOYMENT_ACCESS_REPAIR_PENDING' });
  f.access.ready = true;
  assert.equal((await f.service.refresh(record.id)).state, 'READY');
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
});
