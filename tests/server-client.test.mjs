import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEngineClient, AgentEngineError } from '../src/server-client.mjs';

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
  assert.match(urls[1], /^https:\/\/aicp\.inner\.api\.ksyun\.com\//);
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

test('direct server client does not expose unapproved destructive actions', async () => {
  const client = createAgentEngineClient({ configuration: configuration({ cloudServerUrl: 'http://127.0.0.1:8789' }) });
  await assert.rejects(() => client.action('DeleteAgent', { AgentId: 'a1' }), error => error instanceof AgentEngineError && error.code === 'ACTION_NOT_ALLOWED');
});
