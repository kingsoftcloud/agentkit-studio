import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tool } from '../../agentkit-harness-core/test/fixtures.mjs';
import { createNativeContextPort, estimateNativeText, estimateNativeWireInput } from '../src/native/context-counter.mjs';
import { createNativeModelPort } from '../src/native/model-port.mjs';
import { sealModelReplay, sealAnthropicReplay } from '../src/native/model-replay.mjs';

const media = url => ({ type: 'image_url', image_url: { url } });
function request(protocol) {
  const { config } = fixture({ profile: { profileId: 'test', profileVersion: '1', providerFamily: protocol,
    compatibilityDigest: 'test', providerReplayMode: protocol === 'anthropic-messages' ? 'anthropic_content' : 'reasoning_content' } });
  return { signal: new AbortController().signal, profile: config.profile, tools: [tool()], finalizationOnly: false,
    maxInlineImageBytes: 40000000, messages: [{ role: 'system', content: 'Trusted instructions' },
      { role: 'user', content: '检查原文 😀', kind: 'user_input', media: [media('data:image/png;base64,AQ==')] }] };
}
test('versioned text estimates match the pinned CJK/ASCII formula and Unicode code points', () => {
  for (const [text, expected] of [['', 1], ['   ', 1], ['abcd', 2], ['abcde', 3], ['中', 2], ['中文', 4],
    ['汉字abcde', 7], ['😀'.repeat(8), 3], ['𠀀'.repeat(8), 3], ['\u0085中\u001c', 2], ['\uFEFFabcd', 3]]) {
    assert.equal(estimateNativeText(text), expected, JSON.stringify(text));
  }
  assert.throws(() => estimateNativeText(null), /context_counter_text_invalid/);
});
for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  test(`${protocol}: admission prices the actual model wire and excludes private display data`, async () => {
    const input = request(protocol), binding = { protocol, model: 'pinned', apiKey: 'secret', baseUrl: 'https://model.invalid/v1' };
    const port = createNativeContextPort(binding);
    const before = structuredClone(input.messages);
    const counted = await port.tokens.countRequest(input);
    let wire;
    const model = createNativeModelPort({ resolveProfile: async () => binding, fetchImpl: async (_url, options) => {
      wire = JSON.parse(options.body); return new Response('unavailable', { status: 401 });
    } });
    await model.generate(input);
    assert.equal(counted, estimateNativeWireInput(wire, protocol));
    assert.deepEqual(input.messages, before);
    input.messages[1].presentation = { format: 'Host-private', content: [{ text: 'display only'.repeat(10000) }] };
    assert.equal(await port.tokens.countRequest(input), counted);
    input.tools[0].description += 'Schema details '.repeat(2000);
    assert.ok(await port.tokens.countRequest(input) > counted + 1000);
  });
  test(`${protocol}: inline and remote images have explicit reserves instead of base64 text cost`, async () => {
    const input = request(protocol), port = createNativeContextPort({ protocol, model: 'pinned' });
    const small = await port.tokens.countRequest(input);
    input.messages[1].media = [media('data:image/png;base64,' + 'AAAA'.repeat(20000))];
    const large = await port.tokens.countRequest(input);
    assert.equal(large - small, 10000 - 2048);
    input.messages[1].media = [media('https://images.invalid/example.png')];
    assert.equal(await port.tokens.countRequest(input) - small, 8192 - 2048);
  });
  test(`${protocol}: the latest Native human image is protected by the dispatch byte budget`, async () => {
    const input = request(protocol), port = createNativeContextPort({ protocol, model: 'pinned' });
    input.maxInlineImageBytes = 1;
    await assert.rejects(port.tokens.countRequest(input), /request_current_media_over_budget/);
    input.messages[1].kind = 'host_input'; input.messages[1].persistent = true;
    await assert.rejects(port.tokens.countRequest(input), /request_current_media_over_budget/);
    input.messages[1].persistent = false;
    assert.ok(await port.tokens.countRequest(input) > 0); // Host observation can be explicitly offloaded.
  });
}
test('counter binding is frozen and versioned across protocol/model/parameter changes', async () => {
  const parameters = { response_format: { type: 'json_object' } }, input = request('openai-chat');
  const port = createNativeContextPort({ protocol: 'openai-chat', model: 'pinned', parameters });
  const count = await port.tokens.countRequest(input);
  parameters.response_format = { type: 'json_schema', schema: { description: 'Changed '.repeat(1000) } };
  assert.equal(await port.tokens.countRequest(input), count);
  assert.notEqual(createNativeContextPort({ protocol: 'openai-chat', model: 'pinned', parameters }).tokens.tokenizerDigest, port.tokens.tokenizerDigest);
  assert.notEqual(createNativeContextPort({ protocol: 'openai-chat', model: 'another' }).tokens.tokenizerDigest, port.tokens.tokenizerDigest);
  assert.equal(Object.isFrozen(port.tokens), true);
  const controller = new AbortController(); controller.abort(Error('Stopped'));
  await assert.rejects(port.tokens.countRequest({ ...input, signal: controller.signal }), /Stopped/);
});
test('image-shaped schemas and tool arguments are priced as text, not interpreted as media', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA'.repeat(1000) } };
  const body = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read', input: image }] }], tools: [{ input_schema: image }] };
  assert.equal(estimateNativeWireInput(body), estimateNativeText(JSON.stringify(body)));
});
for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  test(`${protocol}: source capacity prices logical messages through actual wire fields without synthetic partner costs`, async () => {
    const input = request(protocol), port = createNativeContextPort({ protocol, model: 'pinned' });
    const assistant = { role: 'assistant', content: 'Inspect', toolCalls: [{ name: 'read', callId: 'original', arguments: { path: '原文/😀.txt' } }] };
    const original = structuredClone(assistant);
    const count = await port.tokens.countMessage({ ...input, purpose: 'task', message: assistant });
    assistant.presentation = { format: 'private', content: ['Private '.repeat(3000)] };
    assert.equal(await port.tokens.countMessage({ ...input, purpose: 'task', message: assistant }), count);
    assert.deepEqual({ ...assistant, presentation: undefined }, { ...original, presentation: undefined });
    assistant.toolCalls.push({ name: 'read', callId: 'next', arguments: { path: 'Second '.repeat(200) } });
    assert.ok(await port.tokens.countMessage({ ...input, purpose: 'task', message: assistant }) > count + 100);
    const receipt = { role: 'tool', name: 'read', callId: 'original', content: 'actual source' };
    const receiptCount = await port.tokens.countMessage({ ...input, purpose: 'task', message: receipt });
    receipt.name = 'Synthetic-name-must-not-be-priced-'.repeat(1000);
    assert.equal(await port.tokens.countMessage({ ...input, purpose: 'task', message: receipt }), receiptCount);
    for (const message of input.messages) assert.ok(await port.tokens.countMessage({ ...input, purpose: 'task', message }) > 0);
  });
  test(`${protocol}: individual tool observations keep the actual image byte reserve`, async () => {
    const input = request(protocol), port = createNativeContextPort({ protocol, model: 'pinned' });
    const message = { role: 'tool', name: 'read', callId: 'original', content: 'observed', media: [media('data:image/png;base64,AQ==')] };
    const small = await port.tokens.countMessage({ ...input, purpose: 'task', message });
    message.media = [media('https://images.invalid/source.png')];
    assert.equal(await port.tokens.countMessage({ ...input, purpose: 'task', message }) - small, 8192 - 2048);
  });
}
for (const protocol of ['openai-chat', 'anthropic-messages']) test(`${protocol}: private replay is counted only when enabled by the current profile`, async () => {
  const input = request(protocol), port = createNativeContextPort({ protocol, model: 'pinned' });
  const assistant = { role: 'assistant', content: 'Answer' };
  input.messages.push(assistant);
  const baseline = await port.tokens.countRequest(input);
  assistant.providerReplay = protocol === 'openai-chat'
    ? sealModelReplay({ kind: 'final_candidate' }, input.profile, 'Private reasoning '.repeat(1000)).providerReplay
    : sealAnthropicReplay({ kind: 'final_candidate' }, input.profile, [
      { type: 'thinking', thinking: 'Private reasoning '.repeat(1000), signature: 'private-signature' }, { type: 'text', text: 'Answer' },
    ]).providerReplay;
  assert.ok(await port.tokens.countRequest(input) > baseline);
  input.profile.providerReplayMode = 'none';
  assert.equal(await port.tokens.countRequest(input), baseline);
});

test('Anthropic deferred catalogs price resident schemas and expand actual references without mutating the wire', () => {
  const definition = { name: 'publish', description: 'Large schema '.repeat(2000), input_schema: { type: 'object' }, defer_loading: true };
  const base = { messages: [{ role: 'user', content: 'Publish a marker' }], tools: [] };
  const deferred = { ...structuredClone(base), tools: [definition] }, original = structuredClone(deferred);
  assert.equal(estimateNativeWireInput(deferred, 'anthropic-messages'), estimateNativeWireInput(base, 'anthropic-messages'));
  assert.deepEqual(deferred, original);
  const resident = { ...structuredClone(deferred), tools: [{ ...definition, defer_loading: false }] };
  assert.ok(estimateNativeWireInput(resident, 'anthropic-messages') > estimateNativeWireInput(deferred, 'anthropic-messages') + 1000);
  deferred.messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search',
    content: [{ type: 'tool_reference', tool_name: 'publish' }] }] });
  const before = structuredClone(deferred);
  assert.ok(estimateNativeWireInput(deferred, 'anthropic-messages') > estimateNativeWireInput(base, 'anthropic-messages') + 1000);
  assert.deepEqual(deferred, before);
  deferred.messages.at(-1).content[0].content[0].tool_name = 'unknown';
  assert.throws(() => estimateNativeWireInput(deferred, 'anthropic-messages'), /context_counter_tool_reference_unknown/);
});

test('Anthropic logical ToolSearch source costs include expanded schemas instead of result prose alone', async () => {
  const input = request('anthropic-messages'), port = createNativeContextPort({ protocol: 'anthropic-messages', model: 'pinned' });
  input.profile.providerToolSearchPolicy = 'anthropic-deferred/v1';
  input.tools = [tool({ name: 'publish', description: 'Large definition '.repeat(2000), discovery: { deferred: true } })];
  const message = { role: 'tool', name: 'ToolSearch', callId: 'search', content: 'Loaded publish', discoveredToolNames: ['publish'] };
  const original = structuredClone(message);
  const count = await port.tokens.countMessage({ ...input, purpose: 'task', message });
  assert.deepEqual(message, original);
  input.tools[0].description = 'Publish';
  assert.ok(count > await port.tokens.countMessage({ ...input, purpose: 'task', message }) + 1000);
  input.tools = [];
  await assert.rejects(port.tokens.countMessage({ ...input, purpose: 'task', message }), /not an admitted tool/);
});
