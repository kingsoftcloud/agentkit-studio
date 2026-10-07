import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
