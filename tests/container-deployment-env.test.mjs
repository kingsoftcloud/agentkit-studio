import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles } from '../src/portable-bundle.mjs';
import { sha256 } from '../src/portable-resources.mjs';
import { createContainerDeploymentEnvironment } from '../src/container-deployment-env.mjs';
import { planKs3BundleUpload } from '../src/ks3-bundle-store.mjs';

async function bundle(t, runtime = 'harness', primaryCredential = 'AGENTKIT_MODEL_API_KEY') {
  const storeDir = await mkdtemp(join(tmpdir(), 'studio-deployment-env-'));
  t.after(() => rm(storeDir, { force: true, recursive: true }));
  const agentId = 'ar-local-1234567890abcdef';
  const bindings = { modelProfileId: 'selected', modelProfileIds: ['other', 'selected'], mcpServers: ['search'] };
  const build = createStudioBuild({ storeDir });
  const record = await build.build({ agentId, revision: 1, metadata: { id: agentId, local: true, revision: 1 },
    spec: { runtime: { type: runtime }, bindings }, bindings });
  const portable = createPortableBundles({ storeDir, build,
    models: { profile: async id => ({ id, provider: 'openai-compatible', modelName: `${id}-model`, baseUrl: `https://${id}.example/v1`, credentialName: id === 'selected' ? primaryCredential : 'OTHER_KEY' }) },
    adapters: { describeMcp: async () => ({ resourceId: 'search', endpoint: 'https://search.example/mcp', envRefs: { Authorization: 'SEARCH_KEY' } }) },
  });
  const result = await portable.prepare(agentId, record.id);
  return Buffer.from((await portable.download(agentId, record.id, result.bundleId)).base64, 'base64');
}
const runtimeToken = 'independent-runtime-access-token';
const credentials = { AGENTKIT_MODEL_API_KEY: 'selected-private-key', OTHER_KEY: 'other-private-key', SEARCH_KEY: 'search-private-key', UNRELATED_SECRET: 'must-not-copy' };

test('all Studio runtimes reuse the frozen primary model key in the existing Container API', async t => {
  for (const runtime of ['harness', 'dsh-native', 'codex']) {
    const zip = await bundle(t, runtime), original = Buffer.from(zip);
    const rows = createContainerDeploymentEnvironment({ zip, expectedSha256: sha256(zip), runtimeToken, credentials });
    const env = Object.fromEntries(rows.map(row => [row.Key, row.Value]));
    assert.equal(env.OPENAI_API_KEY, credentials.AGENTKIT_MODEL_API_KEY);
    assert.equal(env.OPENAI_BASE_URL, 'https://selected.example/v1');
    assert.equal(env.OPENAI_MODEL_NAME, 'selected-model');
    assert.equal(env.OTHER_KEY, credentials.OTHER_KEY);
    assert.equal(env.SEARCH_KEY, credentials.SEARCH_KEY);
    assert.equal(env.UNRELATED_SECRET, undefined);
    for (const key of ['OPENAI_API_KEY', 'AGENTKIT_MODEL_API_KEY', 'OTHER_KEY', 'SEARCH_KEY', 'AGENTKIT_RUNTIME_TOKEN']) {
      assert.equal(rows.find(row => row.Key === key).IsSensitive, true);
    }
    assert.equal(new Set(rows.map(row => row.Key)).size, rows.length);
    assert.deepEqual(zip, original);
    assert.equal(zip.includes(Buffer.from(credentials.AGENTKIT_MODEL_API_KEY)), false);
  }
});

test('missing credentials and wrong ZIP digest fail before a billable create without exposing secrets', async t => {
  const zip = await bundle(t);
  const options = { zip, expectedSha256: sha256(zip), runtimeToken, credentials };
  for (const [patch, code] of [
    [{ expectedSha256: '0'.repeat(64) }, 'DEPLOYMENT_BUNDLE_MISMATCH'],
    [{ credentials: { ...credentials, SEARCH_KEY: '' } }, 'PORTABLE_CREDENTIAL_MISSING'],
    [{ runtimeToken: 'too-short' }, 'BUNDLE_HOST_TOKEN_REQUIRED'],
  ]) assert.throws(() => createContainerDeploymentEnvironment({ ...options, ...patch }), error => {
    assert.equal(error.code, code);
    for (const secret of Object.values(credentials)) assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('aliases never replace a different resource credential and keep existing sensitivity', async t => {
  const zip = await bundle(t, 'codex', 'OPENAI_API_KEY');
  const rows = createContainerDeploymentEnvironment({ zip, expectedSha256: sha256(zip), runtimeToken, credentials: { ...credentials, OPENAI_API_KEY: 'selected-private-key' } });
  assert.equal(rows.filter(row => row.Key === 'OPENAI_API_KEY').length, 1);
  assert.equal(rows.find(row => row.Key === 'OPENAI_API_KEY').IsSensitive, true);
  const collision = await bundle(t, 'harness', 'OPENAI_BASE_URL');
  assert.throws(() => createContainerDeploymentEnvironment({ zip: collision, expectedSha256: sha256(collision), runtimeToken,
    credentials: { ...credentials, OPENAI_BASE_URL: 'credential-not-url' } }), { code: 'DEPLOYMENT_ENV_CONFLICT' });
});

test('deployment refuses Host control variables as resource credentials before creating a container', async t => {
  for (const reserved of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'HOME', 'AGENTKIT_RUNTIME_TOKEN']) {
    const zip = await bundle(t, 'harness', reserved);
    assert.throws(() => createContainerDeploymentEnvironment({ zip, expectedSha256: sha256(zip), runtimeToken,
      credentials: { ...credentials, [reserved]: 'unsafe-override' } }), { code: 'BUNDLE_HOST_CREDENTIAL_RESERVED' });
  }
});

test('Container delivery references the verified private ZIP and never serializes upload credentials', async t => {
  const zip = await bundle(t);
  const reference = planKs3BundleUpload(zip, { endpoint: 'https://ks3-cn-beijing.ksyuncs.com', bucket: 'private-bundles', uploadId: '12345678-1234-1234-1234-123456789012' });
  const options = { zip, expectedSha256: sha256(zip), runtimeToken, credentials };
  const rows = createContainerDeploymentEnvironment({ ...options, bundleSource: { ...reference, secretKey: 'must-never-copy' } });
  const source = rows.find(row => row.Key === 'AGENTKIT_BUNDLE_SOURCE');
  assert.equal(source.IsSensitive, false); assert.deepEqual(JSON.parse(source.Value), reference);
  assert.throws(() => createContainerDeploymentEnvironment({ ...options, bundleSource: { ...reference, buildId: 'build_00000000000000000000' } }), { code: 'DEPLOYMENT_BUNDLE_MISMATCH' });
});
