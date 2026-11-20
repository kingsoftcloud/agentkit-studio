import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createModelService } from '../src/model-service.mjs';

function configuration(values) {
  return {
    async resolve() { return { values }; },
    async describe() { return { modelProfiles: values.modelProfiles }; },
    async update() {},
  };
}

test('resource creation adds an independently credentialed model profile without replacing existing profiles', async () => {
  const values = { modelProfiles: [{ id: 'existing', provider: 'ksyun', modelName: 'old', baseUrl: 'https://old.test/v1', credentialName: 'OLD_KEY', default: true }] };
  const config = configuration(values);
  config.update = async patch => Object.assign(values, patch);
  const service = createModelService({ configuration: config, credentials: { resolve: async () => ({value:'key',source:'env'}), set: async () => {} } });
  await service.create({name:'new-model',displayName:'New model',spec:{model:'chat',endpointUrl:'https://new.test/v1/chat/completions',credentialRef:'env://NEW_KEY'}});
  assert.equal(values.modelProfiles.length,2);
  assert.equal(values.modelProfiles[0].default,true);
  assert.deepEqual(values.modelProfiles[1],{id:'new-model',displayName:'New model',provider:'openai-compatible',modelName:'chat',baseUrl:'https://new.test/v1',credentialName:'NEW_KEY',enabled:true,default:false});
  assert.equal((await service.profile('new-model')).credentialName,'NEW_KEY');
  await assert.rejects(()=>service.create({name:'new-model',spec:{model:'chat',endpointUrl:'https://new.test/v1'}}),{code:'MODEL_PROFILE_EXISTS'});
});

test('model service resolves independent provider credentials and catalog capabilities', async () => {
  const calls = [];
  const service = createModelService({
    configuration: configuration({ modelProfiles: [
      { id: 'ksyun-vision', provider: 'ksyun', modelName: 'vision', baseUrl: '', credentialName: 'KEY_KSYUN', enabled: true },
      { id: 'openai-text', provider: 'openai', modelName: 'gpt', baseUrl: 'https://example.test/v1', credentialName: 'KEY_OPENAI', enabled: true },
    ] }),
    credentials: { resolve: async name => ({ value: name === 'KEY_KSYUN' ? 'secret-1' : 'secret-2' }) },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, async json() { return { data: [
        { id: 'vision', architecture: { input_modalities: ['文字', '图片', '视频', '文件'] } },
        { id: 'text', input_modalities: ['text'] },
      ] }; } };
    },
  });
  const catalog = await service.catalog('ksyun-vision');
  assert.deepEqual(catalog.items, [
    { id: 'vision', name: 'vision', input: ['text', 'image'] },
    { id: 'text', name: 'text', input: ['text'] },
  ]);
  assert.equal(calls[0].url, 'http://kspmas.ksyun.com/v1/models');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-1');
  const second = await service.profile('openai-text');
  assert.equal(second.baseUrl, 'https://example.test/v1');
  assert.equal(second.apiKey, 'secret-2');
  const byModelName = await service.profile('gpt');
  assert.equal(byModelName.id, 'openai-text');
  assert.equal(byModelName.modelName, 'gpt');
});

test('model endpoint probe reads an unsaved catalog with the candidate key and does not persist it', async () => {
  const values = { modelProfiles: [{ id: 'existing', provider: 'ksyun', modelName: 'old', baseUrl: 'https://old.test/v1', credentialName: 'OLD_KEY', default: true }] };
  const calls = [];
  const service = createModelService({
    configuration: configuration(values),
    credentials: { resolve: async () => ({ value: 'stored-key' }), set: async () => {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, async json() { return { data: [{ id: 'candidate-model', architecture: { input_modalities: ['text', 'image'] } }] }; } };
    },
  });
  const result = await service.probe({ provider: 'openai', baseUrl: 'https://candidate.test/v1', apiKey: 'unsaved-key', modelName: 'candidate-model' });
  assert.equal(result.selectedAvailable, true);
  assert.deepEqual(result.items[0], { id: 'candidate-model', name: 'candidate-model', input: ['text', 'image'] });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer unsaved-key');
  assert.deepEqual(values.modelProfiles, [{ id: 'existing', provider: 'ksyun', modelName: 'old', baseUrl: 'https://old.test/v1', credentialName: 'OLD_KEY', default: true }]);
});

test('the saved provider catalog keeps endpoint and headers bound to the stored credential', async () => {
  const connection = { id: 'research', provider: 'custom', baseUrl: 'https://gateway.test/v1', credentialName: 'RESEARCH_KEY',
    apiKey: 'fixture-key', headers: { 'X-Project': 'research' } };
  const calls = [];
  const service = createModelService({
    configuration: configuration({ modelConnections: [connection] }),
    credentials: { resolve: async () => ({ value: 'old-fixture-key', source: 'file' }), set: async () => {} },
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, json: async () => ({ data: [{ id: 'available-model' }] }) };
    },
  });
  const result = await service.probe({ connectionId: connection.id, baseUrl: 'https://different.test/v1', headers: { 'X-Project': 'other' } });
  assert.deepEqual(calls, [{ url: 'https://gateway.test/v1/models', headers: { Authorization: 'Bearer fixture-key', 'X-Project': 'research' } }]);
  assert.equal(result.items[0].id, 'available-model');
  assert.equal(JSON.stringify(result).includes('fixture-key'), false);
  await assert.rejects(service.probe({ connectionId: 'missing' }), { code: 'MODEL_CONNECTION_NOT_FOUND' });
  assert.equal(calls.length, 1);
});

test('a connection probe projects advertised thinking levels and keeps unknown models unspecified', async () => {
  const service = createModelService({
    configuration: configuration({}),
    credentials: { resolve: async () => ({}), set: async () => {} },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [
      { id: 'limited', reasoning_efforts: ['low', 'medium', 'unrecognized'], default_reasoning_effort: 'medium' },
      { id: 'nested', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } },
      { id: 'flag', supports_reasoning_effort: true, default_reasoning_effort: 'high' },
      { id: 'plain', supports_reasoning_effort: false },
      { id: 'unknown' },
    ] }) }),
  });
  const { items } = await service.probe({ provider: 'openai', baseUrl: 'https://gateway.test/v1', apiKey: 'fixture-key' });
  assert.deepEqual(items.map(item => [item.id, item.reasoningLevels, item.defaultReasoningEffort]), [
    ['limited', ['low', 'medium'], 'medium'], ['nested', ['low', 'high', 'max'], 'high'],
    ['flag', undefined, 'high'], ['plain', [], undefined], ['unknown', undefined, undefined],
  ]);
});

test('effort probing uses the saved profile endpoint, authentication headers and Messages wire', async () => {
  const requests = [];
  const profile = { id: 'model', modelName: 'saved-model', provider: 'custom', baseUrl: 'https://gateway.test/v1',
    credentialName: 'MODEL_KEY', protocol: 'anthropic-messages', headers: { 'X-Project': 'research' } };
  const service = createModelService({
    configuration: configuration({ modelProfiles: [profile] }),
    credentials: { resolve: async () => ({ value: 'fixture-key' }) },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: url.href, headers: options.headers, body });
      const supported = ['medium', 'max'].includes(body.output_config.effort);
      return new Response(JSON.stringify(supported ? { type: 'message', content: [] }
        : { error: { message: 'Invalid output_config.effort' } }), { status: supported ? 200 : 400 });
    },
  });
  const result = await service.probeEfforts({ profileId: 'model', modelName: 'saved-model', baseUrl: 'https://different.test/v1' });
  assert.equal(result.modelName, 'saved-model');
  assert.equal(result.wire, 'anthropic-messages');
  assert.deepEqual(result.outcomes, [
    { level: 'low', outcome: 'rejected' }, { level: 'medium', outcome: 'accepted' }, { level: 'high', outcome: 'rejected' },
    { level: 'xhigh', outcome: 'rejected' }, { level: 'max', outcome: 'accepted' },
  ]);
  assert.ok(requests.every(({ url, body, headers }) => url === 'https://gateway.test/v1/messages' && body.model === 'saved-model'
    && headers.get('x-api-key') === 'fixture-key' && headers.get('x-project') === 'research'));
});

test('wire checks bind saved credentials to their connection and leave uncertain Responses unchecked', async () => {
  const connection = { id: 'gateway', provider: 'ksyun', baseUrl: 'https://gateway.test/v1', credentialName: 'MODEL_KEY', headers: { 'X-Project': 'research' } };
  const requests = [];
  const service = createModelService({
    configuration: configuration({ modelConnections: [connection] }),
    credentials: { resolve: async () => ({ value: 'fixture-key' }) },
    fetchImpl: async (url, options) => {
      const { model } = JSON.parse(options.body);
      requests.push({ url: url.href, auth: options.headers.get('authorization'), project: options.headers.get('x-project') });
      if (model === 'responses') return Response.json({ output: [] });
      return Response.json({ error: {} }, { status: model === 'chat' ? 404 : 429 });
    },
  });
  const identity = { connectionId: 'gateway', baseUrl: 'https://different.test/v1' };
  const { items } = await service.probeWire({ ...identity, models: ['responses', 'chat', 'limited'] });
  assert.deepEqual(items.map(item => item.wire), ['openai-responses', 'openai-completions', 'unknown']);
  const report = await service.probeEfforts({ ...identity, modelName: 'limited', detectWire: true });
  assert.equal(report.wire, 'unknown');
  assert.ok(report.outcomes.every(item => item.outcome === 'untested'));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ url, auth, project }) => url === 'https://gateway.test/v1/responses' && auth === 'Bearer fixture-key' && project === 'research'));
});

test('model service returns typed errors for missing credentials and unknown profiles', async () => {
  const service = createModelService({
    configuration: configuration({ modelProfiles: [{ id: 'missing', provider: 'custom', modelName: 'm', baseUrl: 'https://example.test/v1', credentialName: 'KEY_MISSING', enabled: true }] }),
    credentials: { resolve: async () => ({ value: '' }) },
  });
  await assert.rejects(() => service.profile('missing'), error => error.code === 'MODEL_CREDENTIAL_MISSING' && error.status === 409);
  await assert.rejects(() => service.profile('unknown'), error => error.code === 'MODEL_NOT_FOUND' && error.status === 404);
});

test('a model advertised by the configured gateway uses that profile credential without changing its default', async () => {
  const values = { modelProfiles: [{ id: 'gateway', modelName: 'model-a', baseUrl: 'https://example.test/v1', credentialName: 'GATEWAY', default: true }, { id: 'disabled', modelName: 'off', enabled: false }] };
  const service = createModelService({ configuration: configuration(values), credentials: { resolve: async name => ({ value: name === 'GATEWAY' ? 'test-key' : '' }) }, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) }) });
  const selected = await service.profile('model-b');
  assert.equal(selected.modelName, 'model-b'); assert.equal(selected.id, 'gateway'); assert.equal(selected.credentialName, 'GATEWAY');
  assert.equal((await service.profile('')).modelName, 'model-a');
  await assert.rejects(service.profile('unlisted'), { code: 'MODEL_NOT_FOUND' });
  await assert.rejects(service.profile('disabled'), { code: 'MODEL_NOT_FOUND' });
});

test('legacy credential-only configuration resolves the same default model advertised by settings', async () => {
  const service = createModelService({ configuration: configuration({ modelApiKey: 'legacy-key' }),
    credentials: { resolve: async () => null } });
  const selected = await service.profile('');
  assert.equal(selected.id, 'default');
  assert.equal(selected.modelName, 'deepseek-v4.1-flash');
  assert.equal(selected.apiKey, 'legacy-key');
});

test('an admitted gateway model survives catalog expiry but still refreshes credentials and honors revocation', async () => {
  let reads = 0, key = 'first', down = false;
  const gateway = { id: 'gateway', default: true, provider: 'ksyun', modelName: 'base', baseUrl: 'https://gateway.invalid/v1' };
  const values = { modelProfiles: [gateway] };
  const service = createModelService({ configuration: { resolve: async () => ({ values }) },
    credentials: { resolve: async () => ({ value: key }) }, fetchImpl: async () => {
      reads++; if (down) throw Error('catalog unavailable');
      return Response.json({ data: [{ id: 'directory-model' }] });
    } });
  const selected = await service.profile('directory-model'); assert.equal(reads, 1);
  const admittedModel = { profileId: selected.id, modelName: selected.modelName };
  down = true; key = 'rotated';
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 61000;
    const current = await service.profile('directory-model', { admittedModel });
    assert.equal(current.apiKey, 'rotated'); assert.equal(reads, 1);
    await assert.rejects(service.profile('unknown'), /catalog unavailable/);
    await assert.rejects(service.profile('directory-model', { admittedModel: { ...admittedModel, profileId: 'other' } }), /catalog unavailable/);
    values.modelProfiles.push({ ...gateway, id: 'disabled-model', modelName: 'directory-model', enabled: false });
    await assert.rejects(service.profile('directory-model', { admittedModel }), { code: 'MODEL_NOT_FOUND' });
  } finally { Date.now = originalNow; }
});

test('the wire probe resolves the stored credential and never writes configuration', async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp', status: 'completed', output: [] }));
    });
  });
  const requests = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let updated = 0;
  try {
    const service = createModelService({
      configuration: { ...configuration({ modelProfiles: [] }), update: async () => { updated += 1; } },
      credentials: { resolve: async name => ({ value: name === 'GATEWAY_KEY' ? 'sk-stored' : '', source: 'env' }), set: async () => {} },
    });
    const result = await service.probeWire({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1/`,
      modelName: 'kimi-k3.1-pro',
      credentialName: 'GATEWAY_KEY',
    });
    assert.deepEqual(result, {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelName: 'kimi-k3.1-pro',
      wire: 'openai-responses',
    });
    // The stored credential is used, and the probe is read-only.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, 'Bearer sk-stored');
    assert.equal(requests[0].url, '/v1/responses');
    assert.equal(updated, 0, 'a probe must never write configuration');
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
});

test('the wire probe rejects an incomplete candidate before touching the network', async () => {
  const service = createModelService({
    configuration: configuration({ modelProfiles: [] }),
    credentials: { resolve: async () => ({ value: 'sk', source: 'env' }), set: async () => {} },
  });
  await assert.rejects(() => service.probeWire({ baseUrl: 'https://gw.test/v1', modelName: '  ' }), { code: 'MODEL_PROBE_INPUT_INVALID' });
  await assert.rejects(() => service.probeWire({ baseUrl: '', modelName: 'm' }), { code: 'MODEL_PROBE_INPUT_INVALID' });
});
