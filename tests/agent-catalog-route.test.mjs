import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('an offline empty local Agent catalog keeps first creation available', async () => {
  const source = await readFile(new URL('../src/host/bootstrap.mjs', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf("      if (endpoint === 'agents/list')"), source.indexOf("      if (endpoint === 'agents/ensure-preset')"));
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const run = new AsyncFunction('endpoint', 'payload', 'serverClient', 'agentStorePromise', 'agentCatalogPromise', 'signal', branch);
  const catalog = { list: async () => ({ items: [], total: 0, warnings: [{ code: 'CLOUD_CATALOG_UNAVAILABLE' }] }) };
  const result = await run('agents/list', {}, { listAgents: async () => { throw new Error('offline'); } }, Promise.resolve({ list: async () => [] }), Promise.resolve(catalog));
  assert.equal(result.ok, true);
  assert.equal(result.value.total, 0);
  assert.equal(result.value.warnings[0].code, 'CLOUD_CATALOG_UNAVAILABLE');
});
