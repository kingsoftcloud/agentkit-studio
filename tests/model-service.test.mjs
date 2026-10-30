import test from 'node:test';
import assert from 'node:assert/strict';
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
