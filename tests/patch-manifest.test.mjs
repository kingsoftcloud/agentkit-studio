import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPatchManifest, validatePatchManifest } from '../scripts/check-patch-manifest.mjs';
import { packageDesktop } from '../scripts/package-desktop.mjs';

const directory = new URL('../patches/dsh-v0.2.1-rc.2/', import.meta.url);
async function inputs() {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
  const files = new Map(await Promise.all((await readdir(directory)).filter(name => name.endsWith('.patch')).map(async name => [name, await readFile(new URL(name, directory))])));
  return { manifest, files };
}
const invalid = error => error.code === 'PATCH_MANIFEST_INVALID';

test('all shipped patches have exact content, paths, ordered dependencies and verification ownership', async () => {
  const { report } = await checkPatchManifest(fileURLToPath(directory));
  assert.equal(report.patches, 41); assert.equal(report.paths, 250); assert.ok(report.hostTests.length > 0);
});

test('unregistered patch files and modified content cannot enter a build', async () => {
  const { manifest, files } = await inputs();
  files.set('099-unreviewed.patch', Buffer.from('unreviewed'));
  assert.throws(() => validatePatchManifest(manifest, files), invalid);
  files.delete('099-unreviewed.patch'); files.set(manifest.patches[0].file, Buffer.from('changed'));
  assert.throws(() => validatePatchManifest(manifest, files), invalid);
});

test('mixed baselines and undeclared modified paths fail admission', async () => {
  const { manifest, files } = await inputs();
  assert.throws(() => validatePatchManifest(manifest, files, { baseCommit: '0'.repeat(40) }), invalid);
  manifest.patches[0].affectedFiles = ['unregistered.ts'];
  assert.throws(() => validatePatchManifest(manifest, files), invalid);
});

test('cyclic and forward dependencies are rejected before application', async () => {
  const { manifest, files } = await inputs();
  manifest.patches[0].dependsOn = [manifest.patches[1].id];
  assert.throws(() => validatePatchManifest(manifest, files), /appears later/);
  manifest.patches[1].dependsOn = [manifest.patches[0].id];
  assert.throws(() => validatePatchManifest(manifest, files), /cyclic/);
});

test('shared modified files require explicit dependency ancestry', async () => {
  const { manifest, files } = await inputs();
  manifest.patches.find(entry => entry.id === '035').dependsOn = [];
  assert.throws(() => validatePatchManifest(manifest, files), /undeclared file-order/);
});

test('host test paths cannot inject runner options or escape the checkout', async () => {
  const { manifest, files } = await inputs();
  for (const path of ['--config=other.spec.ts', '../outside.spec.ts', 'C:/outside.spec.ts', 'apps\\outside.spec.ts']) {
    manifest.patches[0].verification.hostTests = [path];
    assert.throws(() => validatePatchManifest(manifest, files), invalid);
  }
});

test('missing exit conditions and unknown verification cannot be admitted', async () => {
  const { manifest, files } = await inputs();
  manifest.patches[0].removeWhen = '';
  assert.throws(() => validatePatchManifest(manifest, files), invalid);
  manifest.patches[0].removeWhen = 'Equivalent behavior verified upstream';
  manifest.patches[0].verification.integrations = ['does-not-exist'];
  assert.throws(() => validatePatchManifest(manifest, files), /unknown verification/);
  manifest.patches[0].verification.integrations = ['toString'];
  assert.throws(() => validatePatchManifest(manifest, files), /unknown verification/);
});

test('desktop packaging refuses invalid compatibility inputs before cloning or launching tools', async t => {
  const patches = await mkdtemp(join(tmpdir(), 'studio-manifest-admission-'));
  t.after(() => rm(patches, { recursive: true, force: true }));
  await writeFile(join(patches, 'manifest.json'), '{"schemaVersion":1,"baseCommit":"wrong"}');
  await assert.rejects(packageDesktop({ patches, source: 'must-not-be-cloned', output: 'must-not-be-created', target: 'win-x64', unsigned: true, commit: '0'.repeat(40) }), invalid);
});
