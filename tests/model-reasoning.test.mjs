import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_REASONING_WIRE, studioCodexReasoningWire, studioReasoning, studioReasoningWire } from '../src/model-reasoning.mjs';
import { createModelBridge } from '../src/client/dsh/model-bridge.mjs';
import { syncPortableModelProfiles } from '../src/portable-model-bridge.mjs';

test('an enabled profile publishes the three DeepSeek thinking levels and defaults to high', () => {
  assert.deepEqual(studioReasoning({ reasoningEfforts: true }), {
    efforts: STUDIO_REASONING_WIRE,
    defaultEffort: 'high',
  });
  assert.deepEqual(Object.keys(studioReasoning({ reasoningEfforts: true }).efforts), ['low', 'high', 'max']);
  assert.equal(studioReasoning({ reasoningEfforts: true, defaultReasoningEffort: 'max' }).defaultEffort, 'max');
  // A level outside the three is ignored rather than forwarded to a gateway
  // that never declared it.
  assert.deepEqual(studioReasoning({ reasoningEfforts: { medium: 'medium', high: 'high' } }), {
    efforts: { high: 'high' }, defaultEffort: 'high',
  });
  assert.equal(studioReasoning({ reasoningEfforts: { medium: 'medium' } }), null);
  assert.equal(studioReasoning({}), null);
  assert.equal(studioReasoning({ reasoningEfforts: false }), null);
});

test('off is never selectable and Codex narrows max to its own enum', () => {
  assert.equal(studioReasoningWire({ reasoningEfforts: true }, 'off'), undefined);
  assert.equal(studioReasoningWire({ reasoningEfforts: true }, 'max'), 'max');
  assert.equal(studioReasoningWire({ reasoningEfforts: true }, 'medium'), undefined);
  assert.equal(studioCodexReasoningWire('low'), 'low');
  assert.equal(studioCodexReasoningWire('max'), 'high');
  assert.equal(studioCodexReasoningWire('off'), undefined);
});

test('the client bridge declares reasoning on the routed model only', async () => {
  const providers = {}, writes = [];
  const ctx = { remote: {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [
        { ns: 'llm-pi-ai', value: { providers }, revision: 3 },
        { ns: 'agent-default-model', revision: 3 },
      ] } }),
      mutate: async (ns, operations) => {
        writes.push([ns, operations]);
        if (ns === 'llm-pi-ai') for (const op of operations) providers[op.path[1]] = op.value;
        return { ok: true };
      },
    },
    credentials: { set: async () => ({ ok: true }) },
  } };
  const bridge = createModelBridge({ hostRemote: {
    modelCatalog: async () => ({ items: [
      { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek', input: ['text'] },
      { id: 'seedream-5.0', name: 'Seedream', input: ['text', 'image'] },
    ] }),
  } }).createDshModelBridge(ctx, { isActive: () => true });

  await bridge.applyProfiles({ profiles: [{
    id: 'reasoner', provider: 'ksyun', modelName: 'deepseek-v4.1-flash-1017',
    baseUrl: 'http://kspmas.ksyun.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY',
    reasoningEfforts: true, defaultReasoningEffort: 'high',
  }] });

  const provider = providers['agentkit-studio-reasoner'];
  assert.equal(provider.reasoning, 'high');
  const routed = provider.models.find(model => model.id === 'deepseek-v4.1-flash-1017');
  assert.deepEqual(routed.reasoningEfforts, { low: 'low', high: 'high', max: 'max' });
  // The sibling catalog entry must not inherit a capability its profile never
  // declared, or picking it would promise reasoning the gateway cannot do.
  assert.equal(provider.models.find(model => model.id === 'seedream-5.0').reasoningEfforts, undefined);
  assert.equal(writes.filter(([ns]) => ns === 'llm-pi-ai').length, 1);
});

test('the portable bridge publishes the same declaration', async () => {
  const providers = {};
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 2, value: { providers } }],
    mutate: async (ns, operations) => {
      assert.equal(ns, 'llm-pi-ai');
      for (const op of operations) providers[op.path[1]] = op.value;
    },
  };
  await syncPortableModelProfiles({ settings, profiles: [{
    id: 'portable', provider: 'ksyun', modelName: 'deepseek-v4.1-flash',
    baseUrl: 'http://kspmas.ksyun.com/v1', credentialName: 'KEY', reasoningEfforts: true,
  }] });
  const value = providers['agentkit-studio-portable'];
  assert.equal(value.reasoning, 'high');
  assert.deepEqual(value.models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' });

  await syncPortableModelProfiles({ settings, profiles: [{
    id: 'plain', provider: 'ksyun', modelName: 'seedream-5.0',
    baseUrl: 'http://kspmas.ksyun.com/v1', credentialName: 'KEY',
  }] });
  assert.equal(providers['agentkit-studio-plain'].models[0].reasoningEfforts, undefined);
});
