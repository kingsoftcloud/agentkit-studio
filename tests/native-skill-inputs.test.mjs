import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSkillInputFiles, stageSkillInputFiles, NATIVE_SKILL_INPUT_FILES } from '../src/providers/native-skill-inputs.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const item = (source = 'source.bin', targetPath = '/workspace/inputs/data.bin') => ({ source, targetPath });
function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-input-files-'))), workspace = join(root, 'workspace'); mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, destination: join(root, 'staged') };
}
test('trusted input descriptors are cloned and collisions or noncanonical target boundaries are rejected', () => {
  assert.equal(NATIVE_SKILL_INPUT_FILES, 'agentkit.native-skill-input-files/v1');
  const inputs = [item()], snapshot = normalizeSkillInputFiles(inputs); inputs[0].targetPath = '/etc/secret';
  assert.equal(snapshot[0].targetPath, '/workspace/inputs/data.bin');
  for (const path of ['/etc/x', '/workspace/inputs', '/workspace/inputs/', '/workspace/inputs/../x', '/workspace/inputs//x',
    '/workspace/inputs/./x', '/workspace/inputs/x\\y', '/workspace/inputs/x\0y']) {
    assert.throws(() => normalizeSkillInputFiles([item('source', path)]), { code: 'SKILL_INPUT_FILE_INVALID' });
  }
  for (const inputs of [[item(), item()], [item('x', '/workspace/inputs/a'), item('x', '/workspace/inputs/a/b')],
    [item('x', '/workspace/inputs/a'), item('x', '/workspace/inputs/a-z'), item('x', '/workspace/inputs/a/b')]]) {
    assert.throws(() => normalizeSkillInputFiles(inputs), { code: 'SKILL_INPUT_TARGET_CONFLICT' });
  }
  assert.throws(() => normalizeSkillInputFiles([item(), ...Array(500).fill(item())]), { code: 'SKILL_INPUT_FILES_INVALID' });
  assert.throws(() => normalizeSkillInputFiles([{ ...item(), sha256: 'f'.repeat(63) }]), { code: 'SKILL_INPUT_FILE_INVALID' });
});
test('staging pins exact binary, empty and Unicode bytes before any remote effect', t => {
  const h = setup(t), bytes = Buffer.from([0, 255, 1, 128]); writeFileSync(join(h.workspace, 'raw.bin'), bytes);
  writeFileSync(join(h.workspace, 'empty'), ''); writeFileSync(join(h.workspace, '中文.txt'), '中文😀');
  const result = stageSkillInputFiles([{ ...item('raw.bin'), sha256: hash(bytes) }, item('empty', '/workspace/inputs/empty'),
    item('中文.txt', '/workspace/inputs/nested/中文.txt')], h.workspace, h.destination, () => true);
  assert.equal(result.length, 3); assert.equal(result[0].sha256, hash(bytes)); assert.equal(result[0].source, 'raw.bin');
  writeFileSync(join(h.workspace, 'raw.bin'), 'changed'); assert.deepEqual(readFileSync(result[0].stagedPath), bytes);
  assert.equal(readFileSync(result[1].stagedPath).length, 0); assert.equal(readFileSync(result[2].stagedPath, 'utf8'), '中文😀');
});
for (const mode of ['outside', 'symlink', 'ancestor-symlink', 'hardlink', 'digest', 'oversize']) {
  test(`unsafe ${mode} source fails before any input staging`, t => {
    const h = setup(t); writeFileSync(join(h.root, 'outside'), 'private'); writeFileSync(join(h.workspace, 'source.bin'), 'inside');
    let source = 'source.bin', sha256;
    if (mode === 'outside') source = '../outside';
    if (mode === 'symlink') { symlinkSync(join(h.root, 'outside'), join(h.workspace, 'linked')); source = 'linked'; }
    if (mode === 'ancestor-symlink') { symlinkSync(h.root, join(h.workspace, 'linked')); source = 'linked/outside'; }
    if (mode === 'hardlink') linkSync(join(h.workspace, source), join(h.root, 'linked'));
    if (mode === 'digest') sha256 = '0'.repeat(64);
    if (mode === 'oversize') writeFileSync(join(h.workspace, source), Buffer.alloc(20 * 1024 ** 2 + 1));
    assert.throws(() => stageSkillInputFiles([{ ...item(source), ...(sha256 ? { sha256 } : {}) }], h.workspace, h.destination, () => true));
    assert.equal(existsSync(h.destination), false);
  });
}
test('authority loss cannot publish a staged snapshot', t => {
  const h = setup(t); writeFileSync(join(h.workspace, 'source.bin'), 'value');
  assert.throws(() => stageSkillInputFiles([item()], h.workspace, h.destination, () => { throw Error('retired'); }), /retired/);
  assert.equal(existsSync(h.destination), false);
});
for (const mode of ['false', 'missing', 'asynchronous']) {
  test(`a ${mode} authority verdict cannot stage input bytes`, async t => {
    const h = setup(t); writeFileSync(join(h.workspace, 'source.bin'), 'value');
    const guard = () => mode === 'false' ? false : mode === 'missing' ? undefined : Promise.reject(Error('late authority'));
    assert.throws(() => stageSkillInputFiles([item()], h.workspace, h.destination, guard), { code: 'SKILL_INPUT_AUTHORITY_LOST' });
    assert.equal(existsSync(h.destination), false);
    await new Promise(resolve => setImmediate(resolve));
  });
}
