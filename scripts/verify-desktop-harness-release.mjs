/** Verify a published Harness release with the packaged Studio and Electron. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const version = '0.0.27';
const [target] = process.argv.slice(2);
assert.ok(target, 'Pass a packaged macOS app or Windows executable');

if (process.versions.electron) {
  const entry = join(target, 'dsh/node_modules/@kingsoftcloud/agentkit-studio/src/host/services/star-harness-catalog.mjs');
  const { fetchStarHarnessProof, verifyStarHarnessProof } = await import(pathToFileURL(entry));
  const cachePath = await mkdtemp(join(tmpdir(), 'studio-harness-release-'));
  try {
    const proof = await fetchStarHarnessProof(version, { fetchImpl: fetch });
    const release = await verifyStarHarnessProof(version, proof, { cachePath });
    assert.equal(release.packages['@kingsoftcloud/agentkit-harness-node'].version, version);
    assert.equal(release.packages['@kingsoftcloud/agentkit-harness-ui'].version, version);
    const altered = structuredClone(proof);
    const signedEntry = altered.bundle.verificationMaterial.tlogEntries.find(entry => entry.inclusionPromise);
    const timestamp = Buffer.from(signedEntry.inclusionPromise.signedEntryTimestamp, 'base64');
    timestamp[timestamp.length - 1] ^= 1;
    signedEntry.inclusionPromise.signedEntryTimestamp = timestamp.toString('base64');
    await assert.rejects(verifyStarHarnessProof(version, altered, { cachePath, offline: true }),
      { code: 'TLOG_INCLUSION_PROMISE_ERROR' });
    await assert.rejects(verifyStarHarnessProof(version, { ...proof, manifest: Buffer.from('{}').toString('base64') },
      { cachePath, offline: true }), /differs from the attested artifact/);
    console.log(`Electron ${process.versions.electron} validated the signed Star Harness ${version} release`);
  } finally {
    await rm(cachePath, { recursive: true, force: true });
  }
} else {
  const app = resolve(target);
  const executable = process.platform === 'darwin' ? join(app, 'Contents/MacOS/AgentKit Studio') : app;
  const archive = process.platform === 'darwin' ? join(app, 'Contents/Resources/app.asar')
    : join(dirname(app), 'resources/app.asar');
  const { stdout, stderr } = await promisify(execFile)(executable, [fileURLToPath(import.meta.url), archive], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 90000,
  });
  assert.match(stdout, /validated the signed Star Harness/);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}
