import test from 'node:test';
import assert from 'node:assert/strict';
import { codexConversationPrompt } from '../src/providers/codex-history.mjs';

const observation = { role: 'user', source: { kind: 'studio/codex-tool-observation', callId: 'lookup' }, content: [{ type: 'text', text: 'Recorded result: HIDDEN_TOOL_VALUE' }] };

test('Codex receives native observations and the latest user task exactly once', () => {
  const messages = [observation, { role: 'assistant', content: 'DONE' }, { role: 'user', content: 'recall the result' }];
  const prompt = codexConversationPrompt({ input: 'recall the result', messages });
  assert.match(prompt, /Recorded context: Recorded result: HIDDEN_TOOL_VALUE/);
  assert.equal(prompt.split('User: recall the result').length - 1, 1);
  assert.equal(codexConversationPrompt({ input: 'recall the result', messages: JSON.parse(JSON.stringify(messages)) }), prompt);
});

test('discarded sidecar facts cannot re-enter the admitted model history', () => {
  const prompt = codexConversationPrompt({ input: 'continue', messages: [{ role: 'user', content: 'replacement' }], toolHistory: [observation] });
  assert.doesNotMatch(prompt, /HIDDEN_TOOL_VALUE/);
  assert.equal(codexConversationPrompt({ input: 'hello' }), 'hello');
});

test('DSH owns history compaction; the adapter does not silently trim its admitted messages', () => {
  const messages = [observation, ...Array.from({length: 25}, (_, i) => ({ role: 'assistant', content: `message-${i}` }))];
  const prompt = codexConversationPrompt({ input: 'continue', messages });
  assert.match(prompt, /HIDDEN_TOOL_VALUE/);
  assert.match(prompt, /message-0/);
  assert.match(prompt, /message-24/);
});

test('context that happens to match the latest task is not mistaken for human input', () => {
  const prompt = codexConversationPrompt({ input: 'same text', messages: [{ ...observation, content: 'same text' }] });
  assert.match(prompt, /Recorded context: same text/);
  assert.match(prompt, /User: same text/);
});
