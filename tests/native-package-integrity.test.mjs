import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyNativePackageTree } from '../scripts/native-package-integrity.mjs';

function installation(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-registry-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = '@kingsoftcloud/agentkit-harness-core', version = '0.0.3';
  const installed = join(root, 'node_modules', name), pinsPath = join(root, 'scripts/native-package-pins.json');
  mkdirSync(installed, { recursive: true }); mkdirSync(join(root, 'scripts'));
  const metadata = { name, version, type: 'module', exports: './index.mjs' };
  writeFileSync(join(installed, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(installed, 'index.mjs'), 'export const generation = 3;\n');
  const files = Object.fromEntries(['package.json', 'index.mjs'].map(path =>
    [path, createHash('sha256').update(readFileSync(join(installed, path))).digest('hex')]));
  const pins = { schemaVersion: 'agentkit.native-registry-pins/v2', packages: { [name]: { version,
    integrity: 'sha512-' + createHash('sha512').update('registry-archive-fixture').digest('base64'), files } } };
  writeFileSync(pinsPath, JSON.stringify(pins));
  const product = { dependencies: { [name]: version } };
  writeFileSync(join(root, 'package.json'), JSON.stringify(product));
  return { root, name, installed, pins, pinsPath, product, metadata };
}

test('a registry release verifies offline and the same version cannot hide stale installed bytes', t => {
  const { root, name, installed } = installation(t);
  assert.equal(verifyNativePackageTree(root, [name]), 2);
  writeFileSync(join(installed, 'index.mjs'), 'export const generation = 2;\n');
  assert.throws(() => verifyNativePackageTree(root, [name]), /stale or modified/);
  rmSync(join(installed, 'index.mjs'));
  assert.throws(() => verifyNativePackageTree(root, [name]));
});

test('local archives, floating versions and mismatched installed releases cannot satisfy registry pins', t => {
  const { root, name, installed, product, metadata } = installation(t);
  for (const spec of ['file:vendor/native/old.tgz', '^0.0.3', 'latest', '0.0.2']) {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: spec } }));
    assert.throws(() => verifyNativePackageTree(root, [name]), /registry version is not pinned/);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify(product));
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ ...metadata, version: '0.0.2' }));
  assert.throws(() => verifyNativePackageTree(root, [name]), /identity mismatch/);
});

test('malformed release evidence and file paths are rejected before reading outside the package', t => {
  const { root, name, pins, pinsPath } = installation(t);
  const rewrite = value => writeFileSync(pinsPath, JSON.stringify(value));
  for (const path of ['../outside.mjs', '/absolute', 'src/../../outside', 'src\\outside']) {
    const changed = structuredClone(pins);
    changed.packages[name].files = { [path]: 'a'.repeat(64) }; rewrite(changed);
    assert.throws(() => verifyNativePackageTree(root, [name]), /Invalid package file pin/);
  }
  const changed = structuredClone(pins); changed.packages[name].integrity = 'not-release-integrity'; rewrite(changed);
  assert.throws(() => verifyNativePackageTree(root, [name]), /registry evidence is missing/);
});

for (const kind of ['extra-file', 'extra-directory', 'file-link', 'parent-link']) test(`registry verification rejects ${kind} even if pinned bytes still match`, t => {
  const { root, name, installed, pins, pinsPath } = installation(t);
  if (kind === 'extra-file') writeFileSync(join(installed, 'unreviewed.mjs'), 'export const stale = true;');
  if (kind === 'extra-directory') mkdirSync(join(installed, 'unreviewed'));
  if (kind === 'file-link') {
    const original = readFileSync(join(installed, 'index.mjs'));
    const target = join(root, 'same-bytes.mjs'); writeFileSync(target, original);
    rmSync(join(installed, 'index.mjs')); symlinkSync(target, join(installed, 'index.mjs'));
  }
  if (kind === 'parent-link') {
    const parent = join(installed, 'dist'), target = join(root, 'linked-dist');
    mkdirSync(parent); renameSync(join(installed, 'index.mjs'), join(parent, 'index.mjs'));
    pins.packages[name].files['dist/index.mjs'] = pins.packages[name].files['index.mjs'];
    delete pins.packages[name].files['index.mjs']; writeFileSync(pinsPath, JSON.stringify(pins));
    renameSync(parent, target); symlinkSync(target, parent, 'dir');
  }
  assert.throws(() => verifyNativePackageTree(root, [name]));
});
