import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bootstrap = await readFile(new URL('../src/host/bootstrap.mjs', import.meta.url), 'utf8');

test('Host initializes portable bundle services before registering consumers', () => {
  const portable = bootstrap.indexOf('const portableBundles = createPortableBundles(');
  const download = bootstrap.indexOf('await registerBuildDownload(ctx, { studioBuildPromise');
  const adapter = bootstrap.indexOf('const dshRuntimeAdapter = createDshRuntimeAdapter(');
  assert.ok(portable >= 0, 'portable bundle service must be created by Host bootstrap');
  assert.ok(download > portable, 'download routes must be registered after portable bundles exist');
  assert.ok(adapter > portable, 'DSH adapters must be registered after portable bundles exist');
});
