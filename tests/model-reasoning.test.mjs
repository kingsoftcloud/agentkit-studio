import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REASONING_FALLBACK_PROFILE, REASONING_PROFILES, applyReasoningFallback, dropCarrierlessReasoningTurns,
  dropOrphanToolReceipts, isReasoningEffortRejection, normalizeEmptyAssistantTurns, normalizeReasoningContent,
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
  // Kspmas answers `400 Invalid request: role 'developer' is not allowed`, and
  // pi-ai sends the system prompt as `developer` to every reasoning model on a
  // route it cannot detect as non-standard.
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false });
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
  assert.deepEqual(value.compat, { supportsDeveloperRole: false });
  assert.deepEqual(value.models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' });

  await syncPortableModelProfiles({ settings, profiles: [{
    id: 'plain', provider: 'ksyun', modelName: 'seedream-5.0',
    baseUrl: 'http://kspmas.ksyun.com/v1', credentialName: 'KEY',
  }] });
  assert.equal(providers['agentkit-studio-plain'].models[0].reasoningEfforts, undefined);
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
