import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import asar from '@electron/asar';
import { installedStudioFingerprint } from '../scripts/installed-studio-fingerprint.mjs';

test('rollback fingerprint covers package tooling even when Runtime source is unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-package-fingerprint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), plugin = join(source, 'dsh/node_modules/@kingsoftcloud/agentkit-studio');
  await mkdir(join(plugin, 'src'), { recursive: true });
  await mkdir(join(plugin, 'scripts'), { recursive: true });
  await writeFile(join(plugin, 'src/index.mjs'), 'export const runtime = "unchanged";');
  await writeFile(join(plugin, 'scripts/publisher.mjs'), 'export const lane = "baseline";');
  const baseline = join(root, 'baseline.asar');
  await asar.createPackage(source, baseline);
  const before = installedStudioFingerprint(baseline);
  await writeFile(join(plugin, 'scripts/publisher.mjs'), 'export const lane = "candidate";');
  const candidate = join(root, 'candidate.asar');
  await asar.createPackage(source, candidate);
  const after = installedStudioFingerprint(candidate);
  assert.equal(after.studioSourceSha256, before.studioSourceSha256);
  assert.notEqual(after.studioPackageSha256, before.studioPackageSha256);
  assert.deepEqual(installedStudioFingerprint(baseline), before);
});
