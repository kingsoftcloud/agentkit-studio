import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDesktopModuleGraph, STUDIO_DESKTOP_ENTRIES } from '../scripts/desktop-module-graph.mjs';

test('the packaged host gate rejects a shared build chunk omitted by the npm file list', async () => {
  const root = 'dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/';
  const files = new Map([[root+'index.js', 'import { clone } from "./src-generated.js"; export const snapshot = clone;']]);
  const read = path => { if (!files.has(path)) throw new Error('not found'); return files.get(path); };
  await assert.rejects(verifyDesktopModuleGraph(read, [root+'index.js']), /Packaged desktop module is missing/);
  files.set(root+'src-generated.js', 'export const clone = value => value;');
  const result = await verifyDesktopModuleGraph(read, [root+'index.js']);
  assert.equal(result.verified, true);
  assert.equal(result.modules, 2);
});

test('the Studio archive gate follows dynamic Host composition imports', async () => {
  const entry = STUDIO_DESKTOP_ENTRIES[0];
  const host = entry.replace('src/index.mjs', 'src/host/bootstrap.mjs');
  const contract = entry.replace('src/index.mjs', 'src/contracts/definitions.mjs');
  const files = new Map([[entry, "export async function apply() { return import('./host/bootstrap.mjs'); }"],
    [host, "import { operations } from '../contracts/definitions.mjs'; export { operations };"]]);
  const read = path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); };
  await assert.rejects(verifyDesktopModuleGraph(read, [entry]), /Packaged desktop module is missing/);
  files.set(contract, 'export const operations = {};');
  const result = await verifyDesktopModuleGraph(read, [entry]);
  assert.equal(result.verified, true); assert.equal(result.modules, 3);
});

test('the Studio archive gate parses relative JSON imports and still rejects missing or invalid JSON', async () => {
  const entry = STUDIO_DESKTOP_ENTRIES[0];
  const product = entry.replace('src/index.mjs', 'src/product.json');
  const files = new Map([[entry, "import product from './product.json' with { type: 'json' }; export const name = product.brand.name;"]]);
  const read = path => { if (!files.has(path)) throw new Error('missing'); return files.get(path); };
  await assert.rejects(verifyDesktopModuleGraph(read, [entry]), /Packaged desktop module is missing/);
  files.set(product, JSON.stringify({ schemaVersion: 1, brand: { name: 'Example' } }));
  const result = await verifyDesktopModuleGraph(read, [entry]);
  assert.equal(result.verified, true); assert.equal(result.modules, 2);
  files.set(product, '{"brand": invalid}');
  await assert.rejects(verifyDesktopModuleGraph(read, [entry]));
});
