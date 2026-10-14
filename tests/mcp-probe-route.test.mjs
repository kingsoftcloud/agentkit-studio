import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceRoutes } from '../src/host/routes/resources.mjs';

test('cloud MCP probe does not require a local resource record', async () => {
  const calls = [];
  const value = { resourceId: 'mcp-cloud', toolCount: 1, health: { toolCount: 1 } };
  const run = createResourceRoutes({ localMcpStorePromise: Promise.resolve({ get: async () => null }), mcpProbePromise: Promise.resolve({ probe: async id => { calls.push(id); return value; } }) });
  const result = await run('mcp/probe', { resourceId: 'mcp-cloud' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['mcp-cloud']);
});
