import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRoutes } from '../src/host/routes/agents.mjs';

test('an offline empty local Agent catalog keeps first creation available', async () => {
  const catalog = { list: async () => ({ items: [], total: 0, warnings: [{ code: 'CLOUD_CATALOG_UNAVAILABLE' }] }) };
  const run = createAgentRoutes({ agentCatalogPromise: Promise.resolve(catalog) });
  const result = await run('agents/list', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.total, 0);
  assert.equal(result.value.warnings[0].code, 'CLOUD_CATALOG_UNAVAILABLE');
});
