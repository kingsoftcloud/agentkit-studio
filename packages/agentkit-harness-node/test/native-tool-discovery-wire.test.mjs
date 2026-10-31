import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMessagesOpenAI } from '../src/native/model-openai-chat.mjs';
import { projectMessagesResponses } from '../src/native/model-responses.mjs';
import { projectMessagesAnthropic } from '../src/native/model-anthropic.mjs';
import { sealAnthropicReplay } from '../src/native/model-replay.mjs';
import { emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';

const wire = { callId: 'call', name: 'DeferredToolCall', arguments: { name: 'publish', input: { id: 9007199254740993n } } };
const actual = { callId: 'call', name: 'publish', arguments: { id: 9007199254740993n }, modelCallWrapper: 'DeferredToolCall' };
const profile = { profileId: 'test', profileVersion: '1', compatibilityDigest: 'test/v1', providerReplayMode: 'none' };
const request = { profile, messages: [{ role: 'user', content: 'Publish' },
  { role: 'assistant', content: '', toolCalls: [actual] }, { role: 'tool', callId: 'call', name: 'publish', content: 'Published' }] };

test('all provider histories retain the original wrapper while durable records retain the real tool', () => {
  const chat = projectMessagesOpenAI(request);
  assert.equal(chat[1].tool_calls[0].function.name, wire.name);
  assert.equal(chat[1].tool_calls[0].function.arguments, '{"name":"publish","input":{"id":9007199254740993}}');
  const responses = projectMessagesResponses(request);
  const call = responses.items.find(item => item.type === 'function_call');
  assert.equal(call.name, wire.name); assert.equal(call.arguments, chat[1].tool_calls[0].function.arguments);
  const anthropic = projectMessagesAnthropic(request);
  const block = anthropic.items.flatMap(item => item.content).find(block => block.type === 'tool_use');
  assert.equal(block.name, wire.name); assert.deepEqual(block.input, wire.arguments);
  assert.equal(actual.name, 'publish'); assert.equal(actual.modelCallWrapper, 'DeferredToolCall');
});

test('Anthropic signed thinking pairs against the original wrapper without dropping replay', () => {
  const signedProfile = { ...profile, providerReplayMode: 'anthropic_content' };
  const blocks = [{ type: 'thinking', thinking: 'Private reasoning', signature: 'signature' },
    { type: 'tool_use', id: wire.callId, name: wire.name, input: wire.arguments }];
  const sealed = sealAnthropicReplay({ kind: 'tool_calls', text: '', toolCalls: [wire], usage: emptyUsage() }, signedProfile, blocks);
  const messages = structuredClone(request.messages); messages[1].providerReplay = sealed.providerReplay;
  const output = projectMessagesAnthropic({ profile: signedProfile, messages });
  assert.deepEqual(output.items.find(item => item.role === 'assistant').content, blocks);
});
