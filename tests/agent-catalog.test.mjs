import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCatalog } from '../src/agent-catalog.mjs';

const row = (id, name = id) => ({ metadata: { id, name } });

test('local Agents remain searchable and pageable while cloud is offline, including first use', async () => {
  const catalog = createAgentCatalog({ store: async () => ({ list: async () => [row('local-a', 'Alpha'), row('local-b', 'Beta')] }), server: async () => ({ listAgents: async () => { throw new Error('offline'); } }) });
  const result = await catalog.list({ page: 2, limit: 1 });
  assert.deepEqual(result.items, [row('local-b', 'Beta')]);
  assert.equal(result.total, 2); assert.equal(result.cloudConnected, false);
  assert.equal((await catalog.list({ query: 'alpha' })).total, 1);
});

test('combined Agent pagination crosses local/cloud boundaries without repeated local rows', async () => {
  const cloud = Array.from({ length: 23 }, (_, id) => row(`cloud-${id}`));
  const local = [row('local-a'), row('local-b'), row('local-c')];
  const catalog = createAgentCatalog({ store: async () => ({ list: async () => local }), server: async () => ({ listAgents: async ({ page, pageSize }) => ({ items: cloud.slice((page - 1) * pageSize, page * pageSize), total: cloud.length }) }) });
  const rows = [];
  for (let page = 1; page <= 3; page += 1) {
    const result = await catalog.list({ page, limit: 10 });
    assert.equal(result.total, 26); assert.ok(result.items.length <= 10); assert.equal(result.cloudConnected, true);
    rows.push(...result.items);
  }
  assert.deepEqual(rows, [...local, ...cloud]);
  assert.equal(new Set(rows.map(item => item.metadata.id)).size, 26);
});

test('catalog includes real local build history for the displayed Agent', async () => {
  const built = { id: 'build-a', revision: 1, status: 'SUCCEEDED' };
  const catalog = createAgentCatalog({ store: async () => ({ list: async () => [row('local-a')] }), server: async () => ({ listAgents: async () => ({ items: [], total: 0 }) }), builds: async id => {
    assert.equal(id, 'local-a'); return [built];
  } });
  assert.deepEqual((await catalog.list()).items[0].builds, [built]);
});
