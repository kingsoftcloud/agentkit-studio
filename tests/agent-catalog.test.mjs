import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCatalog } from '../src/agent-catalog.mjs';

const row = (id, name = id) => ({ metadata: { id, name } });

test('local tab sorts newest first before pagination and never waits for cloud', async () => {
  const old = { metadata: { id: 'old', name: 'old', createdAt: '2026-10-07T00:00:00Z' } };
  const newest = { metadata: { id: 'newest', name: 'newest', createdAt: '2026-10-08T00:00:00Z' } };
  const catalog = createAgentCatalog({ store: async () => ({ list: async () => [old, newest] }), server: async () => { throw Error('local tab must not query cloud'); } });
  const result = await catalog.list({ source: 'local', limit: 1 });
  assert.equal(result.items[0].metadata.id, 'newest');
  assert.equal(result.total, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal((await catalog.list({ source: 'local', page: 2, limit: 1 })).items[0].metadata.id, 'old');
});

test('cloud tab has independent paging and preserves cloud failures', async () => {
  const catalog = createAgentCatalog({ store: async () => { throw Error('cloud tab must not read local drafts'); }, server: async () => ({ listAgents: async query => {
    assert.equal(query.page, 2);
    assert.equal(query.pageSize, 1);
    return { items: [row('cloud')], total: 2 };
  } }) });
  assert.deepEqual((await catalog.list({ source: 'cloud', page: 2, limit: 1 })).items, [row('cloud')]);
  const offline = createAgentCatalog({ server: async () => { throw Object.assign(Error('offline'), { code: 'SERVER_UNAVAILABLE' }); } });
  await assert.rejects(offline.list({ source: 'cloud' }), { code: 'SERVER_UNAVAILABLE' });
  await assert.rejects(catalog.list({ source: 'invalid' }), { code: 'INVALID_QUERY' });
});

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
