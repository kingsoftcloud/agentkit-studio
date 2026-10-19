import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { publishWindowsCandidate } from '../scripts/publish-windows-candidate.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'windows-publication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.2.1-rc.2.20261019.5', name = `deepseek-harness-${version}-win-x64.exe`;
  const bytes = Buffer.from('original signed installer bytes'), sha512 = createHash('sha512').update(bytes).digest('base64');
  const receipt = { version, installer: name, installerSha256: createHash('sha256').update(bytes).digest('hex'),
    installerSigned: true, timestamped: true, installed: true, appSigned: true, uiVerified: true };
  const proof = join(root, 'windows-install.json');
  await writeFile(join(root, name), bytes); await writeFile(join(root, name + '.blockmap'), 'signed blockmap');
  await writeFile(join(root, 'preview.yml'), YAML.stringify({ version, path: name, sha512, files: [{ url: name, size: bytes.length, sha512 }] }));
  await writeFile(proof, JSON.stringify(receipt));
  const objects = new Map(), uploads = [], reads = [];
  const fetchImpl = async (url, init) => {
    const key = url.pathname.slice(1); reads.push({ key, method: init.method || 'GET' });
    const body = objects.get(key); if (!body) return new Response(null, { status: 404 });
    if (init.method === 'HEAD') return new Response(null, { headers: { 'content-length': body.length } });
    if (init.headers?.Range) return new Response(body.subarray(0, 1), { status: 206,
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes 0-0/${body.length}` } });
    return new Response(body);
  };
  const upload = async ({ objectKey, path, bucket }) => {
    assert.equal(bucket, 'agentkit', 'the publication origin owns the signed KS3 bucket');
    uploads.push(objectKey); objects.set(objectKey, await readFile(path));
  };
  const options = { candidate: root, proof, version, source: 'a'.repeat(40), previous: 'absent', origin: 'https://agentkit.ks3-cn-beijing.ksyuncs.com',
    environment: { STUDIO_DOWNLOAD_PROD_KS3_BUCKET: 'different-bucket', STUDIO_DOWNLOAD_PROD_KS3_ACCESS_KEY: 'synthetic-access-key', STUDIO_DOWNLOAD_PROD_KS3_SECRET_KEY: 'synthetic-secret' }, fetchImpl, upload };
  return { root, proof, receipt, objects, uploads, reads, options, upload, name };
}

test('Windows publication verifies original bytes and ranges before advancing both feeds', async t => {
  const f = await fixture(t), result = await publishWindowsCandidate(f.options);
  assert.equal(result.installedUiVerified, true);
  assert.deepEqual(f.uploads.slice(-2), ['studio/feeds/win-x64/preview.yml', 'dsh-desk/feeds/win-x64/preview.yml']);
  assert.ok(f.reads.some(row => row.method === 'HEAD' && row.key.endsWith('.exe')));
  for (const key of f.uploads.slice(-2)) {
    const feed = YAML.parse(f.objects.get(key).toString());
    assert.equal(feed.files[0].url, `https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/${f.options.version}/AgentKit-Studio-win-x64.exe`);
  }
});

test('Windows publication rejects unsigned, uninstalled or UI-unverified candidates before uploading', async t => {
  const f = await fixture(t);
  for (const key of ['installerSigned', 'timestamped', 'installed', 'appSigned', 'uiVerified']) {
    await writeFile(f.proof, JSON.stringify({ ...f.receipt, [key]: false }));
    await assert.rejects(publishWindowsCandidate(f.options), /acceptance is incomplete/);
  }
  assert.equal(f.uploads.length, 0);
});

test('tampered installer bytes cannot be promoted', async t => {
  const f = await fixture(t); await writeFile(join(f.root, f.name), 'changed installer');
  await assert.rejects(publishWindowsCandidate(f.options), /digest differs/);
  assert.equal(f.uploads.length, 0);
});

test('changed previous feed blocks promotion without altering public objects', async t => {
  const f = await fixture(t); f.objects.set('studio/feeds/win-x64/preview.yml', Buffer.from('version: unexpected\n'));
  await assert.rejects(publishWindowsCandidate(f.options), /Previous feed changed/);
  assert.equal(f.uploads.length, 0);
});

test('public binary corruption cannot advance the canonical or compatibility feed', async t => {
  const f = await fixture(t);
  await assert.rejects(publishWindowsCandidate({ ...f.options, upload: async input => {
    await f.upload(input);
    if (input.objectKey.endsWith('.exe')) { const body = Buffer.from(f.objects.get(input.objectKey)); body[0] ^= 1; f.objects.set(input.objectKey, body); }
  } }), /Public release bytes differ/);
  assert.equal(f.uploads.some(key => key.endsWith('.yml')), false);
});
