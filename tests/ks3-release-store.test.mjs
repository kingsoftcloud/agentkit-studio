import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveKs3ReleaseCredentials, uploadKs3ReleaseArtifact } from '../src/ks3-release-store.mjs';

test('KS3 release credentials accept Studio aliases and derive the bucket from the public origin', () => {
  assert.deepEqual(resolveKs3ReleaseCredentials({ KS3_ACCESS_KEY: 'ak', KS3_SECRET_KEY: 'sk' },
    'https://ksadk.ks3-cn-beijing.ksyuncs.com'), { bucket: 'ksadk', accessKey: 'ak', secretKey: 'sk' });
});

test('a private Bucket requires an authenticated missing-key response before creating a public versioned artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-private-bucket-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'signed.zip'); await writeFile(path, 'signed');
  const methods = [];
  await uploadKs3ReleaseArtifact({ origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com', bucket: 'agentkit', accessKey: 'ak', secretKey: 'sk',
    objectKey: 'studio/1.0.0/AgentKit-Studio-mac-arm64.zip', path, contentType: 'application/zip',
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      if (init.method === 'GET') return new Response('', { status: 403 });
      if (init.method === 'HEAD') { assert.match(init.headers.Authorization, /^KSS ak:/); return new Response(null, { status: 404 }); }
      assert.equal(init.headers['x-kss-acl'], 'public-read'); for await (const _chunk of init.body) {} return new Response('');
    },
  });
  assert.deepEqual(methods, ['GET', 'HEAD', 'PUT']);
});

test('KS3 release upload uses KSS signing and streams the artifact once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-ks3-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'preview-mac.yml');
  const contents = Buffer.from('version: 1.0.0\n');
  await writeFile(path, contents);
  let request;
  const response = await uploadKs3ReleaseArtifact({
    origin: 'https://ksadk.ks3-cn-beijing.ksyuncs.com', bucket: 'ksadk', accessKey: 'ak', secretKey: 'sk',
    objectKey: 'dsh-desk/feeds/mac-arm64/preview-mac.yml', path, contentType: 'application/yaml',
    now: () => new Date('2026-10-13T00:00:00Z'),
    fetchImpl: async (url, init) => {
      const chunks = [];
      for await (const chunk of init.body) chunks.push(chunk);
      request = { url: String(url), init, body: Buffer.concat(chunks) };
      return { ok: true, status: 200 };
    },
  });
  assert.equal(response.bytes, contents.length);
  assert.equal(request.url, 'https://ksadk.ks3-cn-beijing.ksyuncs.com/dsh-desk/feeds/mac-arm64/preview-mac.yml');
  assert.deepEqual(request.body, contents);
  assert.equal(request.init.headers['Content-MD5'], createHash('md5').update(contents).digest('base64'));
  assert.match(request.init.headers.Authorization, /^KSS ak:[A-Za-z0-9+/=]+$/u);
  assert.equal(request.init.headers['x-kss-acl'], 'public-read');
  assert.equal(request.init.duplex, 'half');
});

for (const same of [true, false]) test(`immutable binary reconciliation ${same ? 'reuses identical bytes' : 'rejects a different object'}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-ks3-existing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'artifact.zip');
  await writeFile(path, 'signed artifact');
  const methods = [];
  const operation = uploadKs3ReleaseArtifact({
    origin: 'https://ksadk.ks3-cn-beijing.ksyuncs.com', bucket: 'ksadk', accessKey: 'ak', secretKey: 'sk',
    objectKey: 'dsh-desk/bin/mac-arm64/artifact.zip', path, contentType: 'application/zip',
    fetchImpl: async (url, init) => {
      methods.push(init.method);
      return new Response(same ? 'signed artifact' : 'wrong artifact');
    },
  });
  if (same) assert.equal((await operation).alreadyPresent, true);
  else await assert.rejects(operation, /immutable release binary already exists with different bytes/u);
  assert.deepEqual(methods, ['GET']);
});

for (const suffix of ['exe', 'exe.blockmap']) test(`versioned Windows ${suffix} uses the shared public immutable upload`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-windows-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'candidate'); await writeFile(path, 'signed Windows artifact');
  const key = `studio/0.2.0-rc.2.20261014.7/AgentKit-Studio-win-x64.${suffix}`;
  const methods = [];
  const result = await uploadKs3ReleaseArtifact({ origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com', bucket: 'agentkit', accessKey: 'ak', secretKey: 'sk',
    objectKey: key, path, contentType: 'application/octet-stream', fetchImpl: async (url, init) => {
      assert.equal(String(url), `https://agentkit.ks3-cn-beijing.ksyuncs.com/${key}`); methods.push(init.method);
      if (init.method === 'GET') return new Response('', { status: 404 });
      assert.equal(init.headers['x-kss-acl'], 'public-read'); for await (const _chunk of init.body) {} return new Response('');
    } });
  assert.equal(result.objectKey, key); assert.deepEqual(methods, ['GET', 'PUT']);
  await assert.rejects(uploadKs3ReleaseArtifact({ origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com', bucket: 'agentkit', accessKey: 'ak', secretKey: 'sk',
    objectKey: key, path, contentType: 'application/octet-stream', fetchImpl: async () => new Response('different signed artifact') }), /immutable release binary/);
});

test('Windows artifact support does not admit arbitrary version files or feeds', async () => {
  for (const objectKey of ['studio/1.0.0/windows-proof.json', 'studio/1.0.0/.env.windows', 'studio/1.0.0/other.exe', 'studio/1.0.0/AgentKit-Studio-win-x64.exe/../../secret', 'studio/feeds/win-x64/preview.yml']) {
    await assert.rejects(uploadKs3ReleaseArtifact({ origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com', bucket: 'agentkit', accessKey: 'ak', secretKey: 'sk',
      objectKey, path: '/unused', contentType: 'application/octet-stream', fetchImpl: async () => { throw Error('Must not request denied paths'); } }), /invalid KS3 release object key/);
  }
});
