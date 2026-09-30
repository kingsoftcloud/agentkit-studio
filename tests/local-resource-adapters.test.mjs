import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalResourceAdapters, LocalResourceError } from '../src/local-resource-adapters.mjs';

test('cloud Skill Space with no Skills is a valid empty binding', async () => {
  const calls = [];
  const adapters = createLocalResourceAdapters({
    serverClient: { skillAction: async (name, params) => { calls.push({ name, params }); return { data: { Skills: [] } }; } },
  });
  const result = await adapters.loadSkill('bcb4df65-2448-4c8a-99ca-62a12d26bce9');
  assert.deepEqual(result, { name: 'bcb4df65-2448-4c8a-99ca-62a12d26bce9', content: '' });
  assert.deepEqual(calls, [{ name: 'ListSkillsBySpaceId', params: { SpaceId: 'bcb4df65-2448-4c8a-99ca-62a12d26bce9', PageNumber: 1, PageSize: 100 } }]);
});

test('missing non-cloud Skill remains an explicit local import error', async () => {
  const adapters = createLocalResourceAdapters({
    skillDiscovery: { listInstalled: async () => ({ items: [] }) },
    serverClient: { skillAction: async () => { throw new Error('must not call cloud Skill Service'); } },
  });
  await assert.rejects(() => adapters.loadSkill('local-skill-not-installed'), error => error instanceof LocalResourceError && error.code === 'SKILL_NOT_INSTALLED');
});

test('memory adapter uses QueryMemorySdk and normalizes the returned memories', async () => {
  let call;
  const adapters = createLocalResourceAdapters({
    serverClient: { action: async (...args) => { call = args; return { data: [{ Memories: [{ content: '历史偏好' }] }] }; } },
  });
  const result = await adapters.searchMemory('mem-1', '偏好', 'user-1');
  assert.deepEqual(result, [{ content: '历史偏好' }]);
  assert.equal(call[0], 'QueryMemorySdk');
  assert.deepEqual(call[1], { MemoryCollectionId: 'mem-1', AgentUserId: 'user-1', Query: '偏好', Limit: 5, SceneId: '_sys_general' });
  assert.deepEqual(call[2], { apiVersion: '2025-11-14' });
});

test('inline MCP descriptors resolve env credentials and execute through Streamable HTTP', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.body) {
      const message = JSON.parse(init.body);
      requests.push({ method: message.method, authorization: init.headers?.get?.('authorization') || init.headers?.Authorization });
      if (message.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' } });
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (message.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' } });
      if (message.method === 'tools/call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session' } });
    }
    return new Response(null, { status: 405 });
  };
  const adapters = createLocalResourceAdapters({
    credentials: { resolve: async name => ({ value: name === 'KSC_AIPRO_API_KEY' ? 'secret-from-credential-service' : '' }) },
    fetchImpl,
    serverClient: { action: async () => { throw new Error('inline descriptor must not call GetMCP'); } },
  });
  const binding = { resourceId: 'metaso-inner', endpointUrl: 'https://example.test/mcp', credentialRef: 'env://KSC_AIPRO_API_KEY' };
  assert.deepEqual(await adapters.listMcpTools(binding), [{ name: 'search', inputSchema: { type: 'object' } }]);
  assert.deepEqual(await adapters.callMcpTool(binding, 'search', { query: 'hello' }), [{ type: 'text', text: 'ok' }]);
  assert.ok(requests.filter(item => item.method === 'initialize').every(item => item.authorization === 'Bearer secret-from-credential-service'));
  await adapters.close();
});
