import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStudioImageCatalog, selectStudioImage, createDeploymentImages, STUDIO_IMAGE_CONFIG_KEY } from '../src/deployment-images.mjs';
import { createAgentEngineDeploymentClient } from '../src/server-client.mjs';

const release = { id: '0.0.1-example', version: '0.0.1-example', label: 'Studio preview', channel: 'preview', enabled: true,
  image: `hub-vpc-cn-beijing-6.kce.ksyun.com/studio/runtime@sha256:${'a'.repeat(64)}`, port: 8080, platform: 'linux/amd64',
  runtimes: ['dsh-native', 'harness', 'codex'], bundleFormat: 'agentkit.portable-bundle/v1', minimumStudioVersion: '0.0.1', notices: ['Preview acceptance remains incomplete'] };
function response(change = {}) {
  return { Product: 'agentkit-studio', ClientType: 'studio', Region: 'cn-beijing-6', Environment: 'pre-online',
    Configs: { 'bootstrap.default_image': 'legacy/image:latest', [STUDIO_IMAGE_CONFIG_KEY]: {
      format: 'agentkit.runtime-images/v1', environment: 'pre-online', region: 'cn-beijing-6', defaultReleaseId: release.id,
      releases: [{ ...release }], ...change,
    } } };
}

test('Studio selects only its scoped digest-pinned release, independently of historical defaults', () => {
  for (const runtime of release.runtimes) {
    const catalog = parseStudioImageCatalog(response(), { runtime });
    const selected = selectStudioImage(catalog);
    assert.equal(selected.image, release.image); assert.equal(selected.digest, `sha256:${'a'.repeat(64)}`);
    assert.equal(selected.namespace, 'studio'); assert.equal(selected.repository, 'runtime');
    assert.equal(catalog.environment, 'pre-online');
    selected.notices.push('mutated'); assert.equal(catalog.releases[0].notices.length, 1);
  }
});

test('missing Studio metadata is not replaced by a historical framework image', () => {
  const data = response(); delete data.Configs[STUDIO_IMAGE_CONFIG_KEY];
  assert.throws(() => parseStudioImageCatalog(data, { runtime: 'harness' }), { code: 'DEPLOYMENT_CATALOG_MISSING' });
  assert.throws(() => parseStudioImageCatalog(response(), { runtime: 'openclaw' }), { code: 'DEPLOYMENT_RUNTIME_UNSUPPORTED' });
});

test('invalid scopes, mutable image references and ambiguous releases are refused', () => {
  const cases = [
    { environment: 'production' }, { region: 'cn-guangzhou-1' }, { releases: [release, release] }, { defaultReleaseId: 'missing' },
    { releases: [{ ...release, image: 'hub.kce.ksyun.com/studio/runtime:latest' }] },
    { releases: [{ ...release, image: `attacker.invalid/studio/runtime@sha256:${'a'.repeat(64)}` }] },
    { releases: [{ ...release, bundleFormat: 'old-python/v1' }] }, { releases: [{ ...release, runtimes: ['langgraph'] }] },
    { releases: [{ ...release, minimumStudioVersion: '*' }] }, { releases: [{ ...release, port: 22 }] }, { releases: [{ ...release, platform: 'linux/arm64' }] },
  ];
  for (const invalid of cases) assert.throws(() => parseStudioImageCatalog(response(invalid), { runtime: 'harness' }), { code: 'DEPLOYMENT_CATALOG_INVALID' });
  for (const invalid of [{ Product: 'openclaw' }, { ClientType: 'cli' }]) {
    assert.throws(() => parseStudioImageCatalog({ ...response(), ...invalid }, { runtime: 'harness' }), { code: 'DEPLOYMENT_CATALOG_INVALID' });
  }
});

test('disabled, incompatible and removed defaults never silently choose another release', () => {
  for (const unavailable of [{ enabled: false }, { runtimes: ['codex'] }, { minimumStudioVersion: '0.1.0' }]) {
    const catalog = parseStudioImageCatalog(response({ releases: [{ ...release, ...unavailable }, { ...release, id: 'another' }] }), { runtime: 'harness' });
    assert.equal(catalog.defaultReleaseId, null);
    assert.throws(() => selectStudioImage(catalog), { code: 'DEPLOYMENT_IMAGE_UNAVAILABLE' });
    assert.equal(selectStudioImage(catalog, 'another').id, 'another');
  }
});

test('preview metadata cannot become a production target by moving its database scope', () => {
  const data = response({ environment: 'production' }); data.Environment = 'production';
  assert.throws(() => parseStudioImageCatalog(data, { runtime: 'harness' }), { code: 'DEPLOYMENT_CATALOG_INVALID' });
});

test('image lookup uses the existing signed bootstrap Action and makes no mutation or IAM call', async () => {
  const calls = [];
  const configuration = { resolve: async () => ({ values: { cloudAccessKey: 'test-ak', cloudSecretKey: 'test-sk', cloudRegion: 'pre-online' } }) };
  const client = createAgentEngineDeploymentClient({ configuration, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response(JSON.stringify({ Code: 0, Data: response() }));
  } });
  const images = createDeploymentImages({ client, configuration });
  const { image } = await images.resolve('harness'); assert.equal(image.image, release.image);
  assert.equal(calls.length, 1);
  const { init } = calls[0], payload = JSON.parse(init.body);
  assert.equal(payload.Action, 'GetClientBootstrapConfig');
  assert.equal(payload.Product, 'agentkit-studio'); assert.equal(payload.ClientType, 'studio');
  assert.equal(payload.Framework, 'harness'); assert.equal(payload.Region, 'cn-beijing-6');
  assert.equal(init.headers['X-KSC-CUSTOM-SOURCE'], 'pre');
  assert.match(init.headers.Authorization, /cn-beijing-6\/aicp\/aws4_request/);
});
