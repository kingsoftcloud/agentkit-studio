import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserWorkspaceServer } from '../src/host/workspace-preview-server.mjs';

function getPreview(url) {
  // Match the browser's loopback resolution for .localhost without using the worker's DNS.
  const lookup = (_hostname, _options, callback) => callback(null, '127.0.0.1', 4);
  return new Promise((resolve, reject) => {
    get(url, { family: 4, lookup }, resolve).once('error', reject);
  });
}

for (const interactivePreview of [false, true]) {
  test(`workspace preview serves only public files (interactive: ${interactivePreview})`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'studio-preview-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'index.html'), '<p>visible fixture</p>');
    await writeFile(join(root, '.private'), 'private fixture');
    await writeFile(join(root, 'node_modules', 'fixture.txt'), 'dependency fixture');
    const server = await createBrowserWorkspaceServer({ root, path: '.', interactivePreview });
    t.after(() => server.close());
    const preview = new URL(server.url);
    if (interactivePreview) assert.match(preview.hostname, /^preview-[a-f0-9]{24}\.localhost$/);
    const response = await getPreview(preview);
    const body = await response.setEncoding('utf8').toArray();
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-security-policy'], /connect-src 'self'/);
    assert.equal(body.join(''), '<p>visible fixture</p>');
    for (const path of ['.private', 'node_modules/fixture.txt']) {
      const blocked = await getPreview(new URL(path, preview));
      await blocked.toArray();
      assert.equal(blocked.statusCode, 403);
    }
  });
}
