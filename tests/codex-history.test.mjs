import test from 'node:test';
import assert from 'node:assert/strict';
import { codexToolHistory, codexConversationPrompt } from '../src/providers/codex-history.mjs';

const events = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'agentkit/codex-tool', data: { callId: 'first:lookup', name: 'lookup', phase: 'started', arguments: '{}' } },
  { seq: 2, type: 'agentkit/codex-tool', data: { callId: 'first:lookup', name: 'lookup', phase: 'completed', arguments: '{}', content: [{ type: 'text', text: 'HIDDEN_TOOL_VALUE' }] } },
  { seq: 3, type: 'turn/end', data: { turn: 1 } },
  { seq: 4, type: 'turn/start', data: { turn: 2 } },
];

test('a reconstructed Codex turn can recall persisted observations absent from assistant text', () => {
  const session = { snapshotEvents: () => structuredClone(events) };
  const messages = [{ role: 'user', content: 'look up' }, { role: 'assistant', content: 'DONE' }, { role: 'user', content: 'recall the result' }];
  const history = codexToolHistory(session);
  const prompt = codexConversationPrompt({ input: 'recall the result', messages, toolHistory: history });
  assert.match(prompt, /HIDDEN_TOOL_VALUE/);
  assert.equal(prompt.split('User: recall the result').length - 1, 1);
  assert.deepEqual(codexToolHistory({ snapshotEvents: () => JSON.parse(JSON.stringify(events)) }), history, 'JSONL replay does not require native process state');
  assert.equal(history.length, 1);
  assert.equal(history[0].turn, 1);
  assert.equal(history[0].phase, 'completed');
});

test('missing, failed and unknown outcomes stay distinguishable; other session data stays out', () => {
  const failure = { seq: 6, type: 'agentkit/codex-tool', data: { callId: 'second:run', name: 'codex/command', phase: 'failed', arguments: '{}', content: [], error: { code: 'CODEX_TOOL_OUTCOME_UNKNOWN' } } };
  const history = codexToolHistory({ snapshotEvents: () => [...events, { seq: 5, type: 'private-event', data: { content: 'PRIVATE' } }, failure] });
  assert.equal(history.length, 2);
  assert.equal(history[1].error.code, 'CODEX_TOOL_OUTCOME_UNKNOWN');
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE|started/);
  assert.deepEqual(codexToolHistory(null), []);
  assert.equal(codexConversationPrompt({ input: 'hello' }), 'hello');
});

test('history is bounded by complete recent turns and output budget without mutating DSH facts', () => {
  const seed = Array.from({ length: 30 }, (_, n) => [
    { seq: n * 2, type: 'turn/start', data: { turn: n + 1 } },
    { seq: n * 2 + 1, type: 'agentkit/codex-tool', data: { callId: `${n}`, name: 'lookup', phase: 'completed', content: [{ type: 'text', text: 'x'.repeat(4000) }] } },
  ]).flat();
  const original = structuredClone(seed);
  const history = codexToolHistory({ snapshotEvents: () => seed }, { maxTurns: 2, maxChars: 1000 });
  assert.deepEqual(seed, original);
  assert.ok(JSON.stringify(history).length < 2000);
  assert.ok(history.every(item => item.turn >= 29));
  assert.match(history.at(-1).content[0].text, /truncated/);
});
