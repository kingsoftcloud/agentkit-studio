import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalResourceAdapters, LocalResourceError } from '../src/local-resource-adapters.mjs';
import { createLocalMcpStore } from '../src/local-mcp-store.mjs';
import { createZip } from '../src/zip.mjs';

test('cloud Skill Space with no Skills is a valid empty binding', async () => {
  const calls = [];
  const adapters = createLocalResourceAdapters({
    serverClient: { skillAction: async (name, params) => { calls.push({ name, params }); return { data: { Skills: [] } }; } },
  });
  const result = await adapters.loadSkill('bcb4df65-2448-4c8a-99ca-62a12d26bce9');
  assert.deepEqual(result, { name: 'bcb4df65-2448-4c8a-99ca-62a12d26bce9', content: '' });
  assert.deepEqual(calls, [{ name: 'ListSkillsBySpaceId', params: { SpaceId: 'bcb4df65-2448-4c8a-99ca-62a12d26bce9', PageNumber: 1, PageSize: 100 } }]);
});

test('cloud Skill Space downloads through the injected Host fetch boundary', async () => {
  const requests = [];
  const archive = createZip([{ name: 'SKILL.md', data: '# 营销写作\n保持短句。' }]);
  const digest = createHash('sha256').update(archive).digest('hex');
  const adapters = createLocalResourceAdapters({
    serverClient: {
      skillAction: async (name, params) => {
        requests.push({ name, params });
        if (name === 'ListSkillsBySpaceId') return { data: { Skills: [{ SkillId: 'skill-1', Name: '营销写作', ContentHash: `sha256:${digest}` }] } };
        return { data: { DownloadUrl: 'https://download.test/skill-1.zip' } };
      },
    },
    fetchImpl: async url => {
      assert.equal(String(url), 'https://download.test/skill-1.zip');
      return new Response(archive, { status: 200 });
    },
  });
  const result = await adapters.loadSkill('bcb4df65-2448-4c8a-99ca-62a12d26bce9');
  assert.equal(result.name, 'bcb4df65-2448-4c8a-99ca-62a12d26bce9');
  assert.match(result.content, /保持短句/);
  assert.deepEqual(requests.map(item => item.name), ['ListSkillsBySpaceId', 'GetPremadeSkillDownloadUrl']);
});

test('bound cloud Skill materializes its script beside the DSH skill manifest', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'studio-cloud-skill-'));
  try {
    const archive = createZip([
      { name: 'demo/SKILL.md', data: '---\nname: demo-skill\ndescription: Check JSON\n---\nRun scripts/check.py.' },
      { name: 'demo/scripts/check.py', data: 'print("actual-skill-output")\n' },
    ]);
    const adapters = createLocalResourceAdapters({ cacheDir,
      serverClient: { skillAction: async name => name === 'ListSkillsBySpaceId' ? { data: { Skills: [{ SkillId: 'demo-skill' }] } } : { data: { DownloadUrl: 'https://download.test/demo.zip' } } },
      fetchImpl: async () => new Response(archive),
    });
    const result = await adapters.loadSkill('bcb4df65-2448-4c8a-99ca-62a12d26bce9');
    assert.equal(result.definitions?.[0].name, 'demo-skill');
    assert.equal(result.definitions[0].resourceBase.kind, 'directory');
    assert.equal(await readFile(join(result.definitions[0].resourceBase.path, 'scripts/check.py'), 'utf8'), 'print("actual-skill-output")\n');
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('cloud Skill Space rejects a downloaded archive with a mismatched ContentHash', async () => {
  const archive = createZip([{ name: 'SKILL.md', data: '# 营销写作' }]);
  const adapters = createLocalResourceAdapters({
    serverClient: {
      skillAction: async name => name === 'ListSkillsBySpaceId'
        ? { data: { Skills: [{ SkillId: 'skill-1', ContentHash: 'sha256:' + '0'.repeat(64) }] } }
        : { data: { DownloadUrl: 'https://download.test/skill-1.zip' } },
    },
    fetchImpl: async () => new Response(archive, { status: 200 }),
  });
  await assert.rejects(() => adapters.loadSkill('bcb4df65-2448-4c8a-99ca-62a12d26bce9'), error => error instanceof LocalResourceError && error.code === 'SKILL_ARCHIVE_HASH_MISMATCH' && error.details.resourceId === 'skill-1');
});

test('missing non-cloud Skill remains an explicit local import error', async () => {
  const adapters = createLocalResourceAdapters({
    skillDiscovery: { listInstalled: async () => ({ items: [] }) },
    serverClient: { skillAction: async () => { throw new Error('must not call cloud Skill Service'); } },
  });
  await assert.rejects(() => adapters.loadSkill('local-skill-not-installed'), error => error instanceof LocalResourceError && error.code === 'SKILL_NOT_INSTALLED');
});

test('cloud MCP uses its protocol endpoint instead of the service homepage', async () => {
  const adapters = createLocalResourceAdapters({
    serverClient: { action: async () => ({ data: { endpoint: 'https://cloud.test/', mcp_endpoint: 'https://cloud.test/mcp' } }) },
    fetchImpl: async (url, init = {}) => {
      if (new URL(url).pathname !== '/mcp') return new Response('not MCP', { status: 404 });
      if (!init.body) return new Response(null, { status: 405 });
      const request = JSON.parse(init.body);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = request.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'cloud', version: '1' } } : { tools: [{ name: 'search', inputSchema: { type: 'object' } }] };
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  });
  try { assert.equal((await adapters.listMcpTools('mcp-cloud')).length, 1); }
  finally { await adapters.close(); }
});

test('MCP certificate failures remain explicit and do not bypass TLS validation', async () => {
  const adapters = createLocalResourceAdapters({ fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) }); } });
  await assert.rejects(() => adapters.listMcpTools({ resourceId: 'tls-test', endpointUrl: 'https://cloud.test/mcp' }), { code: 'MCP_TLS_FAILED' });
});

test('memory adapter uses QueryMemorySdk and normalizes the returned memories', async () => {
  let call;
  const adapters = createLocalResourceAdapters({
    serverClient: { action: async (...args) => { call = args; return { data: { Data: [{ Memories: [{ content: '历史偏好' }] }] } }; } },
  });
  const result = await adapters.searchMemory('mem-1', '偏好', 'user-1', { agentId: 'agent-1' });
  assert.deepEqual(result, [{ content: '历史偏好' }]);
  assert.equal(call[0], 'QueryMemorySdk');
  assert.equal(call[1].MemoryCollectionId, 'mem-1');
  assert.match(call[1].AgentUserId, /^mp1-[0-9a-f]{60}$/);
  assert.equal(call[1].Query, '偏好');
  assert.equal(call[1].Limit, 5);
  assert.equal(call[1].SceneId, '_sys_general');
  assert.deepEqual(call[2], { apiVersion: '2025-11-14' });
});

test('memory adapter parses the JSON-string AICP response wrapper', async () => {
  const adapters = createLocalResourceAdapters({
    serverClient: { action: async () => ({ data: JSON.stringify({ Data: [{ Memories: [{ Content: [{ Type: 'input_text', Text: '跨会话偏好' }] }] }] }) }) },
  });
  const result = await adapters.searchMemory('mem-1', '偏好', 'user-1', { agentId: 'agent-1' });
  assert.deepEqual(result, [{ Content: [{ Type: 'input_text', Text: '跨会话偏好' }] }]);
});

test('knowledge adapter bounds DSH search text to the RetrieveKnowledge contract', async () => {
  let call;
  const adapters = createLocalResourceAdapters({
    serverClient: { action: async (...args) => { call = args; return { data: { Records: [] } }; } },
  });
  await adapters.searchKnowledge('kb-1', `${'前置检索意图 '.repeat(80)}尾部上下文`);
  assert.equal(call[0], 'RetrieveKnowledge');
  assert.equal(call[1].DatasetId, 'kb-1');
  assert.equal(call[1].Query.length, 250);
  assert.equal(call[2].apiVersion, '2025-11-14');
});

test('memory adapter writes a bounded conversation through CreateMemorySdk', async () => {
  let call;
  const adapters = createLocalResourceAdapters({
    serverClient: { action: async (...args) => { call = args; return { data: { accepted: true } }; } },
  });
  const result = await adapters.writeMemory('mem-1', 'user-1', [
    { role: 'user', content: '我喜欢轻松口吻' },
    { role: 'assistant', content: '好的，我会保持轻松口吻。' },
  ], { sessionId: 'session-1', agentId: 'agent-1' });
  assert.deepEqual(result, { accepted: true, data: { accepted: true } });
  assert.equal(call[0], 'CreateMemorySdk');
  assert.equal(call[1].MemoryCollectionId, 'mem-1');
  assert.match(call[1].AgentUserId, /^mp1-[0-9a-f]{60}$/);
  assert.deepEqual({ ...call[1], AgentUserId: undefined, Data: undefined }, {
    MemoryCollectionId: 'mem-1', AgentUserId: undefined, SceneId: '_sys_general', DataType: 'conversation',
    Data: undefined,
    AgentId: 'agent-1', SessionId: call[1].SessionId,
  });
  assert.match(call[1].SessionId, /^[0-9a-f]{64}$/);
  assert.deepEqual(call[1].Data, { Conversation: [
      { Role: 'user', CreatedAt: call[1].Data.Conversation[0].CreatedAt, MessageId: call[1].Data.Conversation[0].MessageId, Content: [{ Type: 'input_text', Text: '我喜欢轻松口吻' }] },
      { Role: 'assistant', CreatedAt: call[1].Data.Conversation[1].CreatedAt, MessageId: call[1].Data.Conversation[1].MessageId, Content: [{ Type: 'input_text', Text: '好的，我会保持轻松口吻。' }] },
    ] });
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

test('MCP tool protocol errors remain tool failures instead of connection failures', async () => {
  const fetchImpl = async (url, init = {}) => {
    if (!init.body) return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    if (message.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'tool-error', version: '1' } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'tool-error-session' } });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'tool-error-session' } });
    if (message.method === 'tools/call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'invalid query' } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'tool-error-session' } });
    return new Response(null, { status: 405 });
  };
  const adapters = createLocalResourceAdapters({ fetchImpl, serverClient: { action: async () => { throw new Error('inline descriptor must not call GetMCP'); } } });
  const binding = { resourceId: 'tool-error-mcp', endpointUrl: 'https://example.test/mcp' };
  await adapters.listMcpTools(binding);
  await assert.rejects(
    () => adapters.callMcpTool(binding, 'search', { q: 'bad' }),
    error => error instanceof LocalResourceError
      && error.code === 'MCP_TOOL_FAILED'
      && error.details.resourceId === 'tool-error-mcp'
      && error.details.name === 'search'
      && !error.message.includes('Endpoint 连接失败'),
  );
  await adapters.close();
});

test('local MCP records resolve nested server endpoint and authorization reference', async () => {
  const requests = [];
  const dir = await mkdtemp(join(tmpdir(), 'agentkit-local-mcp-'));
  const fetchImpl = async (url, init = {}) => {
    const message = init.body ? JSON.parse(init.body) : null;
    if (message) requests.push({ method: message.method, authorization: init.headers?.get?.('authorization') });
    if (message?.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'nested', version: '1' } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'nested-session' } });
    if (message?.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message?.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'nested_search', inputSchema: { type: 'object' } }] } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'nested-session' } });
    return new Response(null, { status: 405 });
  };
  try {
    const store = createLocalMcpStore({ storeDir: dir });
    const record = await store.create({ displayName: 'Nested MCP', server: {
      name: 'nested', transport: 'http', endpointUrl: 'https://example.test/nested',
      envRefs: { Authorization: 'env://MCP_TEST_TOKEN' },
    }});
    const adapters = createLocalResourceAdapters({
      resourceStore: store, fetchImpl,
      credentials: { resolve: async name => name === 'MCP_TEST_TOKEN' ? { value: 'nested-secret' } : undefined },
      serverClient: { action: async () => { throw new Error('local record must not call GetMCP'); } },
    });
    assert.deepEqual(await adapters.listMcpTools(record.resourceId), [{ name: 'nested_search', inputSchema: { type: 'object' } }]);
    assert.equal(requests.find(item => item.method === 'initialize')?.authorization, 'Bearer nested-secret');
    await adapters.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MCP HTTP auth failures are actionable and missing credentials fail before network access', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return new Response('unauthorized', { status: 401 }); };
  const adapters = createLocalResourceAdapters({
    credentials: { resolve: async () => undefined }, fetchImpl,
    serverClient: { action: async () => { throw new Error('must not call GetMCP'); } },
  });
  await assert.rejects(
    () => adapters.listMcpTools({ resourceId: 'auth-mcp', endpointUrl: 'https://example.test/mcp', envRefs: { Authorization: 'env://MISSING_TOKEN' } }),
    error => error instanceof LocalResourceError && error.code === 'MCP_CREDENTIAL_MISSING' && error.details.resourceId === 'auth-mcp',
  );
  assert.equal(requests, 0);

  const authAdapters = createLocalResourceAdapters({
    credentials: { resolve: async () => ({ value: 'expired-token' }) }, fetchImpl,
    serverClient: { action: async () => { throw new Error('inline descriptor must not call GetMCP'); } },
  });
  await assert.rejects(
    () => authAdapters.listMcpTools({ resourceId: 'auth-mcp', endpointUrl: 'https://example.test/mcp', credentialRef: 'env://MISSING_TOKEN' }),
    error => error instanceof LocalResourceError && error.code === 'MCP_AUTH_FAILED' && error.details.status === 401 && !JSON.stringify(error).includes('expired-token'),
  );
});

test('MCP clients are replaced when a DSH credential rotates', async () => {
  let token = 'first-token';
  const authorizations = [];
  const fetchImpl = async (url, init = {}) => {
    if (!init.body) return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    authorizations.push(init.headers?.get?.('authorization'));
    if (message.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'rotating', version: '1' } } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': `session-${authorizations.length}` } });
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search', inputSchema: { type: 'object' } }] } }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'rotating-session' } });
    return new Response(null, { status: 405 });
  };
  const adapters = createLocalResourceAdapters({
    credentials: { resolve: async () => ({ value: token }) }, fetchImpl,
    serverClient: { action: async () => { throw new Error('inline descriptor must not call GetMCP'); } },
  });
  const binding = { resourceId: 'rotating-mcp', endpointUrl: 'https://example.test/mcp', credentialRef: 'env://TOKEN' };
  await adapters.listMcpTools(binding);
  token = 'second-token';
  await adapters.listMcpTools(binding);
  const distinct = authorizations.filter(Boolean).filter((value, index, values) => index === 0 || value !== values[index - 1]);
  assert.deepEqual(distinct, ['Bearer first-token', 'Bearer second-token']);
  await adapters.close();
});
