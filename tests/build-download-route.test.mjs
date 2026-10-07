import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioBuild } from '../src/studio-build.mjs';
import { buildDownloadResponse } from '../src/build-download-route.mjs';

test('browser download route serves only verified ZIPs with attachment headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-download-route-'));
  try {
    const build = createStudioBuild({ storeDir: root });
    const record = await build.build({ agentId: 'test-agent', revision: 1, spec: { prompt: 'FROZEN' } });
    const url = `http://host/api/agentkit.build.download?agentId=test-agent&buildId=${record.id}`;
    const download = await build.download('test-agent', record.id);
    const response = await buildDownloadResponse(new Request(url), build);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="${download.filename}"`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(download.base64, 'base64'));
    const head = await buildDownloadResponse(new Request(url, { method: 'HEAD' }), build);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), String(download.bytes));
    for (const query of ['', '?agentId=..&buildId=invalid', `?agentId=missing&buildId=${record.id}`]) {
      const error = await buildDownloadResponse(new Request('http://host/api/agentkit.build.download' + query), build);
      assert.ok([400, 404].includes(error.status));
      assert.ok(!(await error.text()).includes(root));
    }
    await writeFile(await build.artifactPath('test-agent', record.id), 'corrupt');
    const corrupt = await buildDownloadResponse(new Request(url), build);
    assert.equal(corrupt.status, 409);
    assert.ok(!(await corrupt.text()).includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
