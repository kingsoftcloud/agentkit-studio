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
        { id: 'vision', input_modalities: ['text', 'image'] },
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
