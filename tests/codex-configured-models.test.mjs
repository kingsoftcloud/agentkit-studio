import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfiguredCodexModel, selectCodexAgentModel, listCodexAgentModels } from '../src/providers/codex-configured-models.mjs';

function services() {
  const profiles = ['a', 'b'].map(id => ({ id, provider: 'compatible', modelName: 'same-model', enabled: true, baseUrl: `https://${id}.example/v1`, apiKey: `key-${id}`, credentialName: `KEY_${id}` }));
  const models = {
    settings: async () => ({ modelProfiles: profiles.map(({ apiKey, ...profile }) => profile) }),
    profile: async id => {
      const profile = profiles.find(item => item.id === id);
      if (!profile) throw Object.assign(new Error('missing'), { code: 'MODEL_NOT_FOUND' });
      return profile;
    },
    catalog: async id => ({ items: [{ id: `extra-${id}` }], defaultModel: 'a' }),
  };
  const catalog = { list: async () => ({ items: [{ resourceId: 'codex-native' }], defaultModel: 'codex-native' }) };
  return { models, catalog, profiles };
}

test('Codex uses the exact selected profile and its credentials, including catalog models', async () => {
  const { models } = services();
  assert.deepEqual(await resolveConfiguredCodexModel({ provider: 'agentkit-studio-b', model: 'same-model' }, models), {
    model: 'same-model', modelProvider: { baseUrl: 'https://b.example/v1', apiKey: 'key-b' },
  });
  assert.equal((await resolveConfiguredCodexModel({ provider: 'agentkit-studio-b', model: 'extra-b' }, models)).model, 'extra-b');
  await assert.rejects(resolveConfiguredCodexModel({ provider: 'agentkit-studio-b', model: 'extra-a' }, models), { code: 'CODEX_MODEL_UNAVAILABLE' });
  await assert.rejects(resolveConfiguredCodexModel({ provider: 'other', model: 'same-model' }, models), { code: 'CODEX_MODEL_PROVIDER_UNAVAILABLE' });
});

test('disabled and colliding provider routes cannot redirect a Codex credential', async () => {
  const { models, profiles } = services();
  profiles[1].enabled = false;
  await assert.rejects(resolveConfiguredCodexModel({ provider: 'agentkit-studio-b', model: 'same-model' }, models), { code: 'CODEX_MODEL_PROVIDER_UNAVAILABLE' });
  profiles.push({ ...profiles[0], id: 'A' });
  await assert.rejects(resolveConfiguredCodexModel({ provider: 'agentkit-studio-a', model: 'same-model' }, models), { code: 'CODEX_MODEL_PROVIDER_UNAVAILABLE' });
});

test('gateway-bound Codex admission does not require the native account catalog', async () => {
  const { models } = services();
  const catalog = { list: () => { throw new Error('should not read native account'); } };
  assert.deepEqual(await selectCodexAgentModel({ spec: { bindings: { modelProfileId: 'b' } } }, { models, catalog }), { provider: 'agentkit-studio-b', model: 'same-model' });
});

test('native Codex bindings keep their existing provider and configured default', async () => {
  const services_ = services();
  assert.deepEqual(await selectCodexAgentModel({ spec: { bindings: { modelProfileId: 'codex-native' } } }, services_), { provider: 'agentkit-studio-codex', model: 'codex-native' });
  assert.deepEqual(await selectCodexAgentModel({}, services_), { provider: 'agentkit-studio-codex', model: 'codex-native' });
});

test('Agent editor exposes both catalogs without credentials and survives native catalog failure', async () => {
  const services_ = services();
  const both = await listCodexAgentModels(services_);
  assert.deepEqual(both.items.map(item => item.resourceId), ['codex-native', 'a', 'b', 'extra-']);
  assert.ok(!JSON.stringify(both).includes('key-a'));
  services_.catalog.list = async () => { throw Object.assign(new Error('offline'), { code: 'CODEX_PROVIDER_UNAVAILABLE' }); };
  const gateway = await listCodexAgentModels(services_);
  assert.equal(gateway.items[0].resourceId, 'a');
  assert.equal(gateway.defaultModel, 'a');
  assert.equal(gateway.warnings[0].code, 'CODEX_PROVIDER_UNAVAILABLE');
});
