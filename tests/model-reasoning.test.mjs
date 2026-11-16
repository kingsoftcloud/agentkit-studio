import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REASONING_FALLBACK_PROFILE, REASONING_PROFILES, applyReasoningFallback, isReasoningEffortRejection,
  reasoningProfileFor, studioCodexReasoningWire, studioReasoning, studioReasoningFallbackWire, studioReasoningWire,
} from '../src/model-reasoning.mjs';
import { createModelBridge } from '../src/client/dsh/model-bridge.mjs';
import { syncPortableModelProfiles } from '../src/portable-model-bridge.mjs';

test('the capability table is the single source of provider levels and wire values', () => {
  assert.deepEqual(REASONING_PROFILES.ksyun.levels, ['low', 'high', 'max']);
  assert.deepEqual(REASONING_PROFILES.ksyun.wire, { low: 'low', high: 'high', max: 'max' });
  assert.equal(REASONING_PROFILES.ksyun.default, 'high');

  assert.deepEqual(REASONING_PROFILES.deepseek.levels, ['low', 'high', 'max']);
  assert.deepEqual(REASONING_PROFILES.deepseek.wire, { low: 'low', high: 'high', max: 'max' });
  assert.equal(REASONING_PROFILES.deepseek.default, 'high');

  assert.deepEqual(REASONING_PROFILES.openai.levels, ['low', 'medium', 'high']);
  assert.deepEqual(REASONING_PROFILES.openai.wire, { low: 'low', medium: 'medium', high: 'high' });
  assert.equal(REASONING_PROFILES.openai.default, 'medium');

  assert.deepEqual(REASONING_PROFILES.codex.levels, ['low', 'high', 'max']);
  assert.deepEqual(REASONING_PROFILES.codex.wire, { low: 'low', medium: 'medium', high: 'high', max: 'high' });
  assert.equal(REASONING_PROFILES.codex.default, 'high');

  assert.equal(reasoningProfileFor('openai'), REASONING_PROFILES.openai);
  // Provider ids are matched case-insensitively around incidental whitespace.
  assert.equal(reasoningProfileFor(' OpenAI '), REASONING_PROFILES.openai);
});

test('an enabled profile publishes only the levels its provider accepts', () => {
  assert.deepEqual(studioReasoning({ provider: 'ksyun', reasoningEfforts: true }), {
    efforts: { low: 'low', high: 'high', max: 'max' }, defaultEffort: 'high',
  });
  assert.deepEqual(studioReasoning({ provider: 'deepseek', reasoningEfforts: true }), {
    efforts: { low: 'low', high: 'high', max: 'max' }, defaultEffort: 'high',
  });
  assert.deepEqual(studioReasoning({ provider: 'openai', reasoningEfforts: true }), {
    efforts: { low: 'low', medium: 'medium', high: 'high' }, defaultEffort: 'medium',
  });
  assert.deepEqual(studioReasoning({ provider: 'codex', reasoningEfforts: true }), {
    efforts: { low: 'low', high: 'high', max: 'high' }, defaultEffort: 'high',
  });
  // A pinned level wins when the provider offers it, and is ignored otherwise.
  assert.equal(studioReasoning({ provider: 'openai', reasoningEfforts: true, defaultReasoningEffort: 'high' }).defaultEffort, 'high');
  assert.equal(studioReasoning({ provider: 'openai', reasoningEfforts: true, defaultReasoningEffort: 'max' }).defaultEffort, 'medium');
});

test('OpenAI never advertises or sends max', () => {
  const openai = studioReasoning({ provider: 'openai', reasoningEfforts: true });
  assert.equal('max' in openai.efforts, false);
  assert.equal(studioReasoningWire({ provider: 'openai', reasoningEfforts: true }, 'max'), undefined);
  assert.equal(studioReasoningWire({ provider: 'openai', reasoningEfforts: true }, 'medium'), 'medium');
  for (const wire of Object.values(openai.efforts)) assert.notEqual(wire, 'max');
});

test('Codex narrows max to its own enum and keeps medium translatable', () => {
  assert.equal(studioCodexReasoningWire('low'), 'low');
  assert.equal(studioCodexReasoningWire('medium'), 'medium');
  assert.equal(studioCodexReasoningWire('max'), 'high');
  assert.equal(studioCodexReasoningWire('off'), undefined);
  assert.equal(studioReasoningWire({ provider: 'codex', reasoningEfforts: true }, 'max'), 'high');
  assert.equal(studioReasoningFallbackWire({ provider: 'codex' }), 'high');
});

test('unknown providers degrade to two same-named levels and never send max', () => {
  for (const provider of ['custom', 'openai-compatible', '', undefined, 'unrecognised']) {
    assert.deepEqual(studioReasoning({ provider, reasoningEfforts: true }), {
      efforts: { low: 'low', high: 'high' }, defaultEffort: 'high',
    });
  }
  // Prototype keys must not be mistaken for a capability row.
  assert.equal(reasoningProfileFor('constructor'), REASONING_FALLBACK_PROFILE);
  assert.equal(studioReasoningWire({ provider: 'custom', reasoningEfforts: true }, 'max'), undefined);
  assert.equal(studioReasoningFallbackWire({ provider: 'custom' }), 'high');
});

test('an explicit reasoningEfforts map still overrides the provider table', () => {
  assert.deepEqual(studioReasoning({ provider: 'openai', reasoningEfforts: { low: 'low', max: 'max' } }), {
    efforts: { low: 'low', max: 'max' }, defaultEffort: 'low',
  });
  assert.deepEqual(studioReasoning({ provider: 'ksyun', reasoningEfforts: { high: 'high', low: 'low' }, defaultReasoningEffort: 'low' }), {
    efforts: { low: 'low', high: 'high' }, defaultEffort: 'low',
  });
  // Levels outside the Studio vocabulary are still dropped, and an empty map
  // is not a declaration at all.
  assert.equal(studioReasoning({ provider: 'ksyun', reasoningEfforts: { ultra: 'ultra', off: 'off' } }), null);
  assert.equal(studioReasoning({ provider: 'ksyun', reasoningEfforts: { low: '  ' } }), null);
  assert.equal(studioReasoning({ reasoningEfforts: false }), null);
  assert.equal(studioReasoning({}), null);
});

test('studioReasoning keeps the {efforts, defaultEffort} contract every bridge consumes', () => {
  for (const provider of ['ksyun', 'deepseek', 'openai', 'codex', 'custom']) {
    const result = studioReasoning({ provider, reasoningEfforts: true });
    assert.deepEqual(Object.keys(result).sort(), ['defaultEffort', 'efforts']);
    assert.equal(typeof result.efforts, 'object');
    assert.ok(Object.keys(result.efforts).includes(result.defaultEffort));
    assert.ok(Object.values(result.efforts).every(wire => typeof wire === 'string' && wire.length > 0));
  }
});

test('a 400 naming reasoning_effort can be downgraded exactly once', () => {
  assert.equal(isReasoningEffortRejection(400, '{"error":{"message":"Unsupported reasoning_effort: max"}}'), true);
  assert.equal(isReasoningEffortRejection(400, 'reasoning.effort must be one of minimal, low, medium, high'), true);
  assert.equal(isReasoningEffortRejection(500, 'reasoning_effort'), false);
  assert.equal(isReasoningEffortRejection(400, 'model not found'), false);

  const chat = { model: 'gpt', reasoning_effort: 'max' };
  assert.equal(applyReasoningFallback(chat, 'high'), 'max');
  assert.equal(chat.reasoning_effort, 'high');
  // Nothing left to change: a second attempt would repeat the same request.
  assert.equal(applyReasoningFallback(chat, 'high'), undefined);

  const responses = { model: 'gpt', reasoning: { effort: 'max', summary: 'auto' } };
  assert.equal(applyReasoningFallback(responses, 'high'), 'max');
  assert.deepEqual(responses.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(applyReasoningFallback({ model: 'gpt' }, 'high'), undefined);
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

test('an OpenAI profile routes only OpenAI-legal wire values into DSH', async () => {
  const providers = [];
  const ctx = { remote: {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [
        { ns: 'llm-pi-ai', value: { providers: {} }, revision: 1 },
        { ns: 'agent-default-model', revision: 1 },
      ] } }),
      mutate: async (ns, operations) => {
        if (ns === 'llm-pi-ai') providers.push(...operations.map(op => op.value));
        return { ok: true };
      },
    },
    credentials: { set: async () => ({ ok: true }) },
  } };
  const bridge = createModelBridge({ hostRemote: { modelCatalog: async () => ({ items: [{ id: 'gpt-5', name: 'GPT-5', input: ['text'] }] }) } })
    .createDshModelBridge(ctx, { isActive: () => true });
  await bridge.applyProfiles({ profiles: [{
    id: 'gpt', provider: 'openai', modelName: 'gpt-5', baseUrl: 'https://api.openai.com/v1',
    credentialName: 'OPENAI_API_KEY', reasoningEfforts: true, defaultReasoningEffort: 'max',
  }] });
  assert.equal(providers[0].reasoning, 'medium');
  assert.deepEqual(providers[0].models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
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
