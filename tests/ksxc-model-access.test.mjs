import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createKsxcModelAccess } from '../src/host/services/ksxc-model-access.mjs';
import { createKsxcRoute } from '../src/host/routes/ksxc.mjs';
import { createDshRuntimeAdapter, bindDshAgentRoute, routeDshRuntime, setDshRuntimeAdapter } from '../src/providers/dsh-runtime.mjs';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';

const companyConfig = { code: 'fixture-company', baseUrl: 'https://models.example' };

test('KSXC desktop catalog and Responses attach the grant only at the configured gateway', async t => {
  let connection = null;
  const calls = [];
  const upstream = 'data: {"type":"response.output_text.delta","delta":"fixture"}\n\n';
  const modelAccess = createKsxcModelAccess({ companyConfig, connection: async () => connection,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (new URL(url).pathname === '/cli/models') {
        return Response.json({ code: 200, data: [
          { model: 'team/fixture', displayName: 'Fixture Model' }, { model: 'hidden', hidden: true },
        ] });
      }
      return new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
  t.after(() => modelAccess.close());
  assert.deepEqual(await modelAccess.list(), []);
  assert.equal(calls.length, 0);
  connection = { accountId: 'first', token: randomUUID() };
  const firstToken = connection.token;
  assert.deepEqual(await modelAccess.list(), [{ id: 'team/fixture', name: 'Fixture Model', provider: 'ksxc' }]);
  await assert.rejects(modelAccess.profile('hidden'), { code: 'KSXC_MODEL_FORBIDDEN' });
  const profile = await modelAccess.profile('team/fixture');
  assert.equal(profile.protocol, 'openai-responses');
  assert.ok(!JSON.stringify(profile).includes(firstToken));
  const input = [{ type: 'function_call', name: 'read_file', call_id: 'read-1', arguments: '{}' },
    { type: 'function_call_output', call_id: 'read-1', output: 'read-result' }];
  const send = (apiKey = profile.apiKey, headers = {}) => fetch(profile.baseUrl + '/responses', {
    method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, ...headers },
    body: JSON.stringify({ model: 'different-model', input, stream: true }),
  });
  assert.equal((await send('wrong')).status, 401);
  assert.equal((await send(profile.apiKey, { Origin: 'https://browser.example' })).status, 401);
  assert.equal(calls.length, 1);
  const response = await send();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), upstream);
  const [catalog, inference] = calls;
  assert.equal(catalog.url, 'https://models.example/cli/models');
  assert.equal(inference.url, 'https://models.example/v1/responses');
  for (const { options } of calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + firstToken);
    assert.equal(options.headers['X-KSC-COMPANY-CODE'], companyConfig.code);
    assert.match(options.headers['X-KSC-REQUEST-ID'], /^[a-f0-9-]{36}$/);
  }
  assert.deepEqual(JSON.parse(inference.options.body), { model: 'team/fixture', input, stream: true });
  connection = { accountId: 'second', token: randomUUID() };
  assert.equal((await send()).status, 403);
  connection = null;
  assert.equal((await send()).status, 401);
  assert.equal(calls.filter(call => call.url.endsWith('/responses')).length, 1);
});

test('KSXC login and disconnect refresh the existing KSXC model group', async () => {
  const changes = [];
  let result = { status: 'pending' };
  const route = createKsxcRoute({
    releases: {}, accounts: { poll: async () => result, disconnect: async () => ({ connected: false }) },
    modelAccess: { invalidate: () => changes.push('cache') },
  }, () => changes.push('catalog'));
  await route('ksxc/login-result', {});
  assert.deepEqual(changes, []);
  result = { status: 'connected' };
  await route('ksxc/login-result', {});
  await route('ksxc/disconnect', {});
  assert.deepEqual(changes, ['cache', 'catalog', 'cache', 'catalog']);
});

test('KSXC models follow the local runtime in Studio with a scoped model profile', async () => {
  const bridge = createRuntimeBridge();
  const chosen = { id: 'ksxc:fixture', modelName: 'fixture', protocol: 'openai-responses',
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: randomUUID() };
  const received = [];
  const record = async function* (input) { received.push(input); yield { type: 'text', text: 'okay' }; };
  setDshRuntimeAdapter(createDshRuntimeAdapter({ bridge, ksxcModelAccess: {
    profile: async model => { assert.equal(model, 'fixture'); return chosen; },
  }, codexRuntime: { stream: record }, nativeEngineRuntime: { stream: record,
    requiresServiceWorkspace: true, managesWorkspace: cwd => cwd === process.cwd() },
  }), bridge);
  const request = { provider: 'ksxc', model: 'fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'Use this model' }] }] };
  const turn = (runtime, { local = true, cwd = process.cwd(), buildId } = {}, next = () => assert.fail('unexpected model-only dispatch')) => {
    const sessionId = randomUUID();
    bindDshAgentRoute(sessionId, { agentId: 'fixture-agent', runtime, local, buildId, agentRevision: 1,
      agent: { session: { id: sessionId, header: { cwd } } } }, bridge);
    return routeDshRuntime({ ...request, sessionId }, next, bridge, () => true);
  };
  assert.equal(turn('dsh-native', {}, () => 'model-only'), 'model-only');
  await Array.fromAsync(turn('codex'));
  await Array.fromAsync(turn('native-engine'));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0].modelProvider, { ...chosen, hostedWebSearch: false });
  assert.equal(received[1].workspaceModelProfile, chosen);
  await assert.rejects(Array.fromAsync(turn('native-engine', { cwd: '/external-workspace' })), { code: 'KSXC_HOST_UNAVAILABLE' });
  await assert.rejects(Array.fromAsync(turn('codex', { local: false })), { code: 'KSXC_HOST_UNAVAILABLE' });
});
