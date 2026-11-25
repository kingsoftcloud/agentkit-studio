import test from 'node:test';
import assert from 'node:assert/strict';
import { providerDisplayName } from '../src/model-reasoning.mjs';
import { createModelBridge, DSH_MODEL_SETTINGS_NS, DSH_DEFAULT_MODEL_SETTINGS_NS } from '../src/client/dsh/model-bridge.mjs';

test('the route label prefers the connection name over the provider id', () => {
  assert.equal(providerDisplayName({ provider: 'custom', connectionName: '星流' }), '星流');
  assert.equal(providerDisplayName({ provider: 'custom' }), '自定义');
  assert.equal(providerDisplayName({ provider: 'ksyun' }), '金山云模型服务');
  assert.equal(providerDisplayName({ provider: 'openai' }), 'OpenAI');
  assert.equal(providerDisplayName({ provider: 'deepseek' }), 'DeepSeek');
  assert.equal(providerDisplayName({ provider: 'some-gateway' }), 'some-gateway');
  assert.equal(providerDisplayName({}), '自定义');
});

// A custom provider used to be published to DSH as `custom · model`, which is
// what showed in the model selector. The published displayName must use the
// connection name instead.
test('a custom provider is published to DSH with the connection name, not "custom"', async () => {
  const profile = { id: 'p1', provider: 'custom', modelName: 'glm-5.3', baseUrl: 'http://kspmas.ksyun.com/v1', connectionName: '星流', credentialName: 'KEY', enabled: true, default: true, input: ['text'] };
  const namespaces = [
    { ns: DSH_MODEL_SETTINGS_NS, revision: 1, value: { providers: {} } },
    { ns: DSH_DEFAULT_MODEL_SETTINGS_NS, revision: 1, value: {} },
  ];
  const writes = [];
  const bridge = createModelBridge({
    hostRemote: { modelCatalog: async () => ({ items: [{ id: 'glm-5.3', name: 'glm-5.3', input: ['text'] }] }) },
  }).createDshModelBridge({ remote: { settings: {
    describe: async () => ({ ok: true, value: { namespaces } }),
    mutate: async (ns, ops) => { writes.push({ ns, ops }); return { ok: true }; },
  }, credentials: { set: () => {} } } });
  await bridge.applyProfiles({ profiles: [profile] });
  const value = writes[0].ops.find(op => op.op === 'set').value;
  assert.equal(value.displayName, '星流 · glm-5.3');
  assert.ok(!value.displayName.startsWith('custom'));
});
