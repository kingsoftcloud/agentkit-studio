import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles, verifyPortableBundle } from '../src/portable-bundle.mjs';
import { createOperationManager } from '../src/studio-operations.mjs';
import { createStudioDeployments } from '../src/studio-deployments.mjs';
import { createDeploymentStore } from '../src/deployment-store.mjs';
import { resolveDeploymentCredentials } from '../src/deployment-credentials.mjs';
import { createDeploymentConversation } from '../src/deployment-conversation.mjs';
import { CLOUD_PROVIDER } from '../src/deployment-agents.mjs';
import { sha256 } from '../src/portable-resources.mjs';
import { createRuntimeResponsesContract } from '../src/runtime-responses-contract.mjs';
import { createRuntimeResponsesStream } from '../src/runtime-responses-stream.mjs';
import { modelCredentialName } from '../src/client/dsh/model-bridge.mjs';
import { createLocalMcpStore } from '../src/local-mcp-store.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createSkillDiscovery } from '../src/skill-discovery.mjs';
import { parseManagedRuntimeManifest } from '../src/managed-runtime-manifest.mjs';
import { managedResourceBindings } from '../src/managed-resource-contract.mjs';
import { createMcpLoopbackService } from './fixtures/mcp-loopback-service.mjs';

async function fixture(t, { runtime = 'harness', deploymentType = 'Container', credentialName = 'MODEL_KEY', bindings: bindingOverrides = {}, createError, responseLost = false, health = true, gatewayHealth = false, authReady = true, initialStatus = 'RUNNING', uploadDelayMs = 0, customMcp } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-deploy-')); t.after(() => rm(root, { force: true, recursive: true }));
  const agentId = 'ar-local-1234567890abcdef', cloudAgentId = 'ar-cloud-test';
  const values = { cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'test-ak', cloudSecretKey: 'test-sk', cloudBucket: deploymentType === 'ManagedRuntime' ? '' : 'private-test' };
  const configuration = { resolve: async () => ({ values }) };
  const profile = { id: 'model', provider: 'ksyun', modelName: 'bound-model', baseUrl: 'https://model.example/v1', credentialName, apiKey: 'model-private' };
  const mcp = { resourceId: 'search', endpoint: 'https://search.example/mcp', apiKey: 'search-private' };
  const models = { profile: async () => profile };
  const build = createStudioBuild({ storeDir: root }), bindings = { modelProfileId: 'model', mcpServers: ['search'], ...bindingOverrides };
  let adapters = { describeMcp: async () => mcp }, credentials;
  if (customMcp) {
    const resourceStore = createLocalMcpStore({ storeDir: join(root, 'mcps') });
    const record = await resourceStore.create({ server: { name: 'custom-header-mcp', endpointUrl: customMcp.endpoint,
      envRefs: { 'X-Service-Token': 'env://team/services.mcp' } } });
    const skillDiscovery = createSkillDiscovery({ storeDir: join(root, 'skills') }), skillSource = join(root, 'source');
    await mkdir(skillSource);
    await writeFile(join(skillSource, 'SKILL.md'), '---\nname: demo-skill\ndescription: Deployment fixture\n---\nDemo\n');
    const scan = await skillDiscovery.discover([skillSource]);
    const skill = await skillDiscovery.commitDiscovered(scan.inspectionToken, scan.candidates[0].candidateId);
    bindings.mcpServers = [record.resourceId];
    bindings.skills = [skill.resourceId];
    credentials = { resolve: async name => name === 'team/services.mcp' ? { value: customMcp.value } : null };
    adapters = createLocalResourceAdapters({ resourceStore, skillDiscovery, credentials });
    t.after(() => adapters.close());
  }
  const built = await build.build({ agentId, revision: 2, metadata: { id: agentId, name: 'Agent', local: true, revision: 2 }, spec: { runtime: { type: runtime }, bindings }, bindings });
  const portableBundles = createPortableBundles({ storeDir: root, build, models, adapters, configuration });
  const release = { id: '0.0.1-test', version: '0.0.1-test', label: 'Test', channel: 'preview', enabled: true, runtimeIdentity: true, image: `hub-vpc-cn-beijing-6.kce.ksyun.com/test/runtime@sha256:${'a'.repeat(64)}`,
    platform: 'linux/amd64', port: 8080, runtimes: ['harness', 'dsh-native', 'codex'], bundleFormat: 'agentkit.portable-bundle/v1', minimumStudioVersion: '0.0.1', notices: ['Preview'] };
  const calls = [], remote = {}, key = 'platform-private-runtime-token', access = { ready: authReady, error: 'UNAUTHORIZED' };
  const control = { failNextDetail: null };
  let deleted = false;
  const client = {
    inspectIdentity: async () => ({ kind: 'subaccount', accountId: deploymentType === 'ManagedRuntime' ? '123' : 'owner', userUuid: 'actor', userName: 'operator' }),
    getBootstrapConfig: async () => ({ data: { Product: 'agentkit-studio', ClientType: 'studio', Region: 'cn-beijing-6', Environment: 'pre-online',
      Capabilities: { ContainerStorage: { Contract: 'agentengine.container-storage/v1', Frameworks: ['harness', 'codex'], MinSizeGi: 20, MaxSizeGi: 500, MaxReplicas: 1, PaymentType: 'Daily' } }, Configs: { 'studio.runtime.images.v1': {
      format: 'agentkit.runtime-images/v1', environment: 'pre-online', region: 'cn-beijing-6', defaultReleaseId: release.id, releases: [release],
    } } } }),
    createAgent: async payload => {
      calls.push(['create', payload]);
      if (createError && !responseLost) throw createError;
      const managed = payload.DeploymentType === 'ManagedRuntime';
      Object.assign(remote, { Basic: { AgentId: cloudAgentId, Name: payload.Name, Status: initialStatus, ReadyReplicas: initialStatus === 'RUNNING' ? 1 : 0 },
        Deployment: managed
          ? { DeploymentType: 'ManagedRuntime', ArtifactPath: payload.ManagedRuntimeConfig && release.image, RuntimeConfig: { Name: payload.ManagedRuntimeConfig.RuntimeName, Version: payload.ManagedRuntimeConfig.RuntimeVersion, ...(payload.ManagedRuntimeConfig.StudioBundleArtifact ? { StudioBundleArtifact: { SHA256: payload.ManagedRuntimeConfig.StudioBundleArtifact.SHA256 } } : {}) }, Storage: payload.Storage }
          : { DeploymentType: 'Container', ArtifactPath: payload.ContainerConfig.ImageAddr, Storage: payload.Storage }, Advanced: { EnvironmentVariables: payload.Advanced.EnvironmentVariables },
        Network: { PublicEndpoint: `https://${cloudAgentId}.agent-pre.kspmas.ksyun.com` }, QuickAccess: { ApiKey: key } });
      if (createError) throw createError;
      return { data: { AgentId: cloudAgentId } };
    },
    findByName: async () => ({ data: { Agents: remote.Basic ? [remote] : [] } }),
    forAgent: id => {
      assert.equal(id, cloudAgentId);
      return {
        get: async () => {
          if (control.failNextDetail) { const error = control.failNextDetail; control.failNextDetail = null; throw error; }
          if (deleted) throw Object.assign(Error('missing'), { status: 404 });
          return { data: remote };
        },
        update: async patch => {
          calls.push(['update', patch]);
          if (access.updateError && !access.responseLost) throw access.updateError;
          if (patch.ContainerConfig) remote.Deployment.ArtifactPath = patch.ContainerConfig.ImageAddr;
          const change = patch.EnvironmentVariablePatch;
          remote.Advanced.EnvironmentVariables = remote.Advanced.EnvironmentVariables.filter(row => !(change.Delete || []).includes(row.Key) && !change.Upsert.some(item => item.Key === row.Key));
          remote.Advanced.EnvironmentVariables.push(...change.Upsert.map(row => ({ ...row, Value: row.IsSensitive ? '********' : row.Value })));
          assert.equal(change.Upsert.find(row => row.Key === 'AGENTKIT_RUNTIME_TOKEN').Value, key);
          if (access.updateError) throw access.updateError;
          return { data: {} };
        },
        remove: async () => { calls.push(['delete']); deleted = true; return { data: { deleted: true } }; },
        logs: async () => ({ data: { Logs: [{ Content: `API ${key}, Authorization: Bearer private-token\ndsh web: http://127.0.0.1:34567/?token=private-launch-token\nhttps://example.test/?api_key=private-query&ok=1` }], Total: 1 } }),
      };
    },
  };
  const options = { storeDir: join(root, 'deployments'), build, portableBundles, models, adapters, credentials, configuration, client,
    operations: createOperationManager({ storeDir: join(root, 'operations') }),
    storageFactory: () => ({ upload: async (zip, reference) => {
      calls.push(['upload', reference]);
      if (uploadDelayMs) await new Promise(resolve => setTimeout(resolve, uploadDelayMs));
      return reference;
    } }),
    fetchImpl: async (url, init) => {
      calls.push(['health', String(url)]); assert.equal(init.headers.Authorization, `Bearer ${key}`);
      if (String(url).endsWith('/v1/agentkit/runtime')) return Response.json(access.runtimeIdentity || {
        format: 'agentkit.runtime-identity/v1', status: 'ready', agentId, buildId: built.id,
        bundleSha256: remote.Advanced?.EnvironmentVariables?.find(item => item.Key === 'AGENTKIT_BUNDLE_SHA256')?.Value,
        deploymentVersion: 'initial', capabilities: [],
      });
      if (String(url).endsWith('/v1/responses')) {
        assert.deepEqual(JSON.parse(init.body), { input: '' });
        return Response.json({ error: { code: access.ready ? 'RESPONSES_SINGLE_USER_MESSAGE_REQUIRED' : access.error } }, { status: access.ready ? 400 : 401 });
      }
      return Response.json({ status: health ? gatewayHealth ? 'ok' : 'ready' : 'starting' });
    },
  };
  const service = createStudioDeployments(options);
  const input = { agentId, buildId: built.id, ...(deploymentType !== 'Container' ? { deploymentType } : {}), resources: { cpu: 2, memoryGiB: 8 } };
  const preview = await service.prepare(input);
  const request = { ...input, bundleId: preview.bundleId, ...(deploymentType === 'ManagedRuntime' ? { bundleUploadId: preview.bundleUploadId } : {}), releaseId: preview.releaseId, previewId: preview.previewId, idempotencyKey: 'request-test-123456' };
  async function settled() {
    const deadline = performance.now() + 10_000;
    let records = [];
    do {
      records = await options.operations.list();
      if (records.length && records.every(row => ['succeeded', 'failed'].includes(row.status))) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    assert.fail(`deployment operation did not settle: ${JSON.stringify(records.map(({ id, status, result }) => ({ id, status, result })))}`);
  }
  return { root, service, options, input, preview, request, calls, remote, profile, mcp, values, settled, release, access, control };
}

test('generated model credentials survive deployment preflight and container creation', async t => {
  for (const credentialName of ['AGENTKIT_MODEL_API_KEY_MH7E4S', modelCredentialName({ id: 'custom:vision' })]) {
    const f = await fixture(t, { credentialName });
    assert.equal(f.calls.length, 0, 'preflight cannot create billable resources');
    await f.service.create(f.request); await f.settled();
    const payload = f.calls.find(([action]) => action === 'create')[1];
    for (const name of [credentialName, 'OPENAI_API_KEY']) {
      assert.deepEqual(payload.Advanced.EnvironmentVariables.find(row => row.Key === name), { Key: name, Value: 'model-private', IsSensitive: true });
    }
  }
});

test('deployment checks wait for background uploads before asserting the final state', async t => {
  const f = await fixture(t, { uploadDelayMs: 1700 });
  const deployment = await f.service.create(f.request);
  let completed = false;
  // Keep cleanup behind the runner even when the wait assertion fails.
  try {
    await f.settled();
    completed = true;
    const operations = await f.options.operations.list();
    assert.equal(operations.length, 1);
    assert.equal(operations[0].status, 'succeeded');
    assert.equal((await f.service.get(deployment.id)).state, 'TOKEN_PENDING');
    assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
  } finally {
    if (!completed) await new Promise(resolve => setTimeout(resolve, 1800));
  }
});

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
    assert.deepEqual(payload.Storage, { MountPath: '/home/node', SizeGi: 20 });
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

test('ManagedRuntime delivery skips KS3 for prompt and direct MCP-only bindings', async t => {
  const f = await fixture(t, { runtime: 'harness', deploymentType: 'ManagedRuntime' });
  const created = await f.service.create(f.request);
  await f.settled();
  const payload = f.calls.find(([action]) => action === 'create')[1];
  assert.equal(payload.DeploymentType, 'ManagedRuntime');
  assert.equal(payload.ManagedRuntimeConfig.RuntimeName, 'harness');
  assert.equal(payload.ManagedRuntimeConfig.StudioBundleArtifact, undefined);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /artifact_type: ManagedRuntime/);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /mcp_servers:/);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /endpoint: https:\/\/search\.example\/mcp/);
  assert.equal(payload.ModelConfig.Model, 'bound-model');
  assert.equal(payload.Advanced.EnvironmentVariables.filter(row => row.Key.startsWith('MCP_STUDIO_')).length, 1);
  assert.equal(f.calls.filter(([action]) => action === 'upload').length, 0);
  assert.equal((await f.service.get(created.id)).state, 'READY');
  const cloud = await f.service.agents.get('ar-cloud-test');
  assert.equal(cloud.deployment.model, 'bound-model');
});

for (const deploymentType of ['ManagedRuntime', 'Container']) test(`${deploymentType} ships custom MCP Headers with a local Skill bundle using only sensitive environment values`, async t => {
  const customMcp = { value: 'fixture-only-service-value' };
  const loopback = await createMcpLoopbackService({ transport: 'http', credentialHeader: 'x-service-token', getCredential: () => customMcp.value });
  t.after(() => loopback.close());
  customMcp.endpoint = loopback.endpoint;
  const f = await fixture(t, { deploymentType, customMcp });
  assert.equal(f.preview.resourceCounts.mcps, 1);
  assert.equal(f.preview.resourceCounts.skills, 1);
  assert.ok(!JSON.stringify(f.preview).includes(customMcp.value));
  const bundle = await f.options.portableBundles.download(f.input.agentId, f.input.buildId, f.preview.bundleId);
  const archive = verifyPortableBundle(Buffer.from(bundle.base64, 'base64'));
  assert.ok(!archive.files.some(file => file.name.endsWith('.studio-installation.json')));
  assert.ok(!JSON.stringify(archive.manifest).includes('team/services.mcp'));
  if (deploymentType === 'ManagedRuntime') {
    const original = customMcp.value;
    customMcp.value = 'fixture-only-rotated-value';
    await assert.rejects(f.service.create(f.request), { code: 'DEPLOYMENT_PREVIEW_STALE' });
    assert.deepEqual(f.calls, []);
    customMcp.value = original;
  }
  const created = await f.service.create(f.request);
  await f.settled();
  const payload = f.calls.find(([action]) => action === 'create')[1];
  const manifestConfig = payload.ManagedRuntimeConfig;
  const binding = manifestConfig
    ? managedResourceBindings(parseManagedRuntimeManifest(manifestConfig.Manifest, { runtimeName: manifestConfig.RuntimeName, runtimeVersion: manifestConfig.RuntimeVersion }).resources).mcpServers[0]
    : archive.manifest.resources.mcps[0];
  const envName = binding.envRefs['X-Service-Token'];
  assert.match(envName, /^MCP_STUDIO_[A-F0-9]+_TOKEN$/);
  const environment = payload.Advanced.EnvironmentVariables;
  assert.deepEqual(environment.find(row => row.Key === envName), { Key: envName, Value: customMcp.value, IsSensitive: true });
  assert.ok(!JSON.stringify(manifestConfig || {}).includes(customMcp.value));
  assert.ok(!(await readFile(join(f.root, 'deployments', `${created.id}.json`), 'utf8')).includes(customMcp.value));
  const served = createLocalResourceAdapters({ credentials: { resolve: async name => ({ value: environment.find(row => row.Key === name)?.Value }) } });
  try { assert.equal((await served.callMcpTool(binding, loopback.toolName, {}))[0].text, loopback.receipt); }
  finally { await served.close(); }
  assert.equal(loopback.counts.authenticated, loopback.counts.requests);
  assert.equal((await f.service.refresh(created.id)).state, 'READY');
});

test('Studio streams a managed deployment through public Responses with the observed runtime identity', async t => {
  const f = await fixture(t, { runtime: 'dsh-native', deploymentType: 'ManagedRuntime' });
  await f.service.create(f.request);
  await f.settled();
  const agentId = f.remote.Basic.AgentId;
  const versionId = 'managed-target-version-1';
  const { Manifest } = f.calls.find(([action]) => action === 'create')[1].ManagedRuntimeConfig;
  const manifestSha256 = sha256(Manifest);
  Object.assign(f.remote.Deployment.RuntimeConfig, { ManifestFormat: 'agentengine.dsh-manifest/v1', ManifestSha256: manifestSha256 });
  f.remote.DeploymentState = { DesiredVersionId: versionId, ObservedVersionId: versionId, Ready: true };
  const identity = { agentId, versionId, manifestSha256 };
  const requests = [], traces = [];
  let responseIdentity = identity;
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    requests.push(pathname);
    assert.equal(init.headers.Authorization, `Bearer ${f.remote.QuickAccess.ApiKey}`);
    assert.equal(init.redirect, 'error');
    if (pathname === '/v1/agentkit/runtime') return Response.json({ error: { code: 'RUNTIME_UNAUTHORIZED' } }, { status: 401 });
    if (pathname === '/agentengine/api/v1/GetAgentUiBootstrap') {
      assert.deepEqual(JSON.parse(init.body), { AgentId: agentId });
      return Response.json({ Code: 0, Data: { Agent: { AgentId: agentId }, ApiFormats: ['responses'], Capabilities: {
        ExecutionPolicy: { Format: 'agentkit.execution-policy/v1', Modes: ['read-only', 'workspace-write'], DefaultMode: 'workspace-write' },
      } } });
    }
    assert.equal(pathname, '/v1/responses');
    assert.equal(init.headers['x-agentkit-permission-mode'], 'workspace-write');
    const contract = createRuntimeResponsesContract({ agentId: responseIdentity.agentId, versionId: responseIdentity.versionId,
      definitionId: responseIdentity.manifestSha256, model: 'bound-model', token: 'test-managed-runtime-deployment-token' });
    const events = [];
    const writer = createRuntimeResponsesStream(contract.parse(JSON.parse(init.body)), (_type, value) => events.push(value));
    writer.start();
    writer.frame({ kind: 'assistant', value: { type: 'chunk', attemptId: 'first', chunk: { type: 'text-delta', index: 0, text: 'OK' } } });
    writer.frame({ kind: 'assistant', value: { type: 'end', attemptId: 'first', outcome: { kind: 'committed', eventType: 'assistant/message' } } });
    writer.complete({ output: 'OK' });
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const service = createStudioDeployments({ ...f.options, fetchImpl });
  const stream = createDeploymentConversation({ agents: async () => service.agents, fetchImpl,
    permissionModeFor: async () => 'workspace-write', observability: { syncTrace: async trace => traces.push(trace) } });
  const deltas = [];
  const run = async () => {
    for await (const frame of stream({ agentId, provider: CLOUD_PROVIDER, model: 'bound-model', input: 'Reply OK',
      userMessage: { id: 'message-1' }, sessionId: 'studio-session' })) {
      if (frame.type === 'text-delta') deltas.push(frame.text);
    }
  };
  await run();
  assert.equal(deltas.join(''), 'OK');
  assert.deepEqual(requests, ['/agentengine/api/v1/GetAgentUiBootstrap', '/v1/responses']);
  assert.equal(traces[0].provenance.runtimeVersionId, versionId);
  for (const mismatched of [{ versionId: 'other-version' }, { manifestSha256: 'f'.repeat(64) }, { agentId: 'ar-other' }]) {
    responseIdentity = { ...identity, ...mismatched };
    await assert.rejects(run, { code: 'DEPLOYMENT_RESPONSE_MISMATCH' });
  }
  assert.deepEqual(deltas, ['OK']);
  const previousRequests = requests.length;
  f.remote.DeploymentState.ObservedVersionId = 'stale-version';
  await assert.rejects(run, { code: 'DEPLOYMENT_NOT_READY' });
  assert.equal(requests.length, previousRequests);
});

test('ManagedRuntime maps Skill Center, knowledge base and memory without a bundle artifact', async t => {
  const f = await fixture(t, { runtime: 'codex', deploymentType: 'ManagedRuntime', bindings: {
    mcpServers: [],
    plugins: [
      { enabled: true, config: { binding: { resource: { kind: 'knowledge-base', id: 'kb-1' } } } },
      { enabled: true, config: { binding: { resource: { kind: 'memory-instance', id: 'memory-1' } } } },
      { enabled: true, config: { binding: { resource: { kind: 'skill-space', id: 'space-1' } } } },
    ],
  } });
  await f.service.create(f.request);
  await f.settled();
  const payload = f.calls.find(([action]) => action === 'create')[1];
  assert.equal(payload.ManagedRuntimeConfig.StudioBundleArtifact, undefined);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /knowledge_base:/);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /memory:/);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /skill_spaces:/);
  assert.match(payload.ManagedRuntimeConfig.Manifest, /id: space-1/);
  assert.deepEqual(payload.ComponentConfig, { KnowledgeBase: { Id: 'kb-1' }, Memory: { Id: 'memory-1' } });
  assert.equal(f.calls.filter(([action]) => action === 'upload').length, 0);
});

test('unset bucket uses verified account and physical region, retaining an isolated private bundle prefix', async t => {
  const f = await fixture(t, { runtime: 'dsh-native' });
  f.values.cloudBucket = '';
  f.options.client.inspectIdentity = async () => ({ kind: 'subaccount', accountId: '1234567890', userUuid: 'actor', userName: 'operator' });
  const preview = await f.service.prepare(f.input);
  const record = await f.service.create({ ...f.request, previewId: preview.previewId, bundleId: preview.bundleId });
  await f.settled();
  const source = f.calls.find(([action]) => action === 'upload')[1];
  assert.equal(source.bucket, 'agentengine-1234567890-cn-beijing-6');
  assert.match(source.objectKey, /^studio-bundles\/v1\//);
  assert.equal(f.values.cloudBucket, '', 'default resolution must not alter saved settings');
  assert.equal((await f.service.refresh(record.id)).state, 'READY');
});

test('unknown account cannot fabricate a default bucket or create resources', async t => {
  const f = await fixture(t);
  f.values.cloudBucket = '';
  for (const accountId of [null, '', 'unverified', '123/other']) {
    f.options.client.inspectIdentity = async () => ({ kind: 'subaccount', accountId, userUuid: 'actor' });
    await assert.rejects(() => f.service.prepare(f.input), { code: 'KS3_BUCKET_REQUIRED' });
  }
  assert.equal(f.calls.length, 0);
});

test('interrupted provisioning exposes uncertainty instead of an endless spinner or another create', async t => {
  for (const [state, expected] of [['PREPARED', 'FAILED'], ['UPLOADING', 'UPLOAD_UNKNOWN'], ['UPLOADED', 'FAILED'], ['CREATING', 'CREATE_UNKNOWN']]) {
    const f = await fixture(t);
    // Persist the intent with a queued operation, as if the host exited before
    // the operation runner was able to start or finish its next write.
    const queued = [];
    const service = createStudioDeployments({ ...f.options, operations: { submit: async input => queued.push(input) } });
    const record = await service.create(f.request);
    const store = createDeploymentStore({ storeDir: join(f.root, 'deployments') });
    await store.update(record.id, { state });
    const restarted = createStudioDeployments({ ...f.options, operations: createOperationManager({ storeDir: join(f.root, 'operations') }) });
    const result = await restarted.refresh(record.id);
    assert.equal(result.state, expected);
    assert.equal(result.failure.code, 'DEPLOYMENT_CREATE_INTERRUPTED');
    await restarted.create(f.request);
    await restarted.refresh(record.id);
    assert.equal(f.calls.filter(([action]) => action === 'create' || action === 'upload').length, 0);
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

test('invalid persistence capacities cannot upload or create billable resources', async t => {
  const f = await fixture(t);
  for (const storageGiB of [-1, 19, 501, 20.5, '20', null]) {
    await assert.rejects(() => f.service.prepare({ ...f.input, resources: { ...f.input.resources, storageGiB } }), { code: 'DEPLOYMENT_STORAGE_INVALID' });
  }
  assert.equal(f.calls.length, 0);
});

test('deployment preflight defaults to 1:2 and preserves selected CPU and memory in the create request', async t => {
  const f = await fixture(t);
  for (const resources of [undefined, { cpu: 1 }, { cpu: 2, memoryGiB: 4 }, { cpu: 4, memoryGiB: 8 }, { cpu: 2, memoryGiB: 8 }, { cpu: 2, memoryGiB: 16 }]) {
    const preview = await f.service.prepare({ ...f.input, resources });
    assert.equal(preview.resources.cpu, resources?.cpu ?? 2);
    assert.equal(preview.resources.memoryGiB, resources?.memoryGiB ?? (resources?.cpu ?? 2) * 2);
  }
  assert.equal(f.calls.length, 0, 'preflight cannot create billable resources');
  for (const resources of [{ cpu: 3, memoryGiB: 6 }, { cpu: 2, memoryGiB: 6 }, { cpu: 1, memoryGiB: 1 }]) {
    await assert.rejects(() => f.service.prepare({ ...f.input, resources }), { code: 'DEPLOYMENT_RESOURCE_INVALID' });
  }
  const preview = await f.service.prepare({ ...f.input, resources: { cpu: 1, memoryGiB: 2 } });
  await f.service.create({ ...f.request, previewId: preview.previewId, bundleId: preview.bundleId, resources: preview.resources });
  await f.settled();
  assert.deepEqual(f.calls.find(([action]) => action === 'create')[1].Resource, { Cpu: 1, Memory: 2 });
});

test('old Server cannot silently discard persistent storage; temporary storage remains explicit', async t => {
  const f = await fixture(t);
  const bootstrap = f.options.client.getBootstrapConfig;
  f.options.client.getBootstrapConfig = async () => { const response = await bootstrap(); delete response.data.Capabilities; return response; };
  await assert.rejects(() => f.service.prepare(f.input), { code: 'DEPLOYMENT_STORAGE_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  const input = { ...f.input, resources: { ...f.input.resources, storageGiB: 0 } };
  const preview = await f.service.prepare(input);
  const record = await f.service.create({ ...input, bundleId: preview.bundleId, releaseId: preview.releaseId, previewId: preview.previewId, idempotencyKey: 'explicit-temporary' });
  await f.settled();
  assert.equal(f.calls.find(([type]) => type === 'create')[1].Storage, undefined);
  assert.equal((await f.service.refresh(record.id)).state, 'READY');
});

test('missing or changed cloud storage blocks readiness and invocation, but retains cleanup', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  await f.service.refresh(record.id);
  delete f.remote.Deployment.Storage;
  await assert.rejects(() => f.service.agents.connect('ar-cloud-test'), { code: 'DEPLOYMENT_STORAGE_MISMATCH' });
  const checked = await f.service.refresh(record.id);
  assert.equal(checked.state, 'ACTION_REQUIRED');
  assert.equal(checked.failure.code, 'DEPLOYMENT_STORAGE_MISMATCH');
  assert.equal((await f.service.remove(record.id)).state, 'DELETED');
});

test('a transient status read failure keeps the deployment state instead of reporting a failed write', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  const before = await f.service.get(record.id);
  f.control.failNextDetail = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const checked = await f.service.refresh(record.id);
  assert.equal(checked.state, before.state);
  assert.equal(checked.failure, null);
  assert.notEqual(checked.lastCheckedAt, before.lastCheckedAt);
  const recovered = await f.service.refresh(record.id);
  assert.equal(recovered.failure, null);
  f.control.failNextDetail = Object.assign(new Error('platform denied the request'), { code: 'SERVICE_DENIED' });
  const surfaced = await f.service.refresh(record.id);
  assert.equal(surfaced.failure.code, 'SERVICE_DENIED');
  assert.equal((await f.service.refresh(record.id)).failure, null);
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

test('updating deployment rejects deletion before claiming the action and can be deleted once running', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  f.remote.Basic.Status = 'UPDATING';
  await assert.rejects(() => f.service.remove(record.id), { code: 'DEPLOYMENT_DELETE_BUSY' });
  assert.equal(f.calls.some(([action]) => action === 'delete'), false);
  f.remote.Basic.Status = 'RUNNING';
  assert.equal((await f.service.remove(record.id)).state, 'DELETED');
});

test('refresh preserves an unknown deletion error without resubmitting deletion', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  const forAgent = f.options.client.forAgent; let count = 0;
  f.options.client.forAgent = id => ({ ...forAgent(id), remove: async () => { count++; throw Object.assign(Error('lost response'), { code: 'SERVER_UNAVAILABLE' }); } });
  const result = await f.service.remove(record.id);
  assert.equal(result.state, 'DELETE_UNKNOWN');
  assert.equal(result.failure.code, 'SERVER_UNAVAILABLE');
  assert.equal((await f.service.refresh(record.id)).failure.code, 'SERVER_UNAVAILABLE');
  await f.service.remove(record.id);
  assert.equal(count, 1);
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

async function updatePreview(f, id, revision = 3) {
  const bindings = { modelProfileId: 'model' };
  const build = await f.options.build.build({ agentId: f.input.agentId, revision, metadata: { id: f.input.agentId, local: true, name: 'Updated', revision },
    spec: { runtime: { type: f.preview.runtime }, instructions: { system: `revision-${revision}` }, bindings }, bindings });
  const preview = await f.service.prepareUpdate({ deploymentId: id, buildId: build.id });
  return { ...preview, idempotencyKey: `upgrade-request-${revision}` };
}
function serving(f, preview) {
  f.access.runtimeIdentity = { deploymentVersion: f.remote.Advanced.EnvironmentVariables.find(row => row.Key === 'AGENTKIT_DEPLOYMENT_VERSION')?.Value, format: 'agentkit.runtime-identity/v1', status: 'ready', agentId: preview.agentId, buildId: preview.buildId, bundleSha256: preview.bundleSha256 };
}

test('a running instance with a broken application can be repaired using a new frozen build', async t => {
  const f = await fixture(t, { health: false });
  const initial = await f.service.create(f.request); await f.settled();
  await f.service.refresh(initial.id);
  assert.equal((await f.service.refresh(initial.id)).state, 'STARTING');
  const preview = await updatePreview(f, initial.id);
  f.remote.Basic.ReadyReplicas = 0;
  await assert.rejects(f.service.prepareUpdate({ deploymentId: initial.id, buildId: preview.buildId }), { code: 'DEPLOYMENT_UPDATE_UNAVAILABLE' });
  f.remote.Basic.ReadyReplicas = 1;
  await f.service.applyUpdate(preview); await f.settled();
  // An accepted control-plane update alone cannot establish application readiness.
  assert.equal((await f.service.refresh(initial.id)).state, 'UPDATING');
  serving(f, preview);
  const repaired = createStudioDeployments({ ...f.options, fetchImpl: (url, init) => String(url).endsWith('/health')
    ? Promise.resolve(Response.json({ status: 'ready' })) : f.options.fetchImpl(url, init) });
  const ready = await repaired.refresh(initial.id);
  assert.equal(ready.state, 'READY');
  assert.equal(ready.cloudAgentId, 'ar-cloud-test');
  assert.equal(ready.buildId, preview.buildId);
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
});

test('cloud TLS validation failures remain actionable without exposing transport errors', async t => {
  const f = await fixture(t);
  const initial = await f.service.create(f.request); await f.settled(); await f.service.refresh(initial.id);
  const checked = createStudioDeployments({ ...f.options, fetchImpl: async () => {
    throw Object.assign(new Error('private transport diagnostic'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
  } });
  const state = await checked.refresh(initial.id);
  assert.equal(state.failure.code, 'DEPLOYMENT_TLS_UNTRUSTED');
  assert.match(state.failure.message, /CA|证书/);
  assert.doesNotMatch(JSON.stringify(state.failure), /private transport diagnostic/);
});

test('recommended image updates can preserve the same frozen Build and cloud instance', async t => {
  const f = await fixture(t);
  const initial = await f.service.create(f.request); await f.settled(); await f.service.refresh(initial.id);
  const catalog = await f.options.client.getBootstrapConfig();
  const next = { ...f.release, id: '0.0.1-next', version: '0.0.1-next', image: f.release.image.replace('a'.repeat(64), 'b'.repeat(64)) };
  const config = catalog.data.Configs['studio.runtime.images.v1']; config.releases.push(next); config.defaultReleaseId = next.id;
  f.options.client.getBootstrapConfig = async () => catalog;
  f.options.portableBundles.prepare = async () => { throw Error('image-only update must reuse the archived resource files'); };
  await assert.rejects(f.service.prepareUpdate({ deploymentId: initial.id, buildId: f.input.buildId }), { code: 'DEPLOYMENT_VERSION_UNCHANGED' });
  const preview = await f.service.prepareUpdate({ deploymentId: initial.id, buildId: f.input.buildId, useRecommendedImage: true });
  assert.equal(preview.image.id, next.id); assert.equal(preview.buildId, f.input.buildId);
  assert.equal(preview.bundleSha256, f.preview.bundleSha256);
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
  await f.service.applyUpdate({ ...preview, idempotencyKey: 'same-build-image-upgrade' }); await f.settled(); serving(f, preview);
  const updated = await f.service.refresh(initial.id);
  assert.equal(updated.state, 'READY'); assert.equal(updated.cloudAgentId, 'ar-cloud-test');
  assert.equal(updated.imageVersion, next.version); assert.equal(updated.buildId, f.input.buildId);
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
});

test('in-place upgrades and exact rollbacks require serving identity; all runtimes preserve history and platform secrets', async t => {
  for (const runtime of ['harness', 'dsh-native', 'codex']) {
    const f = await fixture(t, { runtime });
    const initial = await f.service.create(f.request); await f.settled(); await f.service.refresh(initial.id);
    const preview = await updatePreview(f, initial.id);
    f.remote.Advanced.EnvironmentVariables.push({ Key: 'KSYUN_SECRET_KEY', Value: 'platform-injected', IsSensitive: true });
    const pending = await f.service.applyUpdate(preview); await f.settled();
    assert.equal(pending.state, 'UPDATING');
    const patch = f.calls.filter(([action]) => action === 'update').at(-1)[1];
    assert(patch.EnvironmentVariablePatch.Delete.some(key => key.startsWith('MCP_STUDIO_')));
    assert(!patch.EnvironmentVariablePatch.Delete.includes('KSYUN_SECRET_KEY'));
    assert.equal(f.remote.Advanced.EnvironmentVariables.find(row => row.Key === 'KSYUN_SECRET_KEY').Value, 'platform-injected');
    assert.equal((await f.service.refresh(initial.id)).state, 'UPDATING', 'new control-plane fields and healthy old pod must not pass');
    await assert.rejects(() => f.service.agents.connect('ar-cloud-test'), { code: 'DEPLOYMENT_NOT_READY' });
    serving(f, preview); f.remote.Basic.Status = 'UPDATING';
    assert.equal((await f.service.refresh(initial.id)).state, 'UPDATING', 'do not accept rolling mixed replicas');
    f.remote.Basic.Status = 'RUNNING';
    const ready = await f.service.refresh(initial.id);
    assert.equal(ready.state, 'READY'); assert.equal(ready.buildId, preview.buildId); assert.equal(ready.versions.length, 2);
    assert.equal((await f.service.agents.get('ar-cloud-test')).deployment.versionId, ready.versionId);
    assert.equal((await f.service.agents.recover()).items.length, 2);
    f.access.runtimeIdentity.deploymentVersion = 'old-version';
    assert.equal((await f.service.refresh(initial.id)).state, 'STARTING');
    serving(f, preview); assert.equal((await f.service.refresh(initial.id)).state, 'READY');
    const raw = JSON.parse(await readFile(join(f.root, 'deployments', `${initial.id}.json`)));
    assert.equal(raw.plan.buildId, f.input.buildId, 'creation intent remains immutable');
    const restarted = createStudioDeployments(f.options);
    await restarted.applyUpdate(preview); assert.equal(f.calls.filter(([action]) => action === 'update').length, 2);
    const rollback = await restarted.prepareUpdate({ deploymentId: initial.id, rollbackVersionId: 'initial' });
    assert.equal(rollback.bundleSha256, f.preview.bundleSha256);
    await restarted.applyUpdate({ ...rollback, idempotencyKey: 'rollback-request' }); await f.settled();
    assert.equal((await restarted.refresh(initial.id)).state, 'UPDATING', 'serving the upgrade must not confirm rollback');
    serving(f, rollback);
    const restored = await restarted.refresh(initial.id);
    assert.equal(restored.state, 'READY'); assert.equal(restored.buildId, f.input.buildId); assert.equal(restored.versions.length, 3);
    assert.notEqual(restored.versionId, 'initial'); assert.equal(restored.cloudAgentId, 'ar-cloud-test');
    assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
    const publicJson = JSON.stringify(await restarted.list());
    for (const hidden of ['credentialScope', 'objectKey', 'storageEndpoint', 'platform-injected', 'model-private', 'test-sk']) assert(!publicJson.includes(hidden));
    assert.equal((await restarted.remove(initial.id)).state, 'DELETED');
  }
});

test('changed previews, foreign mutations and root identity cannot submit updates', async t => {
  const f = await fixture(t); const initial = await f.service.create(f.request); await f.settled(); await f.service.refresh(initial.id);
  await assert.rejects(() => f.service.prepareUpdate({ deploymentId: initial.id, buildId: f.input.buildId }), { code: 'DEPLOYMENT_VERSION_UNCHANGED' });
  const preview = await updatePreview(f, initial.id);
  await assert.rejects(() => f.service.applyUpdate({ ...preview, previewId: 'stale' }), { code: 'DEPLOYMENT_PREVIEW_STALE' });
  f.options.client.inspectIdentity = async () => ({ kind: 'main-account' });
  await assert.rejects(() => f.service.applyUpdate(preview), { code: 'CLOUD_SUBACCOUNT_REQUIRED' });
  f.options.client.inspectIdentity = async () => ({ kind: 'subaccount', accountId: 'owner', userUuid: 'actor' });
  f.remote.Deployment.ArtifactPath = 'foreign';
  await assert.rejects(() => f.service.applyUpdate(preview), { code: 'DEPLOYMENT_PROVENANCE_MISMATCH' });
  assert.equal(f.calls.filter(([action]) => action === 'update').length, 1);
});

test('lost update responses reconcile by serving identity after restart without replaying a cloud write', async t => {
  const f = await fixture(t); const initial = await f.service.create(f.request); await f.settled(); await f.service.refresh(initial.id);
  const preview = await updatePreview(f, initial.id);
  f.access.updateError = Error('private secret from upstream'); f.access.responseLost = true;
  await f.service.applyUpdate(preview); await f.settled();
  assert.equal((await f.service.get(initial.id)).state, 'UPDATE_UNKNOWN');
  const restarted = createStudioDeployments(f.options);
  await restarted.applyUpdate(preview);
  await assert.rejects(() => restarted.applyUpdate({ ...preview, buildId: 'different' }), { code: 'DEPLOYMENT_IDEMPOTENCY_CONFLICT' });
  assert.equal((await restarted.refresh(initial.id)).state, 'UPDATE_UNKNOWN');
  serving(f, preview);
  assert.equal((await restarted.refresh(initial.id)).state, 'READY');
  assert.equal(f.calls.filter(([action]) => action === 'update').length, 2);
  assert(!JSON.stringify(await restarted.list()).includes('private secret'));
});

test('old images cannot advertise an unverifiable update; interrupted pre-submit work can recover without a write', async t => {
  const f = await fixture(t); const initial = await f.service.create(f.request); await f.settled(); await f.service.refresh(initial.id);
  f.release.runtimeIdentity = false;
  await assert.rejects(() => updatePreview(f, initial.id), { code: 'DEPLOYMENT_IMAGE_UPGRADE_REQUIRED' });
  f.release.runtimeIdentity = true;
  const preview = await updatePreview(f, initial.id);
  const store = createDeploymentStore({ storeDir: f.options.storeDir });
  const raw = await store.get(initial.id);
  await store.update(initial.id, { state: 'UPDATING', rollout: { id: 'upd_' + 'c'.repeat(32), status: 'PREPARED', plan: raw.plan } });
  assert.equal((await f.service.refresh(initial.id)).state, 'ACTION_REQUIRED');
  assert.equal((await f.service.refresh(initial.id)).state, 'READY');
  await f.service.applyUpdate(preview); await f.settled(); serving(f, preview);
  assert.equal((await f.service.refresh(initial.id)).state, 'READY');
  assert.equal(f.calls.filter(([action]) => action === 'update').length, 2);
});

/** A cloud Agent deleted from the console answers GetAgent with 404 forever. */
function cloudAgentGone() {
  return Object.assign(new Error('GetAgent 请求失败（404）'), { code: 'SERVER_ACTION_FAILED', status: 404, action: 'GetAgent' });
}

test('deleting a receipt whose cloud Agent was deleted elsewhere retires it locally', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  f.control.failNextDetail = cloudAgentGone();
  assert.equal((await f.service.remove(record.id)).state, 'DELETED');
  assert.equal(f.calls.some(([action]) => action === 'delete'), false);
  assert.equal((await f.service.get(record.id)).state, 'DELETED');
});

test('an update preview retires the receipt and explains the deletion instead of leaking the 404', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  assert.equal((await f.service.refresh(record.id)).state, 'READY');
  f.control.failNextDetail = cloudAgentGone();
  await assert.rejects(() => f.service.prepareUpdate({ deploymentId: record.id }), { code: 'DEPLOYMENT_CLOUD_DELETED' });
  assert.equal((await f.service.get(record.id)).state, 'DELETED');
});

test('logs and access repair retire the receipt when the cloud Agent is gone', async t => {
  const f = await fixture(t);
  const record = await f.service.create(f.request); await f.settled();
  f.control.failNextDetail = cloudAgentGone();
  await assert.rejects(() => f.service.logs(record.id), { code: 'DEPLOYMENT_CLOUD_DELETED' });
  assert.equal((await f.service.get(record.id)).state, 'DELETED');
  const other = await fixture(t);
  const second = await other.service.create(other.request); await other.settled();
  other.control.failNextDetail = cloudAgentGone();
  await assert.rejects(() => other.service.repairAccess(second.id), { code: 'DEPLOYMENT_CLOUD_DELETED' });
  assert.equal((await other.service.get(second.id)).state, 'DELETED');
});
