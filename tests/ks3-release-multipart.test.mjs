import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadKs3Multipart } from '../src/ks3-release-multipart.mjs';

const partSize = 5 * 1024 * 1024;
async function fixture(t, size = 2 * partSize + 17) {
  const root = await mkdtemp(join(tmpdir(), 'studio-ks3-parts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = Buffer.alloc(size, 43);
  const path = join(root, 'package.zip');
  await writeFile(path, contents);
  return { contents, options: { url: new URL('https://ksadk.ks3-cn-beijing.ksyuncs.com/dsh-desk/bin/mac-arm64/package.zip'),
    bucket: 'ksadk', accessKey: 'ak', secretKey: 'sk', objectKey: 'dsh-desk/bin/mac-arm64/package.zip', path, size,
    contentType: 'application/zip', partSize, now: () => new Date('2026-10-13T00:00:00Z') } };
}
const response = (text, status = 200, headers = {}) => new Response(text, { status, headers });

test('multipart verifies part bytes and signatures, then completes in numeric order', async t => {
  const { contents, options } = await fixture(t);
  const parts = new Map();
  const progress = [];
  let complete;
  const result = await uploadKs3Multipart({ ...options, onProgress: event => progress.push(event), fetchImpl: async (url, init) => {
    if (url.searchParams.has('uploads')) {
      assert.equal(init.headers['x-kss-acl'], 'public-read');
      return response('<InitiateMultipartUploadResult><UploadId>id+1</UploadId></InitiateMultipartUploadResult>');
    }
    if (init.method === 'PUT') {
      const number = Number(url.searchParams.get('partNumber'));
      assert.deepEqual(init.body, contents.subarray((number - 1) * partSize, Math.min(number * partSize, contents.length)));
      const md5 = createHash('md5').update(init.body).digest('base64');
      const signed = `PUT\n${md5}\napplication/octet-stream\nTue, 13 Oct 2026 00:00:00 GMT\n/ksadk/dsh-desk/bin/mac-arm64/package.zip?partNumber=${number}&uploadId=id+1`;
      assert.equal(init.headers.Authorization, `KSS ak:${createHmac('sha1', 'sk').update(signed).digest('base64')}`);
      parts.set(number, Buffer.from(init.body));
      return response('', 200, { etag: `"part-${number}"` });
    }
    complete = init.body.toString();
    return response('<CompleteMultipartUploadResult/>'.replace('/>', '></CompleteMultipartUploadResult>'));
  } });
  assert.equal(result.parts, 3);
  assert.equal(progress.at(-1).completedBytes, contents.length);
  assert.deepEqual(Buffer.concat([1, 2, 3].map(index => parts.get(index))), contents);
  assert.match(complete, /<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>.*<PartNumber>3<\/PartNumber>/u);
  assert.equal(progress.at(-1).completedParts, 3);
});

test('transient part failure retries the same bytes without a duplicate completion', async t => {
  const { options } = await fixture(t, 19);
  let attempts = 0, completions = 0;
  await uploadKs3Multipart({ ...options, fetchImpl: async (url, init) => {
    if (url.searchParams.has('uploads')) return response('<UploadId>id</UploadId>');
    if (init.method === 'PUT') return ++attempts === 1 ? response('', 503) : response('', 200, { etag: 'part' });
    completions++;
    return response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
  } });
  assert.equal(attempts, 2);
  assert.equal(completions, 1);
});

test('fatal part failure aborts the upload and never publishes an object', async t => {
  const { options } = await fixture(t, 19);
  const methods = [];
  await assert.rejects(uploadKs3Multipart({ ...options, fetchImpl: async (url, init) => {
    methods.push(init.method);
    if (url.searchParams.has('uploads')) return response('<UploadId>id</UploadId>');
    if (init.method === 'DELETE') return response('');
    return response('', 403);
  } }), /multipart PUT failed: 403/u);
  assert.deepEqual(methods, ['POST', 'PUT', 'DELETE']);
});

test('HTTP 200 with embedded completion error is rejected and cleaned up', async t => {
  const { options } = await fixture(t, 19);
  let aborted = false;
  await assert.rejects(uploadKs3Multipart({ ...options, fetchImpl: async (url, init) => {
    if (url.searchParams.has('uploads')) return response('<UploadId>id</UploadId>');
    if (init.method === 'PUT') return response('', 200, { etag: 'part' });
    if (init.method === 'DELETE') { aborted = true; return response(''); }
    return response('<Error><Code>InvalidPart</Code></Error>');
  } }), /multipart POST failed: 200/u);
  assert.equal(aborted, true);
});
