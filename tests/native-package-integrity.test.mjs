import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyNativePackageTree } from '../scripts/native-package-integrity.mjs';

test('the same package version cannot conceal stale installed bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'native-package-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = '@kingsoftcloud/agentkit-harness-core', source = join(root, 'source/package'), installed = join(root, 'node_modules', name);
  mkdirSync(source, { recursive: true }); mkdirSync(join(root, 'vendor/native'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version: '0.0.1', type: 'module', exports: './index.mjs' }));
  writeFileSync(join(source, 'index.mjs'), 'export const generation = 2;\n'); cpSync(source, installed, { recursive: true });
  const temporary = join(root, 'vendor/native/package.tgz');
  execFileSync('tar', ['-czf', temporary, '-C', join(root, 'source'), 'package']);
  const identity = createHash('sha256').update(readFileSync(temporary)).digest('hex').slice(0, 16);
  const archive = `vendor/native/package-${identity}.tgz`; renameSync(temporary, join(root, archive));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: `file:${archive}` } }));
  assert.equal(verifyNativePackageTree(root, [name]), 2);
  writeFileSync(join(installed, 'index.mjs'), 'export const generation = 1;\n');
  assert.throws(() => verifyNativePackageTree(root, [name]), /stale or modified/);
  writeFileSync(join(root, archive), 'not the pinned archive');
  assert.throws(() => verifyNativePackageTree(root, [name]), /identity mismatch/);
});
