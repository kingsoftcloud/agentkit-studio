import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRemote } from '../src/client/remote/host-client.mjs';

test('native conversation catalogs use the Host RPC before product bootstrap is injected', async () => {
  const calls = [];
  const window = { location: { origin: 'http://localhost', hash: '' } };
  const remote = createHostRemote({ rpc: { call: async (_channel, action, payload) => { calls.push({action,payload}); return {ok:true,value:{items:[{metadata:{id:'agent-a'}}]}}; } } }, { window });
  const result = await remote.agents();
  assert.equal(result.items[0].metadata.id,'agent-a');
  const resources = await remote.platformResources('knowledge-base');
  assert.equal(resources.items.length,1);
  assert.equal(calls.length,2);
});
test('resource browser forwards model paging and search to the Host catalog', async () => {
  const calls = [];
  const bridge = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return { items: Array.from({ length: 10 }, (_, id) => ({ resourceId: String(id) })), total: 64, nextCursor: '10' };
  };
  const remote = createHostRemote({ rpc: { call: async (_channel, endpoint, payload) => ({ ok: true, value: await bridge(endpoint, payload) }) } }, { window: { location: { origin: 'http://localhost', hash: '' } } });
  const query = { kind: 'model', limit: 10, cursor: '10', query: 'glm' };
  const result = await remote.resources(query);
  assert.deepEqual(calls, [{ endpoint: 'resources/list', payload: query }]);
  assert.equal(result.items.length, 10);
  assert.ok(result.nextCursor);
});

test('untyped runtime resource overview reaches Node Host rather than the absent legacy REST contract', async () => {
  const calls = [];
  const window = { location: { origin: 'http://localhost', hash: '' }, __AGENTKIT_STUDIO__: { controlPlane: 'agentengine-server' } };
  const remote = createHostRemote({ rpc: { call: async (channel, endpoint, payload) => { calls.push({ channel, endpoint, payload }); return { ok: true, value: { items: [] } }; } } }, { window });
  await remote.resources({ limit: 200 });
  assert.deepEqual(calls, [{ channel: '/agentkit', endpoint: 'resources/list', payload: { limit: 200 } }]);
});

test('Agent tool picker forwards its selected engine to Native catalog discovery', async () => {
  const calls = [];
  const remote = createHostRemote({ rpc: { call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload }); return { ok: true, value: { items: [] } };
  } } }, { window: { location: { origin: 'http://localhost', hash: '' } } });
  await remote.resources({ kind: 'tool', runtimeType: 'harness' });
  assert.deepEqual(calls, [{ endpoint: 'resources/list', payload: { kind: 'tool', runtimeType: 'harness' } }]);
});
