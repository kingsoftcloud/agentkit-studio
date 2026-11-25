import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserWorkspaceServer } from '../src/host/workspace-preview-server.mjs';

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
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal(await response.text(), '<p>visible fixture</p>');
    for (const path of ['.private', 'node_modules/fixture.txt']) {
      const blocked = await fetch(new URL(path, server.url));
      assert.equal(blocked.status, 403);
      await blocked.text();
    }
  });
}
