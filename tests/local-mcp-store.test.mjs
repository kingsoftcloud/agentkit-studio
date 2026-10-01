import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMcpStore, LocalMcpStoreError } from '../src/local-mcp-store.mjs';

test('local MCP store persists declarations without credential values and updates probe contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentkit-mcp-'));
  const store = createLocalMcpStore({ storeDir: root });
  const record = await store.create({
    displayName: '秘塔联网搜索', description: '网页搜索',
    server: { name: 'metaso-inner', version: '1.0.0', transport: 'http', endpointUrl: 'https://example.test/mcp', envRefs: { Authorization: 'env://KSC_AIPRO_API_KEY' } },
  });
  assert.match(record.resourceId, /^mcp-local-[a-f0-9]{16}$/);
  assert.equal(record.status, 'pending');
  assert.equal((await store.list())[0].server.envRefs.Authorization, 'env://KSC_AIPRO_API_KEY');
  const contents = await readFile(join(root, `${record.resourceId}.json`), 'utf8');
  assert.doesNotMatch(contents, /secret|apiKeyValue|KSC_AIPRO_API_KEY=/);
  const updated = await store.markProbe(record.resourceId, { tools: [{ name: 'metaso_web_search', description: 'search', inputSchema: { type: 'object' } }] });
  assert.equal(updated.status, 'ready');
  assert.equal(updated.health.toolCount, 1);
  assert.equal(updated.contract.discoveredTools[0].name, 'metaso_web_search');
});

test('local MCP store validates transport-specific connection declarations', async () => {
  const store = createLocalMcpStore({ storeDir: await mkdtemp(join(tmpdir(), 'agentkit-mcp-')) });
  await assert.rejects(() => store.create({ displayName: 'missing endpoint', server: { name: 'missing', transport: 'http' } }), error => error instanceof LocalMcpStoreError && error.code === 'MCP_ENDPOINT_INVALID');
  await assert.rejects(() => store.create({ displayName: 'missing command', server: { name: 'missing', transport: 'stdio' } }), error => error instanceof LocalMcpStoreError && error.code === 'MCP_COMMAND_INVALID');
});
