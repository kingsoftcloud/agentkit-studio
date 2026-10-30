import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { admitProviderCompatibilityPolicy, applyProviderChatCompatibility } from '../src/native/model-provider-compat.mjs';
import { buildNativeModelRequest } from '../src/native/model-request.mjs';

const oracle = JSON.parse(await readFile(new URL('./fixtures/native-provider-compat.json', import.meta.url), 'utf8'));
for (const item of oracle.cases) test(`provider compatibility oracle: ${item.id}`, () => {
  const payload = structuredClone(item.payload);
  const result = applyProviderChatCompatibility(payload,
    { purpose: item.purpose, profile: { ...item.profile, providerCompatibilityPolicy: admitProviderCompatibilityPolicy(item.rule) } },
    { model: item.model });
  assert.deepEqual(result, item.expected);
  assert.deepEqual(payload, item.payload, 'projection cannot mutate a previous attempt');
});

test('provider compatibility admission: all wires retain explicit non-stream and parallel settings', () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
    const built = buildNativeModelRequest({ protocol, model: 'model', baseUrl: 'https://model.invalid/v1', apiKey: 'fake' }, {
      profile: { maxOutputTokens: 8192, streaming: false, parallelToolCalls: false, temperature: 0.2, topP: 0.8,
        providerReplayMode: 'none', providerCompatibilityPolicy: admitProviderCompatibilityPolicy() },
      messages: [{ role: 'user', content: 'task' }], tools: [{ name: 'read', parameters: { type: 'object' } }],
      finalizationOnly: false,
    });
    const payload = JSON.parse(built.body);
    assert.equal(payload.stream, false); assert.equal(built.headers.Accept, 'application/json');
    assert.equal(payload.temperature, 0.2); assert.equal(payload.top_p, 0.8);
    if (protocol === 'anthropic-messages') assert.equal(payload.tool_choice.disable_parallel_tool_use, true);
    else assert.equal(payload.parallel_tool_calls, false);
  }
});

test('provider compatibility admission: final submission is forced and Kimi projection retains its schema', () => {
  for (const model of ['glm-5.3-flash', 'kimi-k2.7-code']) {
    const built = buildNativeModelRequest({ protocol: 'openai-chat', model, baseUrl: 'https://kspmas.invalid/v1', apiKey: 'fake' }, {
      profile: { maxOutputTokens: 8192, providerReplayMode: 'none', providerCompatibilityPolicy: admitProviderCompatibilityPolicy() },
      messages: [{ role: 'user', content: 'task' }], finalizationOnly: true,
      tools: [{ name: 'forbidden' }, { name: 'submit_final_output', parameters: { type: 'object', required: ['answer'] } }],
    });
    const payload = JSON.parse(built.body);
    assert.deepEqual(payload.tools.map(tool => tool.function.name), ['submit_final_output']);
    assert.deepEqual(payload.tools[0].function.parameters.required, ['answer']);
    assert.deepEqual(payload.tool_choice, model.startsWith('kimi') ? 'auto'
      : { type: 'function', function: { name: 'submit_final_output' } });
  }
});
