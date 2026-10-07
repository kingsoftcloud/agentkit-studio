import test from 'node:test';
import assert from 'node:assert/strict';
import { listStudioResources, paginateResources } from '../src/resource-catalog.mjs';

test('gateway model catalog supports all pages and case insensitive search', async () => {
  const models = { catalog: async () => ({ items: Array.from({ length: 64 }, (_, index) => ({ id: `model-${index}`, name: index === 63 ? 'GLM Flash' : `Model ${index}` })) }) };
  let cursor = null, ids = [];
  do {
    const result = await listStudioResources({ models, query: { kind: 'model', limit: 10, cursor } });
    assert.ok(result.items.length <= 10);
    assert.equal(result.total, 64);
    assert.equal(result.items[0].contract.model, result.items[0].resourceId);
    ids.push(...result.items.map(item => item.resourceId));
    cursor = result.nextCursor;
  } while (cursor);
  assert.equal(new Set(ids).size, 64);
  assert.deepEqual((await listStudioResources({ models, query: { kind: 'model', query: 'gLm' } })).items.map(item => item.resourceId), ['model-63']);
});

test('merged MCP pages include later cloud pages and local entries without duplicates', async () => {
  const pages = [];
  const cloud = Array.from({ length: 121 }, (_, id) => ({ resourceId: `cloud-${id}` }));
  const localMcpStore = { list: async ({ limit }) => { assert.equal(limit, Infinity); return [{ resourceId: 'local-one' }, cloud[0]]; } };
  const serverClient = { listResource: async (kind, { Page, PageSize }) => { assert.equal(kind, 'mcp'); pages.push(Page); return { items: cloud.slice((Page - 1) * PageSize, Page * PageSize), total: cloud.length }; } };
  const first = await listStudioResources({ query: { kind: 'mcp', limit: 10 }, localMcpStore, serverClient });
  const next = await listStudioResources({ query: { kind: 'mcp', limit: 10, cursor: first.nextCursor }, localMcpStore, serverClient });
  assert.equal(first.total, 122);
  assert.deepEqual(pages, [1, 2, 1, 2]);
  assert.equal(first.items[0].resourceId, 'local-one');
  assert.ok(next.items.every(item => !first.items.some(previous => previous.resourceId === item.resourceId)));
});

test('cloud failure preserves usable local Skills with explicit degraded status', async () => {
  const result = await listStudioResources({ query: { kind: 'skill' }, skillDiscovery: { listInstalled: async () => ({ items: [{ resourceId: 'local-skill' }] }) }, serverClient: { listResource: async () => { throw new Error('cloud unavailable'); } } });
  assert.equal(result.items.length, 1);
  assert.equal(result.warnings[0].code, 'CLOUD_CATALOG_UNAVAILABLE');
});

test('a paging cursor cannot silently continue a different resource query', () => {
  const cursor = paginateResources([{ id: 'one' }, { id: 'two' }], { kind: 'model', limit: 1 }).nextCursor;
  assert.throws(() => paginateResources([], { kind: 'mcp', cursor }), { code: 'INVALID_RESOURCE_CURSOR' });
  assert.throws(() => paginateResources([], { kind: 'model', query: 'changed', cursor }), { code: 'INVALID_RESOURCE_CURSOR' });
});
