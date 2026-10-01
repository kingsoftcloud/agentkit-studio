import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCloudAgentUpdate, createAgentEngineClient, AgentEngineError } from '../src/server-client.mjs';

function configuration(values) { return { resolve: async () => ({ values, sources: {} }) }; }

test('server client sends existing local Action API without requiring KsADK', async () => {
  let request;
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789', cloudRegion: 'cn-beijing-6', cloudServiceToken: 'local-token' }),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ Code: 0, RequestId: 'req-1', Data: { Agents: [{ AgentId: 'a1', Name: 'A', Status: 'READY' }], Total: 1, Page: 1, PageSize: 20 } }), { status: 200 });
    },
  });
  const result = await client.listAgents({ page: 1, pageSize: 20 });
  assert.equal(result.items[0].id, 'a1');
  assert.match(request.url, /\/agentengine\/api\/v1\/ListAgents$/);
  assert.equal(request.init.headers.Authorization, 'Bearer local-token');
  assert.equal(request.init.redirect, 'error');
});

test('custom remote origins never receive cloud AK/SK signing', async () => {
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://example.invalid', cloudAccessKey: 'AK', cloudSecretKey: 'SK' }),
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.Authorization, undefined);
      return new Response(JSON.stringify({ Code: 0, Data: { Agents: [], Total: 0 } }), { status: 200 });
    },
  });
  await assert.rejects(() => client.listAgents(), error => error instanceof AgentEngineError && error.code === 'SERVER_CREDENTIALS_MISSING');
});

test('KOP calls fail closed when cloud credentials are missing', async () => {
  const client = createAgentEngineClient({ configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com' }), fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => client.listAgents(), error => error instanceof AgentEngineError && error.code === 'CLOUD_CREDENTIALS_MISSING');
});

test('KOP calls copy the AWS4 Authorization header into fetch', async () => {
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (_url, init) => {
      assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKTEST\//);
      assert.equal(init.headers['X-Action'], 'ListAgents');
      return new Response(JSON.stringify({ Code: 0, Data: { Agents: [], Total: 0, Page: 1, PageSize: 20 } }), { status: 200 });
    },
  });
  await client.listAgents();
});

test('KOP falls back to the intranet endpoint for inner-only accounts', async () => {
  const urls = [];
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (urls.length === 1) return new Response(JSON.stringify({ Error: { Message: 'The inner account can only access through intranet' } }), { status: 403 });
      assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKTEST\//);
      return new Response(JSON.stringify({ Code: 0, Data: { Agents: [], Total: 0, Page: 1, PageSize: 20 } }), { status: 200 });
    },
  });
  await client.listAgents();
  assert.match(urls[1], /^http:\/\/aicp\.inner\.api\.ksyun\.com\//);
});

test('regular KOP Actions fall back when inner-account denial is XML', async () => {
  const urls = [];
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (urls.length === 1) return new Response('<ErrorResponse><Error><Code>InnerAccountCanOnlyAccessThroughIntranet</Code><Message>The inner account can only access through intranet</Message></Error></ErrorResponse>', { status: 403, headers: { 'content-type': 'application/xml' } });
      assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKTEST\//);
      return new Response(JSON.stringify({ Code: 0, Data: { SessionId: 's1' } }), { status: 200 });
    },
  });
  const result = await client.action('CreateSession', { AgentId: 'a1', SessionId: 's1' });
  assert.equal(result.data.SessionId, 's1');
  assert.match(urls[1], /^http:\/\/aicp\.inner\.api\.ksyun\.com\//);
});

test('pre-online region signs with the real control region and keeps the pre source marker', async () => {
  const headersSeen = [];
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (_url, init) => {
      headersSeen.push(init.headers);
      return new Response(JSON.stringify({ Code: 0, Data: { Agents: [], Total: 0, Page: 1, PageSize: 20 } }), { status: 200 });
    },
  });
  await client.listAgents();
  assert.equal(headersSeen[0]['X-Ksc-Region'], 'cn-beijing-6');
  assert.equal(headersSeen[0]['X-KSC-CUSTOM-SOURCE'], 'pre');
  assert.match(headersSeen[0].Authorization, /cn-beijing-6\/aicp\/aws4_request/);
});

test('direct server client normalizes Agent detail and platform resources', async () => {
  const calls = [];
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789', cloudServiceToken: 'local-token' }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const action = new URL(url).pathname.split('/').pop();
      const data = action === 'GetAgent'
        ? { Basic: { AgentId: 'a1', Name: 'A', Revision: 3, Framework: 'dsh-native' }, ComponentConfig: { KnowledgeBase: { Id: 'kb-1', Region: 'cn-beijing-6' } } }
        : { Items: [{ Id: 'kb-1', Name: '企业知识库', Region: 'cn-beijing-6' }], Total: 1 };
      return new Response(JSON.stringify({ Code: 0, RequestId: 'req-2', Data: data }), { status: 200 });
    },
  });
  const agent = await client.getAgent('a1');
  assert.equal(agent.metadata.revision, 3);
  assert.equal(agent.spec.bindings.plugins[0].config.binding.resource.kind, 'knowledge-base');
  const resources = await client.listResource('knowledge-base');
  assert.equal(resources.items[0].id, 'kb-1');
  assert.deepEqual(calls.map(call => call.body), [{ AgentId: 'a1' }, {}]);
});

test('local Studio Agent detail falls back when shared GetAgent action is not mounted', async () => {
  const calls = [];
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789' }),
    sessionToken: 'studio-session',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, session: init.headers['X-AgentKit-Session'] });
      if (String(url).endsWith('/agentengine/api/v1/GetAgent')) {
        return new Response(JSON.stringify({ Code: 404, Message: 'Studio 尚未实现共享 Web 动作：GetAgent' }), { status: 404 });
      }
      return new Response(JSON.stringify({ draft: {
        metadata: { id: 'local-a1', name: 'Local Agent', revision: 2 },
        spec: { runtime: { type: 'dsh-native' }, bindings: {} },
      } }), { status: 200, headers: { 'x-request-id': 'local-req' } });
    },
  });
  const agent = await client.getAgent('local-a1');
  assert.equal(agent.metadata.id, 'local-a1');
  assert.equal(agent.metadata.revision, 2);
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:8789/agentengine/api/v1/GetAgent', method: 'POST', session: 'studio-session' },
    { url: 'http://127.0.0.1:8789/api/v1/agents/local-a1', method: 'GET', session: 'studio-session' },
  ]);
});

test('local Studio Agent catalog returns complete revisions without a Server Action fan-out', async () => {
  const calls = [];
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789' }),
    sessionToken: 'studio-session',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return new Response(JSON.stringify({ items: [{
        metadata: { id: 'local-agent', name: 'Local Agent', revision: 4 },
        spec: { runtime: { type: 'dsh-native' }, bindings: {
          modelProfileIds: ['model:one', 'model:two'],
          mcpServers: ['mcp:one'], skills: ['skill:one'],
        } },
      }], nextCursor: null }), { status: 200 });
    },
  });
  const result = await client.listAgents({ page: 1, pageSize: 20 });
  assert.equal(result.source, 'local-studio');
  assert.equal(result.items[0].spec.bindings.mcpServers.length, 1);
  assert.match(calls[0].url, /127\.0\.0\.1:8789\/api\/v1\/agents\?limit=20/);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls.length, 1);
});

test('local AgentEngine catalog exposes Tool resources through the existing REST contract', async () => {
  let request;
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789' }),
    sessionToken: 'studio-session',
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ items: [{ resourceId: 'tool:builtin:component-status:1.0.0', kind: 'tool', source: 'builtin', name: 'component_status', contract: { executor: 'builtin' } }], nextCursor: null }), { status: 200, headers: { 'x-request-id': 'catalog-1' } });
    },
  });
  const result = await client.listCatalogResources({ kind: 'tool', limit: 20 });
  assert.equal(result.items[0].resourceId, 'tool:builtin:component-status:1.0.0');
  assert.match(request.url, /\/api\/v1\/catalog\/resources\?kind=tool&limit=20/);
  assert.equal(request.init.headers['X-AgentKit-Session'], 'studio-session');
});

test('local cursor catalog keeps the next page reachable when the first window is full', async () => {
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789' }),
    sessionToken: 'studio-session',
    fetchImpl: async () => new Response(JSON.stringify({ items: Array.from({ length: 20 }, (_, index) => ({
      metadata: { id: `agent-${index}`, name: `Agent ${index}` }, spec: { runtime: { type: 'dsh-native' }, bindings: {} },
    })), nextCursor: 'more' }), { status: 200 }),
  });
  const result = await client.listAgents({ page: 1, pageSize: 20 });
  assert.equal(result.nextCursor, 'more');
  assert.equal(result.total, 21);
});

test('direct server client does not expose unapproved destructive actions', async () => {
  const client = createAgentEngineClient({ configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789' }) });
  await assert.rejects(() => client.action('DeleteAgent', { AgentId: 'a1' }), error => error instanceof AgentEngineError && error.code === 'ACTION_NOT_ALLOWED');
});

test('cloud Agent updates translate Studio platform bindings to ComponentConfig', () => {
  const payload = buildCloudAgentUpdate('ar-cloud-1', {
    name: '知识助手',
    description: '云端检索助手',
    spec: { bindings: { plugins: [
      { config: { binding: { resource: { kind: 'knowledge-base', id: 'kb-1', name: '企业知识库' } } } },
      { config: { binding: { resource: { kind: 'memory-instance', id: 'mem-1' } } } },
      { config: { binding: { resource: { kind: 'skill-space', id: 'space-1' } } } },
    ] } },
  });
  assert.deepEqual(payload, {
    AgentId: 'ar-cloud-1', Name: '知识助手', Description: '云端检索助手',
    ComponentConfig: {
      KnowledgeBase: { Id: 'kb-1', Name: '企业知识库' },
      Memory: { Id: 'mem-1' },
      SkillWorkspace: { Id: 'space-1' },
    },
  });
});

test('cloud Agent updates reject local-only bindings instead of dropping them', () => {
  assert.throws(() => buildCloudAgentUpdate('ar-cloud-1', { spec: { bindings: { mcpServers: ['mcp-1'] } } }), error => error instanceof AgentEngineError && error.code === 'CLOUD_BINDING_UNSUPPORTED');
});

test('streamAction keeps RunAgent SSE on the Node credential boundary', async () => {
  let request;
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789', cloudServiceToken: 'local-token' }),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const response = await client.streamAction('RunAgent', { AgentId: 'a1', SessionId: 's1', Stream: true });
  assert.equal(response.status, 200);
  assert.equal(request.init.headers.Authorization, 'Bearer local-token');
  assert.equal(request.init.headers.Accept, 'text/event-stream');
  assert.match(request.url, /\/agentengine\/api\/v1\/RunAgent$/);
});

test('streamAction falls back when KOP returns an XML inner-account denial', async () => {
  const urls = [];
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (urls.length === 1) return new Response('<ErrorResponse><Error><Code>InnerAccountCanOnlyAccessThroughIntranet</Code><Message>The inner account can only access through intranet</Message></Error></ErrorResponse>', { status: 403, headers: { 'content-type': 'application/xml' } });
      assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKTEST\//);
      return new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const response = await client.streamAction('RunAgent', { AgentId: 'a1', SessionId: 's1', Stream: true });
  assert.equal(response.status, 200);
  assert.match(urls[0], /^https:\/\/aicp\.api\.ksyun\.com\//);
  assert.match(urls[1], /^http:\/\/aicp\.inner\.api\.ksyun\.com\//);
});

test('GetAgent uses the deployed framework when Basic omits it', async () => {
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789', cloudServiceToken: 'local-token' }),
    fetchImpl: async () => new Response(JSON.stringify({ Code: 0, Data: {
      Basic: { AgentId: 'cloud-langgraph', Name: 'Cloud LangGraph' },
      Deployment: { Framework: 'langgraph' },
    } }), { status: 200 }),
  });
  const agent = await client.getAgent('cloud-langgraph');
  assert.equal(agent.spec.runtime.type, 'langgraph');
});

test('knowledge retrieval can select the AICP action version without changing the default API', async () => {
  let url;
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (requestUrl) => {
      url = String(requestUrl);
      return new Response(JSON.stringify({ Code: 0, Data: { Records: [] } }), { status: 200 });
    },
  });
  await client.action('RetrieveKnowledge', { DatasetId: 'kb-1', Query: 'hello' }, { apiVersion: '2025-11-14' });
  assert.match(url, /Action=RetrieveKnowledge/);
  assert.match(url, /Version=2025-11-14/);
});

test('Skill Service uses a signed GET action for cloud Skill Spaces', async () => {
  let request;
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudRegion: 'pre-online', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({ Code: 0, RequestId: 'skill-req', Data: { Skills: [] } }), { status: 200 });
    },
  });
  const result = await client.skillAction('ListSkillsBySpaceId', { SpaceId: 'space-1', PageNumber: 1, PageSize: 100 });
  assert.deepEqual(result.data, { Skills: [] });
  assert.match(request.url, /Action=ListSkillsBySpaceId/);
  assert.match(request.url, /SpaceId=space-1/);
  assert.equal(request.init.method, 'GET');
  assert.match(request.init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKTEST\//);
});

test('QueryMemorySdk accepts the native response shape without a Code field', async () => {
  let body;
  const client = createAgentEngineClient({
    configuration: configuration({ cloudServerUrl: 'https://aicp.api.ksyun.com', cloudAccessKey: 'AKTEST', cloudSecretKey: 'SKTEST' }),
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ Data: [{ Memories: [{ content: 'remembered' }] }] }), { status: 200 });
    },
  });
  const result = await client.action('QueryMemorySdk', { MemoryCollectionId: 'mem-1', AgentUserId: 'u-1', Query: 'q', Limit: 5, SceneId: '_sys_general' }, { apiVersion: '2025-11-14' });
  assert.deepEqual(result.data, [{ Memories: [{ content: 'remembered' }] }]);
  assert.equal(body.MemoryCollectionId, 'mem-1');
  assert.equal(body.AgentUserId, 'u-1');
  assert.equal(body.Service, 'aicp');
  assert.equal(body.Action, 'QueryMemorySdk');
  assert.equal(body.Version, '2025-11-14');
});
