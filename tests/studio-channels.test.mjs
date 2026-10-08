import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createStudioChannels } from '../src/studio-channels.mjs';

async function makeStore() { return mkdtemp(join(tmpdir(), 'agentkit-channels-')); }

test('channel connection config persists with redacted token', async () => {
  const store = await makeStore();
  const channels = createStudioChannels({ storeDir: store });
  try {
    const initial = await channels.getConnection();
    assert.equal(initial.configured, false);
    const updated = await channels.updateConnection({ serverUrl: 'https://channels.example.com', accountId: 'acc-1', workspaceId: 'ws-1', apiToken: 'secret-token' });
    assert.equal(updated.configured, true);
    assert.equal(updated.tokenConfigured, true);
    assert.equal(updated.serverUrl, 'https://channels.example.com');
    assert.equal(updated.accountId, 'acc-1');
    assert.equal('apiToken' in updated, false);
    const reread = await channels.getConnection();
    assert.equal(reread.configured, true);
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('invalid URL is rejected and proxy without config fails typed', async () => {
  const store = await makeStore();
  const channels = createStudioChannels({ storeDir: store });
  try {
    await assert.rejects(() => channels.updateConnection({ serverUrl: 'ftp://bad' }), error => error.code === 'CHANNEL_URL_INVALID');
    await assert.rejects(() => channels.proxyAction('ListChannels', {}), error => error.code === 'CHANNEL_NOT_CONFIGURED');
  } finally { await rm(store, { recursive: true, force: true }); }
});

test('channel proxy honors the service envelope and sanitizes validation errors over HTTP', async () => {
  const store = await makeStore();
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const reply = {
      ListChannels: { Code: 0, Data: { Items: [], Total: 0 } },
      UpdateChannel: { Code: 404, Message: 'Channel not found', Data: null },
      CreateChannel: { detail: [{ loc: ['body', 'AppSecret'], msg: 'required', input: { apiToken: 'private-secret' } }] },
      GetChannel: { unexpected: true },
    }[req.url.split('/').at(-1)];
    res.statusCode = req.url.endsWith('/CreateChannel') ? 422 : 200;
    res.end(reply ? JSON.stringify(reply) : '<html>not an API</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const channels = createStudioChannels({ storeDir: store });
  try {
    const state = await channels.updateConnection({ serverUrl: `http://127.0.0.1:${server.address().port}`, accountId: 'account', apiToken: 'test-token' });
    assert.equal(state.configured, true, 'cloud channel API does not require a local workspace');
    assert.deepEqual((await channels.proxyAction('ListChannels', { Limit: 10 })).Data, { Items: [], Total: 0 });
    assert.equal(requests[0].headers['x-ksc-account-id'], 'account');
    assert.equal(requests[0].headers.authorization, 'Bearer test-token');
    assert.equal(requests[0].headers['x-ksc-workspace-id'], undefined);
    assert.deepEqual(requests[0].body, { Limit: 10 });
    await assert.rejects(channels.proxyAction('UpdateChannel', { Id: 'missing' }), error => error.code === 'CHANNEL_PROXY_ERROR' && error.details.serviceCode === 404 && error.message === 'Channel not found');
    await assert.rejects(channels.proxyAction('CreateChannel', {}), error => error.message === '渠道参数校验失败：AppSecret' && !JSON.stringify(error).includes('private-secret'));
    await assert.rejects(channels.proxyAction('GetChannel', {}), { code: 'CHANNEL_RESPONSE_INVALID' });
    await assert.rejects(channels.proxyAction('ListBindings', {}), { code: 'CHANNEL_RESPONSE_INVALID' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(store, { recursive: true, force: true });
  }
});

test('local connectors isolate native sessions, redact credentials, and preserve unrelated live connections', async () => {
  const store = await makeStore(), spawned = [], runs = [];
  const agents = ['a', 'b'].map(id => ({ metadata: { id, name: `Agent ${id}` } }));
  const channels = createStudioChannels({ storeDir: store, getAgent: async id => agents.find(agent => agent.metadata.id === id), listAgents: async () => agents,
    runner: async request => { runs.push(request); return { output: 'native output' }; },
    connectorFactory: options => { const item = { options, starts: 0, stops: 0, status: { state: 'connected', connected: true }, start() { this.starts++; }, stop() { this.stops++; } }; spawned.push(item); return item; },
  });
  try {
    await channels.updateConnection({ serverUrl: 'https://example.com', accountId: 'tenant', workspaceId: 'workspace', apiToken: 'admin-secret' });
    await channels.updateAgentConnection('a', { enabled: true, token: 'a-secret' });
    await channels.updateAgentConnection('b', { enabled: true, token: 'b-secret' });
    assert.equal(spawned.length, 2); assert.equal(spawned[0].stops, 0);
    const request = { task_id: 'task', session_id: 'remote-session', channel: 'wps', message: 'hello' };
    for (const connector of spawned) await connector.options.invoke(request);
    await spawned[0].options.invoke({ ...request, task_id: 'task2' });
    await spawned[0].options.invoke({ ...request, channel: 'feishu' });
    assert.notEqual(runs[0].sessionId, runs[1].sessionId);
    assert.equal(runs[0].sessionId, runs[2].sessionId);
    assert.notEqual(runs[0].occurrenceId, runs[2].occurrenceId);
    assert.notEqual(runs[0].sessionId, runs[3].sessionId);
    const safe = await channels.getConnection();
    assert.equal(safe.localAgents.length, 2);
    assert.equal(JSON.stringify(safe).includes('secret'), false);
    assert.equal((await stat(join(store, 'channels.json'))).mode & 0o777, 0o600);
    await channels.updateAgentConnection('b', { enabled: false });
    assert.equal(spawned[0].stops, 0); assert.equal(spawned[1].stops, 1);
    await channels.updateConnection({ serverUrl: 'https://new-service.example.com' });
    assert.equal(spawned[0].stops, 1);
    const config = JSON.parse(await readFile(join(store, 'channels.json'), 'utf8'));
    assert.deepEqual(config.agentConnections, {}); assert.equal(config.apiToken, '');
  } finally { channels.dispose(); await rm(store, { recursive: true, force: true }); }
});

test('a local Agent cannot be accidentally saved with cloud routing', async () => {
  const store = await makeStore();
  const channels = createStudioChannels({ storeDir: store, getAgent: async () => ({ metadata: { id: 'local' } }) });
  try {
    await channels.updateConnection({ serverUrl: 'http://127.0.0.1', accountId: 'test' });
    await assert.rejects(channels.proxyAction('CreateChannel', { AgentId: 'local' }), { code: 'CHANNEL_LOCAL_OFFLINE' });
  } finally { channels.dispose(); await rm(store, { recursive: true, force: true }); }
});

test('cloud channel targets require Studio provenance and the verified tenant, and never use a desktop connector', async () => {
  const store = await makeStore(), requests = [], actors = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); actors.push(req.headers['x-ksc-user-uuid']); res.end(JSON.stringify({ Code: 0, Data: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cloud = { metadata: { id: 'ar-cloud', name: 'Cloud' }, deployment: { state: 'READY' } };
  let accountId = 'tenant';
  const channels = createStudioChannels({ storeDir: store, getAgent: async () => null, listCloudAgents: async () => [cloud],
    resolveCloudAgent: async id => { if (id !== cloud.metadata.id) throw Object.assign(new Error('not owned'), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' }); return { agent: cloud, accountId, userUuid: 'verified-subaccount' }; },
    connectorFactory: () => { throw new Error('cloud must not connect to desktop'); },
  });
  try {
    await channels.updateConnection({ serverUrl: `http://127.0.0.1:${server.address().port}`, accountId: 'tenant', workspaceId: 'previous-local-workspace' });
    assert.deepEqual((await channels.getConnection()).cloudAgents, [{ id: 'ar-cloud', name: 'Cloud', state: 'READY' }]);
    await channels.proxyAction('CreateChannel', { AgentId: 'ar-cloud', ConnectorWorkspaceId: 'stale' });
    await channels.proxyAction('UpdateChannel', { AgentId: 'ar-cloud', ConnectorWorkspaceId: 'stale', Id: 'binding' });
    assert.ok(requests.every(body => body.ConnectorWorkspaceId === ''));
    assert.deepEqual(actors, ['verified-subaccount', 'verified-subaccount']);
    accountId = 'other';
    await assert.rejects(channels.proxyAction('CreateChannel', { AgentId: 'ar-cloud' }), { code: 'CHANNEL_ACCOUNT_MISMATCH' });
    await assert.rejects(channels.proxyAction('CreateChannel', { AgentId: 'legacy-adk' }), { code: 'DEPLOYMENT_AGENT_NOT_FOUND' });
    assert.equal(requests.length, 2);
  } finally { channels.dispose(); await new Promise(resolve => server.close(resolve)); await rm(store, { recursive: true, force: true }); }
});
