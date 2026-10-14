import test from 'node:test';
import assert from 'node:assert/strict';
import { listStudioResources, listStudioRuntimeResources, paginateResources } from '../src/resource-catalog.mjs';

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

test('runtime overview uses typed catalogs and preserves local entries on a platform failure', async () => {
  const calls = [];
  const value = await listStudioRuntimeResources({
    models: { catalog: async () => ({ items: [{ id: 'model-one' }] }) },
    localMcpStore: { list: async () => [{ resourceId: 'mcp-local-one' }] },
    skillDiscovery: { listInstalled: async () => ({ items: [{ resourceId: 'skill-local-one' }] }) },
    serverClient: { listResource: async kind => {
      calls.push(kind);
      if (kind === 'memory-instance') throw Object.assign(new Error('Memory permission denied'), { code: 'SERVER_ACTION_FAILED' });
      return { items: [{ id: kind + '-cloud', resourceId: kind + '-cloud' }], total: 1 };
    } },
  });
  assert.deepEqual(calls.sort(), ['knowledge-base', 'mcp', 'memory-instance', 'skill-space']);
  assert.equal(value.items.length, 6);
  assert.ok(value.items.some(item => item.resourceId === 'knowledge-base-cloud' && item.kind === 'knowledge-base'));
  assert.ok(value.items.some(item => item.resourceId === 'mcp-local-one'));
  assert.deepEqual(value.warnings, [{ kind: 'memory-instance', code: 'SERVER_ACTION_FAILED', message: 'Memory permission denied' }]);
  assert.equal(value.counts.find(item => item.kind === 'memory-instance').total, null);
});

test('runtime overview explicitly reports truncated categories rather than claiming all resources are loaded', async () => {
  const value = await listStudioRuntimeResources({ models: { catalog: async () => ({ items: Array.from({ length: 201 }, (_, index) => ({ id: `model-${index}` })) }) }, localMcpStore: { list: async () => [] }, skillDiscovery: { listInstalled: async () => ({ items: [] }) }, serverClient: { listResource: async () => ({ items: [], total: 0 }) } });
  assert.equal(value.items.length, 200);
  assert.deepEqual(value.counts[0], { kind: 'model', total: 201, shown: 200 });
  assert.equal(value.warnings[0].code, 'RESOURCE_OVERVIEW_TRUNCATED');
});

test('Skill source filters apply before pagination and isolate local from cloud reads', async () => {
  let cloudReads=0, localReads=0;
  const options={skillDiscovery:{listInstalled:async()=>{localReads++;return{items:[{resourceId:'local-one',source:'local-import'},{resourceId:'local-two',source:'local-import'}]};}},serverClient:{listResource:async()=>{cloudReads++;return{items:[{resourceId:'cloud-one'},{resourceId:'cloud-two'}],total:2};}}};
  const local=await listStudioResources({...options,query:{kind:'skill',source:'local',limit:1}});
  assert.equal(local.total,2);assert.equal(local.items[0].resourceId,'local-one');assert.equal(cloudReads,0);
  const next=await listStudioResources({...options,query:{kind:'skill',source:'local',limit:1,cursor:local.nextCursor}});
  assert.equal(next.items[0].resourceId,'local-two');
  assert.throws(()=>paginateResources([],{kind:'skill',source:'cloud',cursor:local.nextCursor}),{code:'INVALID_RESOURCE_CURSOR'});
  const before=localReads;
  const cloud=await listStudioResources({...options,query:{kind:'skill',source:'cloud',limit:1}});
  assert.equal(cloud.total,2);assert.equal(cloud.items[0].source,'agentengine-server');assert.equal(localReads,before);
});
