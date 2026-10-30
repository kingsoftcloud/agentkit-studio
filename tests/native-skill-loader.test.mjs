import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createZip } from '../src/zip.mjs';
import { materializeCloudSkill } from '../src/skill-files.mjs';
import { createNativeSkillLoader } from '../src/providers/native-skill-loader.mjs';

const instructions = '---\nname: alpha\ndescription: Alpha task\n---\n# Alpha\nUse the supplied script.';
const bytes = () => createZip([{ name: 'SKILL.md', data: instructions }, { name: 'scripts/run.mjs', data: 'console.log(42)' }]);
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-skill-loader-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const archive = options.archive ?? bytes(), calls = [];
  const serviceClient = { downloadSkillArchive: async (skill, { signal, assertCurrent }) => {
    assert.equal(assertCurrent(), true); signal.throwIfAborted(); calls.push({ kind: 'service', skill });
    return { url: 'https://archive.example/alpha.zip?signature=private' };
  } };
  const fetchImpl = async (url, init) => {
    calls.push({ kind: 'fetch', url, init });
    return new Response(archive, { headers: { 'content-length': String(archive.length) } });
  };
  const cacheDir = join(root, 'cache');
  const loader = createNativeSkillLoader({ cacheDir, serviceClient, fetchImpl, ...options });
  const request = () => ({ skillId: 'skill-alpha', versionId: 'version-3', name: 'alpha', spaceId: 'bound-space',
    contentHash: sha(archive), signal: new AbortController().signal, assertCurrent: () => true });
  return { root, cacheDir, archive, loader, request, calls };
}

test('an exact Skill version is downloaded, verified and materialized by the Node loader', async t => {
  const f = await setup(t), output = await f.loader(f.request());
  assert.equal(output.skillId, 'skill-alpha'); assert.equal(output.versionId, 'version-3');
  assert.equal(output.content, instructions); assert.equal(output.archiveHash, sha(f.archive));
  assert.equal(await readFile(join(output.rootDir, 'scripts/run.mjs'), 'utf8'), 'console.log(42)');
  assert.equal(f.calls[0].skill.versionId, 'version-3');
  assert.equal(f.calls[1].init.redirect, 'error'); assert.equal(f.calls[1].init.credentials, 'omit');
  assert.equal(f.calls[1].init.headers, undefined);
  assert.equal(output.cacheHit, false);
});

test('incorrect archive hashes are rejected before writing any cache file', async t => {
  const f = await setup(t), request = f.request(); request.contentHash = '0'.repeat(64);
  await assert.rejects(f.loader(request), { code: 'SKILL_ARCHIVE_HASH_MISMATCH' });
  await assert.rejects(readdir(f.cacheDir), { code: 'ENOENT' });
});

test('download failures do not expose temporary URL signatures in tool errors', async t => {
  const f = await setup(t, { fetchImpl: async url => { throw new Error('network failure for ' + url); } });
  await assert.rejects(f.loader(f.request()), error => error.code === 'SKILL_DOWNLOAD_FAILED'
    && !error.message.includes('signature') && !error.message.includes('archive.example'));
});

test('display names outside the DSH slug alphabet retain exact Skill identity', async t => {
  const archive = createZip([{ name: 'SKILL.md', data: '---\nname: 营销写作\n---\n保持短句。' }]);
  const f = await setup(t, { archive }), request = f.request(); request.name = '营销写作';
  const result = await f.loader(request);
  assert.equal(result.name, '营销写作'); assert.match(result.content, /保持短句/);
  assert.match(result.definition.name, /^bound-skill-/);
});

test('streaming byte limits stop an archive with no content-length header', async t => {
  let cancelled = false;
  const f = await setup(t, { maxArchiveBytes: 32, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(33)); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(f.loader(f.request()), { code: 'SKILL_ARCHIVE_TOO_LARGE' });
  assert.equal(cancelled, true); await assert.rejects(readdir(f.cacheDir), { code: 'ENOENT' });
});

test('an expired authority during download cancels the stream and cannot publish a package', async t => {
  let live = true, cancelled = false;
  const f = await setup(t, { fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1)); live = false; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 })) });
  const request = f.request(); request.assertCurrent = () => live;
  await assert.rejects(f.loader(request), { code: 'SKILL_LOAD_AUTHORITY_CHANGED' });
  assert.equal(cancelled, true); await assert.rejects(readdir(f.cacheDir), { code: 'ENOENT' });
});

test('a service wait cannot replace the selected resource or its original signal', async t => {
  const f = await setup(t); let fetches = 0;
  for (const key of ['versionId', 'signal']) {
    const request = f.request();
    const loader = createNativeSkillLoader({ cacheDir: f.cacheDir, fetchImpl: async () => { fetches++; },
      serviceClient: { downloadSkillArchive: async () => {
        request[key] = key === 'signal' ? new AbortController().signal : 'substituted-version';
        return { url: 'https://archive.example/package.zip' };
      } } });
    await assert.rejects(loader(request), { code: 'SKILL_LOAD_IDENTITY_CHANGED' });
  }
  assert.equal(fetches, 0);
});

test('unusable archive URLs never enter the fetch boundary', async t => {
  const f = await setup(t); let fetches = 0;
  for (const url of ['http://archive.example/a.zip', ['https://user:', 'pass@archive.example/a.zip'].join(''), 'https://archive.example/a.zip#fragment', 'not a URL']) {
    const loader = createNativeSkillLoader({ cacheDir: f.cacheDir,
      serviceClient: { downloadSkillArchive: async () => ({ url }) }, fetchImpl: async () => { fetches++; } });
    await assert.rejects(loader(f.request()), { code: 'SKILL_DOWNLOAD_URL_INVALID' });
  }
  assert.equal(fetches, 0);
});

test('a returned manifest must uniquely match the selected model-invocable Skill', async t => {
  const samples = [
    [createZip([{ name: 'SKILL.md', data: '---\nname: beta\n---\nWrong skill' }]), 'SKILL_MANIFEST_IDENTITY_MISMATCH'],
    [createZip([{ name: 'one/SKILL.md', data: instructions }, { name: 'two/SKILL.md', data: instructions }]), 'SKILL_MANIFEST_AMBIGUOUS'],
    [createZip([{ name: 'SKILL.md', data: '---\nname: alpha\ndisable-model-invocation: true\n---\nUser only' }]), 'SKILL_MODEL_INVOCATION_DISABLED'],
  ];
  for (const [archive, code] of samples) {
    const f = await setup(t, { archive }); await assert.rejects(f.loader(f.request()), { code });
  }
});

test('stored cache contents are fully reverified, including additional injected scripts', async t => {
  const f = await setup(t), output = await f.loader(f.request());
  await writeFile(join(output.rootDir, 'scripts/injected.mjs'), 'malicious()');
  await assert.rejects(f.loader(f.request()), /cache content changed/);
  await rm(join(output.rootDir, 'scripts/injected.mjs'));
  await writeFile(join(output.rootDir, 'scripts/run.mjs'), 'tampered');
  await assert.rejects(f.loader(f.request()), /cache content changed/);
});

test('a symlinked directory inside a cached package cannot borrow external identical bytes', async t => {
  const f = await setup(t), output = await f.loader(f.request());
  const scripts = join(output.rootDir, 'scripts'), outside = join(f.root, 'outside');
  await rename(scripts, outside); await symlink(outside, scripts);
  await assert.rejects(f.loader(f.request()), /cache content changed/);
  assert.equal(await readFile(join(outside, 'run.mjs'), 'utf8'), 'console.log(42)');
});

test('concurrent same-digest materializers verify the actual published winner', async t => {
  const f = await setup(t);
  const values = await Promise.all(Array.from({ length: 4 }, () => materializeCloudSkill(f.archive, f.cacheDir, 'alpha')));
  assert.equal(new Set(values.map(v => v[0].path)).size, 1);
  assert.equal(await readFile(values[0][0].path, 'utf8'), instructions);
  assert.equal((await readdir(f.cacheDir)).filter(name => name.startsWith('.prepare-')).length, 0);
});

test('a revoked materializer cannot continue publishing its staging package', async t => {
  const f = await setup(t); let checks = 0;
  await assert.rejects(materializeCloudSkill(f.archive, f.cacheDir, 'alpha', { assertCurrent: () => ++checks < 8 }),
    { code: 'SKILL_LOAD_AUTHORITY_CHANGED' });
  const names = await readdir(f.cacheDir);
  assert.equal(names.some(name => name === sha(f.archive) || name.startsWith('.prepare-')), false);
});

function deflatedManifest() {
  const stored = createZip([{ name: 'SKILL.md', data: instructions }]);
  const end = stored.length - 22, start = 30 + stored.readUInt16LE(26), centralOffset = stored.readUInt32LE(end + 16);
  const compressed = deflateRawSync(Buffer.from(instructions));
  const local = Buffer.from(stored.subarray(0, start)), central = Buffer.from(stored.subarray(centralOffset, end));
  local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20);
  const trailer = Buffer.from(stored.subarray(end)); trailer.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, trailer]);
}

test('a standard DEFLATE ZIP loads without Python or a CommonJS require shim', async t => {
  const f = await setup(t, { archive: deflatedManifest() });
  const output = await f.loader(f.request());
  assert.equal(output.content, instructions); assert.equal(await readFile(join(output.rootDir, 'SKILL.md'), 'utf8'), instructions);
});

test('unsafe archive entries and corrupt data cannot escape to the filesystem', async t => {
  for (const archive of [createZip([{ name: '../outside', data: 'bad' }, { name: 'SKILL.md', data: instructions }]),
    (() => { const buffer = bytes(); buffer[40] ^= 1; return buffer; })()]) {
    const f = await setup(t, { archive }); await assert.rejects(f.loader(f.request()), /unsafe archive path|checksum mismatch/);
    await assert.rejects(readdir(f.cacheDir), { code: 'ENOENT' });
  }
});
