import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createZip } from '../src/zip.mjs';
import { readGithubSkillArchive } from '../src/skill-github-archive.mjs';

const archive = entries => createZip(entries.map(([name, data = 'text']) => ({ name, data })));
const endOf = bytes => bytes.length - 22;
const centralOf = bytes => bytes.readUInt32LE(endOf(bytes) + 16);
const zip64Reference = JSON.parse(readFileSync(new URL('./fixtures/skill-zip64-reference.json', import.meta.url), 'utf8'));
for (const fixture of zip64Reference.cases) test(`Python ZIP64 reference: ${fixture.name}`, () => {
  assert.equal(zip64Reference.contract, 'agentkit.python-zip64-reference/v1');
  const actual = readGithubSkillArchive(Buffer.from(fixture.archiveBase64, 'base64'));
  assert.deepEqual(actual.map(file => ({ path: file.path, base64: Buffer.from(file.bytes).toString('base64') })), fixture.expected);
});

test('ZIP64 malformed metadata and unbounded integers fail before expansion', () => {
  const original = Buffer.from(zip64Reference.cases.find(row => row.name === 'classic-end-sentinels').archiveBase64, 'base64');
  const end = endOf(original), locator = end - 20, record = Number(original.readBigUInt64LE(locator + 8));
  const central = Number(original.readBigUInt64LE(record + 48));
  for (const mutate of [bytes => bytes.writeUInt32LE(1, locator + 4), bytes => bytes.writeUInt32LE(2, locator + 16),
    bytes => bytes.writeUInt32LE(0, record), bytes => bytes.writeBigUInt64LE(43n, record + 4),
    bytes => bytes.writeBigUInt64LE(3n, record + 24), bytes => bytes.writeBigUInt64LE(1n, record + 48),
    bytes => bytes.writeUInt16LE(0xffff, central + 34),
    bytes => bytes.writeUInt16LE(8, 30 + bytes.readUInt16LE(26) + 2),
    bytes => bytes.writeBigUInt64LE(1n, 30 + bytes.readUInt16LE(26) + 4)]) {
    const bytes = Buffer.from(original); mutate(bytes);
    assert.throws(() => readGithubSkillArchive(bytes), { code: 'skill_github_archive_invalid' });
  }
  const unsafe = Buffer.from(original); unsafe.writeBigUInt64LE(2n ** 63n, record + 48);
  assert.throws(() => readGithubSkillArchive(unsafe), { code: 'skill_github_archive_limit' });
});
function deflated(name, data) {
  const original = archive([[name, data]]), start = 30 + original.readUInt16LE(26), central = centralOf(original);
  const packed = deflateRawSync(data), local = Buffer.from(original.subarray(0, start));
  local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18);
  const directory = Buffer.from(original.subarray(central, endOf(original)));
  directory.writeUInt16LE(8, 10); directory.writeUInt32LE(packed.length, 20);
  const end = Buffer.from(original.subarray(endOf(original))); end.writeUInt32LE(start + packed.length, 16);
  return Buffer.concat([local, packed, directory, end]);
}

test('single archive root is removed; Unicode/binary bytes survive and excluded paths are not candidates', () => {
  const bytes = Buffer.from([0, 255, 128, 1]), zip = archive([['repo-sha/SKILL.md', 'manifest'],
    ['repo-sha/中文/.data', bytes], ['repo-sha/node_modules/ignored', 'dependency'], ['repo-sha/dist/SKILL.md', 'excluded']]);
  const files = readGithubSkillArchive(zip);
  assert.deepEqual(files.map(file => file.path), ['SKILL.md', '中文/.data']);
  assert.ok(files[1].bytes instanceof Uint8Array); assert.equal(Buffer.isBuffer(files[1].bytes), false);
  assert.deepEqual(Buffer.from(files[1].bytes), bytes);
});

test('deflated content and CP437 names follow ZIP semantics', () => {
  const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
  assert.deepEqual(Buffer.from(readGithubSkillArchive(deflated('root/asset.bin', data))[0].bytes), data);
  const zip = archive([['root/a.txt', 'data']]), central = centralOf(zip);
  zip.writeUInt16LE(0, 6); zip.writeUInt16LE(0, central + 8);
  zip[30 + 5] = 0x82; zip[central + 46 + 5] = 0x82;
  assert.equal(readGithubSkillArchive(zip)[0].path, 'é.txt');
});

test('directory entries do not consume the 5000 regular-file allowance', () => {
  const entries = Array.from({ length: 65534 }, (_, i) => [`root/dir-${i}/`, '']);
  entries.push(['root/SKILL.md', 'manifest']);
  assert.equal(readGithubSkillArchive(archive(entries)).length, 1);
  assert.throws(() => readGithubSkillArchive(archive(Array.from({ length: 5001 }, (_, i) => [`root/file-${i}`, '']))),
    { code: 'skill_github_archive_limit' });
});

test('streamed deflate archives use central sizes and still verify original CRC and bytes', () => {
  const data = Buffer.from('GitHub streamed archive bytes 😀');
  for (const signature of [false, true]) {
    const zip = deflated('root/SKILL.md', data), central = centralOf(zip);
    const local = Buffer.from(zip.subarray(0, central)), directory = Buffer.from(zip.subarray(central, endOf(zip)));
    const descriptor = Buffer.alloc(signature ? 16 : 12), base = signature ? 4 : 0;
    if (signature) descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(directory.readUInt32LE(16), base);
    descriptor.writeUInt32LE(directory.readUInt32LE(20), base + 4);
    descriptor.writeUInt32LE(directory.readUInt32LE(24), base + 8);
    local.writeUInt16LE(local.readUInt16LE(6) | 8, 6); local.fill(0, 14, 26);
    directory.writeUInt16LE(directory.readUInt16LE(8) | 8, 8);
    const end = Buffer.from(zip.subarray(endOf(zip))); end.writeUInt32LE(central + descriptor.length, 16);
    const streamed = Buffer.concat([local, descriptor, directory, end]);
    assert.deepEqual(Buffer.from(readGithubSkillArchive(streamed)[0].bytes), data);
    streamed.writeUInt32LE((directory.readUInt32LE(16) ^ 1) >>> 0, central + descriptor.length + 16);
    assert.throws(() => readGithubSkillArchive(streamed), { code: 'skill_github_archive_invalid' });
  }
});

test('whole repository size includes excluded files before filtering or expansion', () => {
  const zip = archive([['root/SKILL.md', 'manifest'], ['root/node_modules/ignored', 'text']]);
  let central = centralOf(zip); central += 46 + zip.readUInt16LE(central + 28);
  zip.writeUInt32LE(200 * 1024 * 1024 + 1, central + 24);
  const offset = zip.readUInt32LE(central + 42); zip.writeUInt32LE(200 * 1024 * 1024 + 1, offset + 22);
  assert.throws(() => readGithubSkillArchive(zip), { code: 'skill_github_archive_limit' });
});

test('dangerous paths, conflicting paths, duplicate files and multiple roots reject the whole archive', () => {
  const cases = [['/root/bad'], ['root/../escape'], ['root/a:b'], ['root\\bad'], ['root/./bad'], ['root//bad'], ['root/\0bad'],
    ['root/a', 'root/a'], ['root/a', 'root/a/b'], ['root/file', 'other/file'], ['SKILL.md']];
  for (const names of cases) assert.throws(() => readGithubSkillArchive(archive(names.map(name => [name, 'data']))),
    { code: 'skill_github_archive_unsafe' }, names.join(','));
});

test('excluded-directory symlink, excessive compression, encryption and CRC errors fail closed', () => {
  const symlink = archive([['root/node_modules/link', 'target']]);
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, centralOf(symlink) + 38);
  assert.throws(() => readGithubSkillArchive(symlink), { code: 'skill_github_archive_unsafe' });
  assert.throws(() => readGithubSkillArchive(deflated('root/bomb', Buffer.alloc(2 * 1024 * 1024))),
    { code: 'skill_github_archive_unsafe' });
  const encrypted = archive([['root/file', 'data']]); encrypted.writeUInt16LE(0x0801, centralOf(encrypted) + 8);
  assert.throws(() => readGithubSkillArchive(encrypted), { code: 'skill_github_archive_invalid' });
  const bad = archive([['root/file', 'data']]); bad[30 + bad.readUInt16LE(26)] ^= 1;
  assert.throws(() => readGithubSkillArchive(bad), { code: 'skill_github_archive_invalid' });
});

test('local/central disagreement, overlapping records and malformed directories cannot become files', () => {
  const variants = [zip => zip.writeUInt32LE(0xffffffff, endOf(zip) + 16),
    zip => zip.writeUInt16LE(8, 8), zip => { zip[30] ^= 1; },
    zip => zip.writeUInt16LE(1, endOf(zip) + 4), zip => zip.writeUInt32LE(999, centralOf(zip) + 42)];
  for (const mutate of variants) {
    const zip = archive([['root/file', 'data']]); mutate(zip);
    assert.throws(() => readGithubSkillArchive(zip), { code: 'skill_github_archive_invalid' });
  }
  assert.throws(() => readGithubSkillArchive(Buffer.from('not a zip')), { code: 'skill_github_archive_invalid' });
});

test('authority is rechecked throughout validation and no prefix result escapes a failed check', () => {
  const zip = archive([['root/a', 'one'], ['root/b', 'two']]); let calls = 0;
  assert.throws(() => readGithubSkillArchive(zip, { assertCurrent() { if (++calls === 4) throw Error('retired'); } }), /retired/);
});
