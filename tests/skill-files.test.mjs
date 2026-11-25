import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, readZipFiles } from '../src/zip.mjs';
import { materializeCloudSkill, runtimeSkill } from '../src/skill-files.mjs';

test('Skill archives reject traversal, duplicate files and damaged contents before extraction', () => {
  for (const name of ['../outside.py', '/tmp/outside.py', 'C:/outside.py', 'scripts/../../outside.py']) {
    assert.throws(() => readZipFiles(createZip([{ name, data: 'bad' }])), /unsafe archive path/);
  }
  assert.throws(() => readZipFiles(createZip([{ name: 'same', data: 'a' }, { name: 'same', data: 'b' }])), /unsafe archive path/);
  const damaged = createZip([{ name: 'SKILL.md', data: 'hello' }]);
  damaged[38] ^= 1;
  assert.throws(() => readZipFiles(damaged), /checksum mismatch/);
});

test('Windows-built archives are normalized to POSIX separators instead of rejected', () => {
  // PowerShell Compress-Archive and several zip CLIs record '\' as the
  // separator. The published sap-mm-procureanalyze-platform-1.0.1 archive is
  // one of them: the first separator is a literal '/' and every later one is
  // '\', so the raw entry name mixes both.
  const archive = createZip([
    { name: 'skill\\SKILL.md', data: '# Test' },
    { name: 'skill/references\\demand-inventory\\ROUTER.md', data: '# Router' },
    { name: 'skill\\scripts\\check.py', data: 'print(1)', executable: true },
    { name: 'skill\\assets\\', data: '' },
  ]);
  const files = readZipFiles(archive);
  assert.deepEqual(files.map(file => file.name), [
    'skill/SKILL.md',
    'skill/references/demand-inventory/ROUTER.md',
    'skill/scripts/check.py',
  ]);
  assert.equal(files[2].executable, true);
});

test('Normalization still rejects traversal and duplicates it exposes', () => {
  for (const name of ['..\\outside.py', '\\tmp\\outside.py', 'C:\\outside.py', 'scripts\\..\\..\\outside.py', 'scripts\\.\\outside.py']) {
    assert.throws(() => readZipFiles(createZip([{ name, data: 'bad' }])), /unsafe archive path/);
  }
  // Two spellings of the same entry must not both survive normalization.
  assert.throws(() => readZipFiles(createZip([
    { name: 'skill/SKILL.md', data: 'a' },
    { name: 'skill\\SKILL.md', data: 'b' },
  ])), /unsafe archive path/);
});

test('cached Skill script tampering is detected before reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-skill-integrity-'));
  try {
    const archive = createZip([{ name: 'SKILL.md', data: '# Test' }, { name: 'scripts/check.py', data: 'print(1)' }]);
    const [skill] = await materializeCloudSkill(archive, directory, 'test');
    await writeFile(join(skill.resourceBase.path, 'scripts/check.py'), 'print(2)');
    await assert.rejects(() => materializeCloudSkill(archive, directory, 'test'), /cache content changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('DSH runtime Skill definitions retain user-only invocation policy', () => {
  const skill = runtimeSkill({ name: 'sample', path: '/tmp/sample/SKILL.md', content: '---\nname: sample\ndescription: Test\ndisable-model-invocation: true\nuser-invocable: false\n---\nTest' });
  assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: false });
});
