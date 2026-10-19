import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudRuntimeFetch } from '../src/cloud-runtime-fetch.mjs';

const runtime = 'https://ar-20261019105049-0f164abe.agent-pre.kspmas.ksyun.com';

test('preprod runtime exception follows current environment and refuses redirects', async () => {
  let region = 'pre-online', created = 0;
  let destroyed = false;
  const calls = [], dispatcher = { destroy: async () => { destroyed = true; } };
  const transport = createCloudRuntimeFetch({
    configuration: Promise.resolve({ resolve: async () => ({ values: { cloudRegion: region } }) }),
    createDispatcher: () => { created++; return dispatcher; },
    fetchImpl: async (input, init) => { calls.push({ input, init }); return new Response('{}'); },
  });
  const init = { method: 'POST', body: '{}', headers: { Authorization: 'Bearer synthetic-runtime-token' }, redirect: 'follow' };
  await transport(runtime + '/v1/assistant/submit', init);
  assert.equal(calls[0].init.dispatcher, dispatcher);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.body, init.body);
  assert.equal(init.redirect, 'follow');
  await transport(new Request(runtime + '/v1/agentkit/runtime'));
  assert.equal(created, 1);
  region = 'cn-beijing-6';
  await transport(runtime + '/health', init);
  assert.equal(calls[2].init, init, 'switching to online restores normal fetch immediately');
  await transport.close();
  assert.equal(destroyed, true);
  await assert.rejects(transport(runtime + '/health'), { code: 'RUNTIME_TRANSPORT_CLOSED' });
});

for (const url of [
  'https://ar-demo.agent.kspmas.ksyun.com/v1/assistant/snapshot',
  'https://aicp.api.ksyun.com/',
  'https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/feed.yml',
  'https://ar-demo.agent-pre.kspmas.ksyun.com.evil.example/health',
  'https://agent-pre.kspmas.ksyun.com/health',
  'https://other.agent-pre.kspmas.ksyun.com/health',
  'https://ar-demo.agent-pre.internal.kspmas.ksyun.com/health',
  'https://ar-demo.agent-pre.kspmas.ksyun.com:8443/health',
  'https://user@ar-demo.agent-pre.kspmas.ksyun.com/health',
  'http://ar-demo.agent-pre.kspmas.ksyun.com/health',
]) {
  test(`preprod TLS exception excludes ${url}`, async () => {
    const init = { signal: new AbortController().signal };
    const transport = createCloudRuntimeFetch({
      configuration: { resolve: async () => ({ values: { cloudRegion: 'pre-online' } }) },
      createDispatcher: () => { throw Error('TLS exception must not be created'); },
      fetchImpl: async (input, options) => { assert.equal(options, init); return new Response('{}'); },
    });
    await transport(url, init);
  });
}
