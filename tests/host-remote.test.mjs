import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioHostRemote, StudioHostError } from '../src/host-remote.mjs';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('Host Remote exchanges a session and sends CSRF on writes', async () => {
  const calls = [];
  const remote = createStudioHostRemote({
    baseUrl: 'http://127.0.0.1:8789',
    sessionToken: 'token-token-token-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/system/session')) return response({ csrfToken: 'csrf-1' });
      if (url.endsWith('/agents')) return response({ items: [] });
      return response({});
    },
  });
  await remote.exchangeSession();
  await remote.createAgent({ id: 'demo-agent', name: 'Demo', runtime: { type: 'harness' } });
  assert.equal(calls[0].url, 'http://127.0.0.1:8789/api/v1/system/session');
  assert.equal(JSON.parse(calls[0].init.body).token, 'token-token-token-token');
  assert.equal(calls[1].init.headers.get('X-CSRF-Token'), 'csrf-1');
  assert.equal(calls[1].init.headers.get('X-AgentKit-Session'), 'token-token-token-token');
  assert.equal(calls[1].init.credentials, 'include');
});

test('Host Remote preserves structured code and never leaks request secrets', async () => {
  const remote = createStudioHostRemote({
    fetchImpl: async () => response({ error: { code: 'AGENT_ALREADY_EXISTS', message: 'Agent ID 已存在', details: { id: 'demo-agent' } } }, 409),
  });
  await assert.rejects(remote.createAgent({ id: 'demo-agent', secret: 'do-not-leak' }), error => {
    assert.ok(error instanceof StudioHostError);
    assert.equal(error.code, 'AGENT_ALREADY_EXISTS');
    assert.equal(error.status, 409);
    assert.equal(error.details.id, 'demo-agent');
    assert.doesNotMatch(error.message, /do-not-leak/);
    return true;
  });
});

test('Agent paths are encoded and list filters are stable', async () => {
  const urls = [];
  const remote = createStudioHostRemote({ fetchImpl: async url => { urls.push(url); return response({}); } });
  await remote.agents({ query: 'a b', limit: 7 });
  await remote.agent('a/b');
  assert.equal(urls[0], '/api/v1/agents?limit=7&query=a%20b');
  assert.equal(urls[1], '/api/v1/agents/a%2Fb');
});

test('normalizes top-level agent arrays to the Studio collection contract', async () => {
  const remote = createStudioHostRemote({
    baseUrl: 'http://127.0.0.1:8789',
    fetchImpl: async () => response([{ metadata: { id: 'a-1' } }]),
  });
  assert.deepEqual(await remote.agents(), { items: [{ metadata: { id: 'a-1' } }] });
});

test('control-plane domain methods use the Host-owned routes', async () => {
  const calls = [];
  const remote = createStudioHostRemote({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return response({});
    },
  });
  await remote.capabilities();
  await remote.evaluationTargets();
  await remote.evaluations('limit=5');
  await remote.evaluationRuns();
  await remote.tracesOverview('range=7d');
  await remote.traces('status=completed');
  await remote.trace('trace/1');
  await remote.traceOtlp('trace/1');
  await remote.evaluationRun('run/1');
  await remote.channelAction('ListChannels', { Offset: 0, Limit: 10 });
  await remote.channelConnection();
  await remote.updateChannelConnection({ serverUrl: 'https://channel.example.invalid' });
  await remote.updateAgentChannelConnection('agent/a', { enabled: true });
  await remote.sessionCommand('session/a', { action: 'cancel' });
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['GET', '/api/v1/capabilities'],
    ['GET', '/api/v1/evaluation-targets'],
    ['GET', '/api/v1/evaluations?limit=5'],
    ['GET', '/api/v1/evaluation-runs'],
    ['GET', '/api/v1/traces/overview?range=7d'],
    ['GET', '/api/v1/traces?status=completed'],
    ['GET', '/api/v1/traces/trace%2F1'],
    ['GET', '/api/v1/traces/trace%2F1/otlp'],
    ['GET', '/api/v1/evaluation-runs/run%2F1'],
    ['POST', '/agentengine/api/v1/ListChannels'],
    ['GET', '/api/v1/channels/connection'],
    ['PUT', '/api/v1/channels/connection'],
    ['PUT', '/api/v1/channels/agents/agent%2Fa/connection'],
    ['POST', '/api/v1/sessions/session%2Fa/commands'],
  ]);
  assert.deepEqual(JSON.parse(calls[11].body), { serverUrl: 'https://channel.example.invalid' });
});

test('bound-agent conversation uses the typed Studio stream and idempotency key', async () => {
  const calls = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: run.completed\ndata: {}\n\n'));
      controller.close();
    },
  });
  const remote = createStudioHostRemote({
    baseUrl: 'http://127.0.0.1:8789',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.includes('/conversation-surface')) return response({ buildId: 'build-1', surface: {} });
      return { ok: true, status: 200, body: stream, text: async () => '' };
    },
  });
  const input = {
    apiVersion: 'conversation.ksadk.io/v1',
    kind: 'ConversationInput',
    inputId: 'input-1',
    sessionId: 'dsh-session-1',
    idempotencyKey: 'idem-1',
    parts: [{ kind: 'text', text: 'hello' }],
  };
  const result = await remote.streamAgentConversation('agent/a', 'dsh/session', input);
  assert.ok(result.body);
  assert.equal(calls[0].url, 'http://127.0.0.1:8789/api/v1/agents/agent%2Fa/conversation-surface?sessionId=dsh%2Fsession');
  assert.equal(calls[1].url, 'http://127.0.0.1:8789/api/v1/builds/build-1/conversation:stream');
  assert.equal(calls[1].init.headers.get('Idempotency-Key'), 'idem-1');
  assert.equal(JSON.parse(calls[1].init.body).input.sessionId, 'dsh-session-1');
});

test('authoring remote keeps multi-turn compose and commit contracts Host-owned', async () => {
  const calls = [];
  const remote = createStudioHostRemote({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return response({ proposal: { name: 'Demo Agent', spec: { instructions: { system: 'Help.' } } }, requiresConfirmation: true });
    },
  });
  const messages = [{ role: 'user', content: '先做一个日报 Agent' }, { role: 'assistant', content: '{"name":"日报 Agent"}' }, { role: 'user', content: '再加上风险标记' }];
  await remote.composeAuthoringConversation({ messages, modelProfileId: 'model:test', runtimeType: 'dsh-native', agentModelProfileIds: ['model:test'], requestId: 'conv-1' });
  await remote.authoringConversationStatus('conv/1');
  assert.equal(calls[0].url, '/api/v1/authoring/conversations:compose');
  assert.equal(JSON.parse(calls[0].body).messages.length, 3);
  assert.equal(calls[1].url, '/api/v1/authoring/conversations:status/conv%2F1');
});

test('resource lifecycle remote exposes MCP and local Skill discovery contracts', async () => {
  const calls = [];
  const remote = createStudioHostRemote({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET', body: init.body });
      return response({ items: [], candidates: [], inspectionToken: 'skd-test' });
    },
  });
  await remote.createMcpResource({ displayName: 'Search', server: { name: 'search', version: '1.0.0', transport: 'http', endpointUrl: 'https://mcp.test' } });
  await remote.probeMcpResource('mcp/search');
  await remote.discoverSkills(['skills']);
  await remote.previewDiscoveredSkill('token/a', 'candidate/a', 'SKILL.md');
  await remote.commitDiscoveredSkill('token/a', 'candidate/a', true);
  await remote.previewInstalledSkill('skill/local/search', 'SKILL.md');
  assert.deepEqual(calls.map(call => [call.method, call.url]), [
    ['POST', '/api/v1/catalog/mcp-servers'],
    ['POST', '/api/v1/catalog/mcp-servers/mcp%2Fsearch:probe?timeoutSeconds=15'],
    ['POST', '/api/v1/catalog/skills:discover'],
    ['GET', '/api/v1/catalog/skills/discoveries/token%2Fa/candidates/candidate%2Fa/files?path=SKILL.md'],
    ['POST', '/api/v1/catalog/skills/discoveries/token%2Fa:commit'],
    ['GET', '/api/v1/catalog/skills/skill%2Flocal%2Fsearch/files?path=SKILL.md'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body).server.name, 'search');
  assert.deepEqual(JSON.parse(calls[2].body), { scanPaths: ['skills'] });
  assert.deepEqual(JSON.parse(calls[4].body), { candidateId: 'candidate/a', overwrite: true });
});
