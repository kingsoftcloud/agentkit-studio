import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, readZipFiles } from '../src/zip.mjs';
import { materializeCloudSkill, runtimeSkill } from '../src/skill-files.mjs';

test('Skill archives reject traversal, duplicate files and damaged contents before extraction', () => {
  for (const name of ['../outside.py', '/tmp/outside.py', 'C:/outside.py', 'scripts/../../outside.py', 'scripts\\outside.py']) {
    assert.throws(() => readZipFiles(createZip([{ name, data: 'bad' }])), /unsafe archive path/);
  }
  assert.throws(() => readZipFiles(createZip([{ name: 'same', data: 'a' }, { name: 'same', data: 'b' }])), /unsafe archive path/);
  const damaged = createZip([{ name: 'SKILL.md', data: 'hello' }]);
  damaged[38] ^= 1;
  assert.throws(() => readZipFiles(damaged), /checksum mismatch/);
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
