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
