import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('cloud MCP probe does not require a local resource record', async () => {
  const source = await readFile(new URL('../src/host/bootstrap.mjs', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf("      if (endpoint === 'mcp/probe')"), source.indexOf("      if (endpoint === 'mcp/delete'"));
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const calls = [];
  const run = new AsyncFunction('endpoint', 'payload', 'localMcpStorePromise', 'resourceAdaptersPromise', 'mcpProbePromise', branch);
  const value = { resourceId: 'mcp-cloud', toolCount: 1, health: { toolCount: 1 } };
  const result = await run('mcp/probe', { resourceId: 'mcp-cloud' }, Promise.resolve({ get: async () => null }), Promise.resolve({}), Promise.resolve({ probe: async id => { calls.push(id); return value; } }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['mcp-cloud']);
});
