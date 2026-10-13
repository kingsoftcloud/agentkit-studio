import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles } from '../src/portable-bundle.mjs';
import { createKs3BundleStore, planKs3BundleUpload, ks3BundleEndpoint } from '../src/ks3-bundle-store.mjs';
import { prepareBundleArchive } from '../src/bundle-source.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-ks3-')); t.after(() => rm(root, { recursive: true, force: true }));
  const build = createStudioBuild({ storeDir: root }), agentId = 'ar-local-1234567890abcdef';
  const bindings = { modelProfileId: 'model' };
  const record = await build.build({ agentId, revision: 1, metadata: { id: agentId, local: true },
    spec: { runtime: { type: 'harness' }, instructions: { system: 'Frozen identity' }, bindings }, bindings });
  const portable = createPortableBundles({ storeDir: root, build, models: { profile: async () => ({ id: 'model', modelName: 'bound-model', provider: 'gateway', baseUrl: 'https://model.example/v1', credentialName: 'MODEL_KEY' }) } });
  const exported = await portable.prepare(agentId, record.id);
  const zip = Buffer.from((await portable.download(agentId, record.id, exported.bundleId)).base64, 'base64');
  const reference = planKs3BundleUpload(zip, { endpoint: ks3BundleEndpoint('cn-beijing-6'), bucket: 'private-bundles', uploadId: randomUUID() });
  return { root, zip, reference };
}
const credentials = { accessKey: 'example-ak', secretKey: 'example-sk', sessionToken: 'example-sts-token' };

test('private upload preserves frozen bytes, signs STS/ACL, verifies download and rejects anonymous access', async t => {
  const { zip, reference } = await fixture(t), calls = []; let stored;
  const store = createKs3BundleStore({ ...credentials, fetchImpl: async (url, init) => {
    calls.push(init);
    assert.equal(String(url), `https://${reference.bucket}.ks3-cn-beijing.ksyuncs.com/${reference.objectKey}`);
    assert.equal(init.redirect, 'error');
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    if (init.method === 'PUT') {
      assert.match(init.headers.Authorization, /^KSS example-ak:/);
      assert.equal(init.headers['x-kss-security-token'], credentials.sessionToken);
      assert.equal(init.headers['x-kss-acl'], 'private');
      assert.equal(init.headers['Content-MD5'], createHash('md5').update(init.body).digest('base64'));
      stored = Buffer.from(init.body); return new Response(null, { status: 200 });
    }
    if (!init.headers.Authorization) { assert.equal(init.headers.Range, 'bytes=0-0'); return new Response(null, { status: 403 }); }
    return new Response(stored);
  } });
  const result = await store.upload(zip, reference);
  assert.deepEqual(stored, zip); assert.equal(result.verified, true); assert.equal(result.anonymousStatus, 403);
  assert.deepEqual(calls.map(x => x.method), ['HEAD', 'PUT', 'GET', 'GET']);
  assert.equal(JSON.stringify(result).includes(credentials.secretKey), false);
  assert.equal(zip.includes(Buffer.from(credentials.secretKey)), false);
});

test('upload refuses existing objects and never retries an unknown PUT result', async t => {
  const { zip, reference } = await fixture(t);
  let calls = 0;
  const existing = createKs3BundleStore({ ...credentials, fetchImpl: async () => { calls++; return new Response(null, { status: 200 }); } });
  await assert.rejects(existing.upload(zip, reference), { code: 'KS3_OBJECT_EXISTS' }); assert.equal(calls, 1);
  calls = 0;
  const unknown = createKs3BundleStore({ ...credentials, fetchImpl: async () => {
    if (++calls === 1) return new Response(null, { status: 404 }); throw Error(`transport exposed ${credentials.secretKey}`);
  } });
  await assert.rejects(unknown.upload(zip, reference), error => error.code === 'KS3_REQUEST_FAILED' && !error.message.includes(credentials.secretKey));
  assert.equal(calls, 2);
});

test('download rejects redirected targets, oversized and changed bytes, and a different build identity', async t => {
  const { zip, reference } = await fixture(t); let calls = 0;
  const store = createKs3BundleStore({ ...credentials, fetchImpl: async () => { calls++; return new Response(zip); } });
  for (const endpoint of ['http://ks3-cn-beijing.ksyuncs.com', 'https://ks3-cn-beijing.ksyuncs.com.attacker.invalid', 'https://ks3-cn-beijing.ksyuncs.com:8443', 'https://ks3-cn-beijing.ksyuncs.com/?secret=hidden']) {
    await assert.rejects(store.download({ ...reference, endpoint }), { code: 'KS3_ENDPOINT_INVALID' });
  }
  assert.equal(calls, 0);
  await assert.rejects(store.download({ ...reference, buildId: 'build_00000000000000000000' }), { code: 'KS3_RECEIPT_INVALID' });
  const changed = createKs3BundleStore({ ...credentials, fetchImpl: async () => new Response(Buffer.alloc(zip.length)) });
  await assert.rejects(changed.download(reference), { code: 'DEPLOYMENT_BUNDLE_MISMATCH' });
  const oversized = createKs3BundleStore({ ...credentials, fetchImpl: async () => new Response('oversized', { headers: { 'content-length': String(21 * 1024 * 1024) } }) });
  await assert.rejects(oversized.download(reference), { code: 'PORTABLE_ARCHIVE_SIZE_INVALID' });
  const redirect = createKs3BundleStore({ ...credentials, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } }) });
  await assert.rejects(redirect.download(reference), { code: 'KS3_DOWNLOAD_FAILED', status: 302 });
});

test('a public bucket policy cannot turn a verified upload into a successful private receipt', async t => {
  const { zip, reference } = await fixture(t); let deleted = false;
  const store = createKs3BundleStore({ ...credentials, fetchImpl: async (_url, init) => {
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    if (init.method === 'PUT') return new Response(null, { status: 200 });
    if (init.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    return new Response(zip);
  } });
  await assert.rejects(store.upload(zip, reference), { code: 'KS3_OBJECT_NOT_PRIVATE', cleanedUp: true });
  assert.equal(deleted, true);
});

test('cleanup verifies the exact artifact and cannot delete an object replaced after upload', async t => {
  const { zip, reference } = await fixture(t); const methods = [];
  const store = createKs3BundleStore({ ...credentials, fetchImpl: async (_url, init) => {
    methods.push(init.method); return new Response(Buffer.alloc(zip.length));
  } });
  await assert.rejects(store.remove(reference), { code: 'DEPLOYMENT_BUNDLE_MISMATCH' });
  assert.deepEqual(methods, ['GET']);
});

test('startup consumes platform credentials once; verified cache survives restart and corrupt cache stays rejected', async t => {
  const { zip, reference, root } = await fixture(t); let calls = 0;
  const env = { AGENTKIT_BUNDLE_SOURCE: JSON.stringify(reference), AGENTKIT_BUNDLE_SHA256: reference.sha256,
    KSYUN_ACCESS_KEY: credentials.accessKey, KSYUN_SECRET_KEY: credentials.secretKey, KSYUN_SESSION_TOKEN: credentials.sessionToken };
  const options = { archive: '/unused/portable.zip', cache: join(root, 'cache'), env, fetchImpl: async (_url, init) => {
    calls++; assert.equal(init.headers['x-kss-security-token'], credentials.sessionToken); return new Response(zip);
  } };
  const path = await prepareBundleArchive(options);
  assert.deepEqual(await readFile(path), zip); assert.equal((await stat(path)).mode & 0o077, 0);
  assert.equal(await prepareBundleArchive({ ...options, env: { AGENTKIT_BUNDLE_SOURCE: env.AGENTKIT_BUNDLE_SOURCE, AGENTKIT_BUNDLE_SHA256: reference.sha256 } }), path);
  assert.equal(calls, 1);
  await writeFile(path, Buffer.alloc(zip.length));
  await assert.rejects(prepareBundleArchive(options), { code: 'DEPLOYMENT_BUNDLE_MISMATCH' }); assert.equal(calls, 1);
  await rm(path); await symlink('/etc/hosts', path);
  await assert.rejects(prepareBundleArchive(options), { code: 'DEPLOYMENT_BUNDLE_MISMATCH' });
  await assert.rejects(prepareBundleArchive({ ...options, env: { ...env, AGENTKIT_BUNDLE_SHA256: '0'.repeat(64) } }), { code: 'DEPLOYMENT_BUNDLE_MISMATCH' });
  assert.equal(calls, 1);
});
