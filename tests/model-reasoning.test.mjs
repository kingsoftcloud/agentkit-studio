import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REASONING_FALLBACK_PROFILE, REASONING_PROFILES, applyReasoningFallback, dropCarrierlessReasoningTurns,
  dropOrphanToolReceipts, isReasoningEffortRejection, normalizeEmptyAssistantTurns, normalizeReasoningContent,
  reasoningProfileFor, studioCodexReasoningWire, studioReasoning, studioReasoningFallbackWire, studioReasoningWire,
} from '../src/model-reasoning.mjs';
import { createModelBridge } from '../src/client/dsh/model-bridge.mjs';
import { syncPortableModelProfiles } from '../src/portable-model-bridge.mjs';
import { importedModelReasoning } from '../src/model-catalog-reasoning.mjs';

test('the capability table is the single source of provider levels and wire values', () => {
  assert.deepEqual(REASONING_PROFILES.ksyun.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(REASONING_PROFILES.ksyun.wire, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  assert.equal(REASONING_PROFILES.ksyun.default, 'high');

  assert.deepEqual(REASONING_PROFILES.deepseek.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(REASONING_PROFILES.deepseek.wire, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
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
    efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultEffort: 'high',
  });
  assert.deepEqual(studioReasoning({ provider: 'deepseek', reasoningEfforts: true }), {
    efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultEffort: 'high',
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

/** A fake DSH Settings/credential remote that records every write. */
function bridgeContext(catalog, { modelDefaults = false } = {}) {
  const providers = {}, writes = [];
  const schema = { refs: modelDefaults ? { 1: { dict: { reasoningEfforts: '2', defaultReasoningEffort: '3' } } } : {} };
  const ctx = { remote: {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [
        { ns: 'llm-pi-ai', schema, value: { providers }, revision: 3 },
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
  const bridge = createModelBridge({ hostRemote: { modelCatalog: async () => ({ items: catalog }) } })
    .createDshModelBridge(ctx, { isActive: () => true });
  return { bridge, providers, writes };
}

const reasoner = {
  id: 'reasoner', provider: 'ksyun', modelName: 'deepseek-v4.1-flash-1017',
  baseUrl: 'http://kspmas.ksyun.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY',
  connectionId: 'reasoner', reasoningEfforts: true, defaultReasoningEffort: 'high',
};

test('a route serving a single model keeps its own reasoning default', async () => {
  const { bridge, providers, writes } = bridgeContext([
    { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek', input: ['text'] },
    { id: 'seedream-5.0', name: 'Seedream', input: ['text', 'image'] },
  ]);
  await bridge.applyProfiles({ profiles: [reasoner] });

  const provider = providers['agentkit-studio-reasoner'];
  // A route serves exactly its own model — no catalog siblings to inherit a
  // route default that they never declared.
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].id, 'deepseek-v4.1-flash-1017');
  // Kspmas answers `400 Invalid request: role 'developer' is not allowed`.
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false, supportsStore: false });
  assert.deepEqual(provider.models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
  // A single-model route takes its default from the route-level `reasoning`.
  assert.equal(provider.reasoning, 'high');
  // Default thinking also rides the default selection.
  const [, defaultOps] = writes.find(([ns]) => ns === 'agent-default-model');
  assert.deepEqual(defaultOps.find(op => op.path[0] === 'reasoningEffort'), { op: 'set', path: ['reasoningEffort'], value: 'high' });
  assert.equal(writes.filter(([ns]) => ns === 'llm-pi-ai').length, 1);
});

test('models on one connection share a single route', async () => {
  const other = { ...reasoner, id: 'other', modelName: 'other-model', defaultReasoningEffort: 'low' };
  const plain = { ...reasoner, id: 'plain', modelName: 'plain-model', reasoningEfforts: false };
  const { bridge, providers } = bridgeContext([{ id: reasoner.modelName }, { id: plain.modelName }], { modelDefaults: true });
  await bridge.applyProfiles({ profiles: [reasoner, other, plain] });

  // One connection is one DSH route: the selector shows one provider with
  // three models, not three providers with one model each.
  const routes = Object.keys(providers);
  assert.equal(routes.length, 1, JSON.stringify(routes));
  const route = providers[routes[0]];
  assert.deepEqual(route.models.map(model => model.id).sort(), ['deepseek-v4.1-flash-1017', 'other-model', 'plain-model']);
  // A route default would apply to every model, including `plain-model`,
  // which never declared that level — switching back to it would fail with
  // `UNSUPPORTED_REASONING_EFFORT`. Keep the default on each model instead.
  assert.equal(route.reasoning, undefined);
  assert.deepEqual(route.models.map(model => [model.id, model.defaultReasoningEffort]).sort(),
    [['deepseek-v4.1-flash-1017', 'high'], ['other-model', 'low'], ['plain-model', undefined]]);
});

test('a stock host gets no route default on a shared route', async () => {
  const other = { ...reasoner, id: 'other', modelName: 'other-model', defaultReasoningEffort: 'low' };
  const plain = { ...reasoner, id: 'plain', modelName: 'plain-model', reasoningEfforts: false };
  const { bridge, providers } = bridgeContext([{ id: reasoner.modelName }, { id: plain.modelName }]);
  await bridge.applyProfiles({ profiles: [reasoner, other, plain] });

  const route = Object.values(providers)[0];
  // Without per-model defaults, a shared route must fall back to the gateway
  // default instead of imposing one model's level on its siblings.
  assert.equal(route.reasoning, undefined);
  assert.deepEqual(route.models.map(model => [model.id, Object.hasOwn(model, 'defaultReasoningEffort')]).sort(),
    [['deepseek-v4.1-flash-1017', false], ['other-model', false], ['plain-model', false]]);
});

test('a Responses route never sets the chat-only store compat', async () => {
  const { bridge, providers } = bridgeContext([{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek', input: ['text'] }]);
  await bridge.applyProfiles({ profiles: [{ ...reasoner, protocol: 'openai-responses' }] });
  const provider = providers['agentkit-studio-reasoner'];
  assert.equal(provider.api, 'openai-responses');
  // DSH answers `provider "…" sets compat "supportsStore", but no model on the
  // route speaks a protocol that takes it` — the key belongs to
  // openai-completions alone. Setting it on a Responses route made every
  // model mutation fail, which is what a profile declaring
  // `protocol: openai-responses` hit as soon as it switched wires.
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false });
  assert.equal(Object.hasOwn(provider.compat, 'supportsStore'), false);
});

test('a chat route keeps the store compat', async () => {
  const { bridge, providers } = bridgeContext([{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek', input: ['text'] }]);
  await bridge.applyProfiles({ profiles: [{ ...reasoner, protocol: 'openai-completions' }] });
  const provider = providers['agentkit-studio-reasoner'];
  assert.equal(provider.api, 'openai-completions');
  // The proxy is stateless, so a gateway that only implements the older
  // request shape rejects `store` itself and dropping it costs nothing.
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false, supportsStore: false });
});

test('a route serving this profile model alone keeps the concrete route default', async () => {
  const { bridge, providers } = bridgeContext([{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek', input: ['text'] }]);
  await bridge.applyProfiles({ profiles: [reasoner] });
  const provider = providers['agentkit-studio-reasoner'];
  assert.equal(provider.reasoning, 'high');
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false, supportsStore: false });
  assert.deepEqual(provider.models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });
});

test('an explicitly added model carries its selected default without changing catalog siblings', async () => {
  const { bridge, providers } = bridgeContext([
    { id: reasoner.modelName, name: 'DeepSeek', input: ['text'] },
    { id: 'legacy-catalog-entry', name: 'Other model', input: ['text'] },
  ]);
  await bridge.applyProfiles({ profiles: [{ ...reasoner, modelOnly: true, reasoningLevels: ['low'], defaultReasoningEffort: 'high' }] });

  const provider = providers['agentkit-studio-reasoner'];
  assert.equal(provider.reasoning, 'low');
  assert.deepEqual(provider.models.map(model => [model.id, model.reasoningEfforts]), [[reasoner.modelName, { low: 'low' }]]);
});

test('the capability catalog fills levels the gateway omits (kimi-k3.1-pro)', () => {
  // kimi-k3.1-pro reports no levels from /models; models.dev lists low/high/max.
  assert.deepEqual(importedModelReasoning({ id: 'kimi-k3.1-pro' }, reasoner),
    { reasoningLevels: ['low', 'high', 'max'], reasoningEfforts: true, defaultReasoningEffort: 'high' });
});

test('a catalog model that only toggles thinking gets no selectable levels', () => {
  assert.deepEqual(importedModelReasoning({ id: 'kimi-k2.6' }, reasoner), { reasoningLevels: [] });
});

test('a model the catalog does not describe still follows the service default', () => {
  const item = { id: 'no-such-model-xyz' };
  assert.deepEqual(importedModelReasoning(item, reasoner), { reasoningLevels: [] });
  assert.deepEqual(importedModelReasoning({ ...item, defaultReasoningEffort: 'high' }, reasoner), { reasoningLevels: [] });
  assert.deepEqual(importedModelReasoning({ ...item, reasoningLevels: [], defaultReasoningEffort: 'high' }, reasoner), { reasoningLevels: [] });
});

test('a default profile without a reasoning declaration clears a stale default effort', async () => {
  const { bridge, writes } = bridgeContext([{ id: 'seedream-5.0', name: 'Seedream', input: ['text', 'image'] }]);
  await bridge.applyProfiles({ profiles: [{
    id: 'painter', provider: 'ksyun', modelName: 'seedream-5.0',
    baseUrl: 'http://kspmas.ksyun.com/v1', credentialName: 'AGENTKIT_MODEL_API_KEY',
  }] });
  const [, defaultOps] = writes.find(([ns]) => ns === 'agent-default-model');
  // A level left behind by an earlier profile would fail every fresh session
  // for an effort this model never declared.
  assert.deepEqual(defaultOps.find(op => op.path[0] === 'reasoningEffort'), { op: 'unset', path: ['reasoningEffort'] });
});

test('the DSH route speaks the wire the profile declares', async () => {
  // The Codex loopback proxy already honours `codexApi`; the DSH provider
  // hardcoded `openai-completions`, so a profile configured for Responses
  // still reached its gateway through the Chat conversion — losing reasoning
  // items and the tool-call semantics for nothing. `protocol` is the more
  // precise declaration and wins; a profile that declares neither keeps the
  // historical Chat wire.
  for (const [patch, expected] of [
    [{}, 'openai-completions'],
    [{ codexApi: 'chat-completions' }, 'openai-completions'],
    // `codexApi` is the Codex selector; it must not flip the DSH route onto a
    // wire 42 of 星流's 59 models do not implement.
    [{ codexApi: 'responses' }, 'openai-completions'],
    [{ protocol: 'openai-chat' }, 'openai-completions'],
    [{ protocol: 'openai-responses' }, 'openai-responses'],
    [{ protocol: 'anthropic-messages' }, 'anthropic-messages'],
    [{ protocol: 'openai-chat', codexApi: 'responses' }, 'openai-completions'],
  ]) {
    const { bridge, providers } = bridgeContext([{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek', input: ['text'] }]);
    await bridge.applyProfiles({ profiles: [{ ...reasoner, ...patch }] });
    assert.equal(providers['agentkit-studio-reasoner'].api, expected, JSON.stringify(patch));
  }
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
  const value = providers['agentkit-studio-ksyun-http-kspmas-ksyun-com-v1'];
  assert.equal(value.reasoning, 'high');
  // Kspmas rejects the `developer` role pi-ai would otherwise send for a
  // reasoning model, so every Studio route keeps the system role.
  assert.equal(value.api, 'openai-completions', 'an undeclared profile keeps the Chat wire');
  assert.deepEqual(value.compat, { supportsDeveloperRole: false, supportsStore: false });
  assert.deepEqual(value.models[0].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' });

  await syncPortableModelProfiles({ settings, profiles: [{
    id: 'plain', provider: 'ksyun', modelName: 'seedream-5.0',
    baseUrl: 'http://kspmas.ksyun.com/v1', credentialName: 'KEY',
  }] });
  assert.equal(providers['agentkit-studio-ksyun-http-kspmas-ksyun-com-v1'].models[0].reasoningEfforts, undefined);
});

test('empty assistant turns are dropped on both wires, and every other item is preserved', () => {
  const body = { input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [] },
    { type: 'message', role: 'assistant', content: '' },
    { type: 'message', role: 'assistant', content: null },
    { type: 'message', role: 'assistant' },
    // A reasoning item is not a turn: its (possibly empty) content is data.
    { type: 'reasoning', id: 'rs-1', summary: [], content: [] },
  ] };
  assert.equal(normalizeEmptyAssistantTurns(body), 4);
  assert.deepEqual(body.input.map(item => item.type), ['message', 'reasoning']);

  // Chat Completions rows carry their calls inline; a turn with calls is legal
  // with `content: null` and must survive.
  const chat = { messages: [
    { role: 'user', content: 'run' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'pwd', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '/tmp' },
  ] };
  assert.equal(normalizeEmptyAssistantTurns(chat), 1);
  assert.deepEqual(chat.messages.map(message => message.role), ['user', 'assistant', 'tool']);
  assert.equal(chat.messages[1].tool_calls.length, 1);
});

test('empty-assistant normalization is lenient about shapes it does not own', () => {
  assert.equal(normalizeEmptyAssistantTurns(undefined), 0);
  assert.equal(normalizeEmptyAssistantTurns({}), 0);
  // `input` may legitimately be a bare string; only arrays are turned and filtered.
  assert.equal(normalizeEmptyAssistantTurns({ input: 'hi' }), 0);
  // Non-message assistant items (a Responses reasoning item) keep their content.
  const reasoningOnly = { input: [{ type: 'reasoning', role: 'assistant', content: null }] };
  assert.equal(normalizeEmptyAssistantTurns(reasoningOnly), 0);
  assert.equal(reasoningOnly.input.length, 1);
});

test('a turn carrying only reasoning is dropped, a turn with a carrier keeps its reasoning', () => {
  // Trailing reasoning with no text and no call: the gateway refuses the turn.
  const trailing = { input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'reasoning', id: 'rs-1', summary: [], content: null },
  ] };
  assert.equal(dropCarrierlessReasoningTurns(trailing), 1);
  assert.deepEqual(trailing.input.map(item => item.type || item.role), ['message']);

  // Reasoning immediately before a tool call is legal continuity and must stay.
  const toolTurn = { input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
    { type: 'reasoning', id: 'rs-2', summary: [], content: null, encrypted_content: 'opaque' },
    { type: 'function_call', call_id: 'call_1', name: 'pwd', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
  ] };
  assert.equal(dropCarrierlessReasoningTurns(toolTurn), 0);
  assert.equal(toolTurn.input.length, 4);

  // A content-bearing assistant message is the carrier; `[]` and `''` count as
  // set on this wire, so those turns keep their reasoning too.
  const textTurn = { input: [
    { type: 'reasoning', id: 'rs-3', summary: [], content: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
  ] };
  assert.equal(dropCarrierlessReasoningTurns(textTurn), 0);

  // A tool receipt ends the turn, so reasoning after it starts a new one.
  const afterReceipt = { input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
    { type: 'reasoning', id: 'rs-4', summary: [], content: null },
    { type: 'function_call', call_id: 'call_1', name: 'pwd', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
    { type: 'reasoning', id: 'rs-5', summary: [], content: null },
  ] };
  assert.equal(dropCarrierlessReasoningTurns(afterReceipt), 1);
  assert.deepEqual(afterReceipt.input.map(item => item.id || item.type), ['message', 'rs-4', 'function_call', 'function_call_output']);
});

test('carrierless-reasoning normalization is lenient about shapes it does not own', () => {
  assert.equal(dropCarrierlessReasoningTurns(undefined), 0);
  assert.equal(dropCarrierlessReasoningTurns({}), 0);
  assert.equal(dropCarrierlessReasoningTurns({ messages: [{ role: 'assistant', content: '' }] }), 0);
  const legal = { input: [{ type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' }] };
  assert.equal(dropCarrierlessReasoningTurns(legal), 0);
  assert.equal(legal.input.length, 1);
});

test('a tool receipt keeps only when its call is still in the request', () => {
  // Responses wire: calls and receipts are separate items paired by call_id.
  const native = { input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run' }] },
    { type: 'function_call', call_id: 'call_1', name: 'pwd', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
    { type: 'function_call_output', call_id: 'call_gone', output: '/gone' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
  ] };
  assert.equal(dropOrphanToolReceipts(native), 1);
  assert.deepEqual(native.input.map(item => item.call_id || item.type), ['message', 'call_1', 'call_1', 'message']);

  // One receipt answers one call: a second receipt for the same id is an orphan.
  const duplicate = { input: [
    { type: 'function_call', call_id: 'call_1', name: 'pwd', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'first' },
    { type: 'function_call_output', call_id: 'call_1', output: 'second' },
  ] };
  assert.equal(dropOrphanToolReceipts(duplicate), 1);
  assert.equal(duplicate.input.length, 2);
  assert.equal(duplicate.input[1].output, 'first');

  // Chat Completions wire: the calls live on the assistant row.
  const chat = { messages: [
    { role: 'user', content: 'run' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'pwd', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '/tmp' },
    { role: 'tool', tool_call_id: 'call_gone', content: '/gone' },
    { role: 'user', content: 'next' },
  ] };
  assert.equal(dropOrphanToolReceipts(chat), 1);
  assert.deepEqual(chat.messages.map(message => message.role), ['user', 'assistant', 'tool', 'user']);
});

test('orphan-receipt normalization is lenient about shapes it does not own', () => {
  assert.equal(dropOrphanToolReceipts(undefined), 0);
  assert.equal(dropOrphanToolReceipts({}), 0);
  assert.equal(dropOrphanToolReceipts({ input: 'hi' }), 0);
  // A call without its receipt is left for the projection's own pairing check;
  // this normalization only owns the receipt direction.
  const callOnly = { input: [{ type: 'function_call', call_id: 'call_1', name: 'pwd', arguments: '{}' }] };
  assert.equal(dropOrphanToolReceipts(callOnly), 0);
  assert.equal(callOnly.input.length, 1);
});
