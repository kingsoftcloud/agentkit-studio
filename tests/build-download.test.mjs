import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createBuildRoutes } from '../src/host/routes/builds.mjs';
import { readZipEntry } from '../src/zip.mjs';

test('download returns the verified frozen ZIP and rejects tampering', async () => {
  const storeDir = await mkdtemp(join(tmpdir(), 'studio-download-'));
  try {
    const build = createStudioBuild({ storeDir });
    const record = await build.build({ agentId: 'local-e2e', revision: 1, spec: { prompt: 'FROZEN' } });
    const value = await build.download('local-e2e', record.id);
    assert.equal(value.contentType, 'application/zip');
    assert.equal(value.filename, `local-e2e-${record.id}.zip`);
    const zip = Buffer.from(value.base64, 'base64');
    assert.equal(zip.length, value.bytes);
    assert.equal(JSON.parse(readZipEntry(zip, 'agent-bundle/manifest.json')).spec.prompt, 'FROZEN');
    await writeFile(await build.artifactPath('local-e2e', record.id), 'corrupt');
    await assert.rejects(build.download('local-e2e', record.id), { code: 'BUILD_ARTIFACT_INVALID' });
  } finally { await rm(storeDir, { recursive: true, force: true }); }
});

test('shipped Host dispatch exposes the build download operation', async () => {
  const expected = { filename: 'bundle.zip', base64: 'UEs=' };
  const run = createBuildRoutes({ studioBuildPromise: Promise.resolve({ build: { download: async (agentId, buildId) => {
    assert.equal(agentId, 'local-e2e'); assert.equal(buildId, 'build_abc'); return expected;
  } } }) });
  const result = await run('builds/download', { agentId: 'local-e2e', buildId: 'build_abc' });
  assert.deepEqual(result, { ok: true, value: expected });
});
