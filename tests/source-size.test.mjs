import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function lineCount(path) {
  const source = await readFile(path, 'utf8');
  return source.split(/\r?\n/).length;
}

test('browser source modules stay below the 1000-line gate', async () => {
  const entry = resolve(root, 'src/client.js');
  assert.ok((await lineCount(entry)) <= 1000, 'src/client.js exceeds the source gate');
  const names = (await readdir(resolve(root, 'src/client-fragments'))).filter(name => name.endsWith('.js')).sort();
  assert.ok(names.length > 0, 'browser fragments are missing');
  for (const name of names) {
    assert.ok((await lineCount(resolve(root, 'src/client-fragments', name))) <= 1000, `${name} exceeds the source gate`);
  }
});

test('packed browser entry is generated from the fragment build', async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./client'], './dist/client.js');
  const bundle = await readFile(resolve(root, 'dist/client.js'), 'utf8');
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(bundle, /@kingsoftcloud\/agentkit-studio/);
  assert.ok(bundle.split(/\r?\n/).length <= 1000, 'packed client exceeds the artifact gate');
});
