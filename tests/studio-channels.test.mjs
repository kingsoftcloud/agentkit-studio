import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
