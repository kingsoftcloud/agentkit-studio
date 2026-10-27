import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRemote } from '../src/client/remote/host-client.mjs';
import { createProductClient } from '../src/client/remote/product-client.mjs';

for (const [name, create] of [['product', createProductClient], ['compatibility', createHostRemote]]) {
  test(`${name} client preserves authenticated native resource operations`, async () => {
    const calls = [];
    const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: { resourceId: 'mcp-local-fixture' } }; } } };
    const client = create(connection, { window: { location: { origin: 'http://localhost', hash: '' } } });
    const payload = { displayName: 'Fixture', transport: 'stdio' };
    assert.equal((await client.createMcpResource(payload)).resourceId, 'mcp-local-fixture');
    assert.deepEqual(calls, [['/agentkit', 'mcp/create', payload]]);
  });
}

test('compatibility streams share session exchange and CSRF with ordinary reads and preserve cancellation', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const body = new ReadableStream({ start(controller) { controller.close(); } });
  const window = { location: { origin: 'http://localhost', hash: '' },
    __AGENTKIT_STUDIO__: { controlPlane: 'legacy-host', hostUrl: 'http://legacy.invalid', sessionToken: 'test-session-token' },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/system/session')) return { ok: true, text: async () => JSON.stringify({ csrfToken: 'test-csrf' }) };
      if (url.includes('/conversation-surface')) return { ok: true, text: async () => JSON.stringify({ buildId: 'build-fixture' }) };
      if (url.includes('/conversation:stream')) return { ok: true, body };
      return { ok: true, text: async () => '{}' };
    },
  };
  const client = createHostRemote(undefined, { window });
  await client.createAgent({ name: 'Fixture' });
  const result = await client.streamAgentConversation('agent/fixture', 'session/fixture', { idempotencyKey: 'fixture-key', input: 'fixture' }, signal);
  assert.equal(result.body, body);
  assert.equal(calls.filter(call => call.url.endsWith('/system/session')).length, 1);
  const stream = calls.at(-1);
  assert.equal(stream.init.signal, signal);
  assert.equal(stream.init.headers.get('X-CSRF-Token'), 'test-csrf');
  assert.equal(stream.init.headers.get('X-AgentKit-Session'), 'test-session-token');
  assert.equal(stream.init.headers.get('Idempotency-Key'), 'fixture-key');
  assert.equal(stream.init.headers.get('Accept'), 'text/event-stream');
  assert.equal(stream.init.credentials, 'include');
  assert.equal(client.baseUrl, 'http://legacy.invalid');
});

test('product client exposes the DSH plugin lifecycle the market row calls', async () => {
  // app.mjs mounts the plain product client directly; lifecycle methods that
  // only exist in the compatibility extension are undefined at runtime.
  const calls = [];
  const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: { note: 'fixture' } }; } } };
  const client = createProductClient(connection, { window: { location: { origin: 'http://localhost', hash: '' } } });
  for (const name of ['dshPlugins', 'refreshDshPluginIndex', 'installDshPlugin', 'enableDshPlugin', 'disableDshPlugin', 'updateDshPlugin', 'uninstallDshPlugin']) {
    assert.equal(typeof client[name], 'function', `${name} must be defined on the product client`);
  }
  await client.enableDshPlugin('@deepseek-ai/dsh-experimental-agent-team-profile');
  assert.deepEqual(calls, [['/agentkit', 'plugins/dsh-enable', { pluginName: '@deepseek-ai/dsh-experimental-agent-team-profile' }]]);
});
