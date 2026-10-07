import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/client-fragments/01-loader-and-primitives.js', import.meta.url), 'utf8');
const remoteFactory = source.slice(source.indexOf('    function createHostRemote'), source.indexOf('    let activeConnection'));

test('native conversation catalogs use the Host RPC before product bootstrap is injected', async () => {
  const calls = [];
  const window = { location: { origin: 'http://localhost', hash: '' } };
  const factory = new Function('window', `${remoteFactory}; return createHostRemote;`)(window);
  const remote = factory({ rpc: { call: async (_channel, action, payload) => { calls.push({action,payload}); return {ok:true,value:{items:[{metadata:{id:'agent-a'}}]}}; } } });
  const result = await remote.agents();
  assert.equal(result.items[0].metadata.id,'agent-a');
  const resources = await remote.platformResources('knowledge-base');
  assert.equal(resources.items.length,1);
  assert.equal(calls.length,2);
});
const body = source.slice(source.indexOf('resources: options => {') + 'resources: '.length, source.indexOf('        // Resource lifecycle routes')).trim().replace(/,$/, '');

test('resource browser forwards model paging and search to the Host catalog', async () => {
  const calls = [];
  const bridge = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    return { items: Array.from({ length: 10 }, (_, id) => ({ resourceId: String(id) })), total: 64, nextCursor: '10' };
  };
  const resources = new Function('directServer', 'studioCall', 'studioBridgeOperation', 'bridgeAvailable', 'serverAction', 'request', `return (${body});`)(
    () => true,
    async () => ({ items: Array.from({ length: 64 }, (_, id) => ({ id: String(id) })) }),
    bridge, () => true, () => {}, () => {},
  );
  const query = { kind: 'model', limit: 10, cursor: '10', query: 'glm' };
  const result = await resources(query);
  assert.deepEqual(calls, [{ endpoint: 'resources/list', payload: query }]);
  assert.equal(result.items.length, 10);
  assert.ok(result.nextCursor);
});
