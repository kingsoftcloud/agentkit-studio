import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConversationHistory, projectSessionHistory, canonical } from '../dist/index.mjs';
import { fixture, digest, tool } from './fixtures.mjs';

// projectHistory only reads parent.snapshot and parent.configuration, so a plain
// object shaped like a StoredRun is sufficient (mirroring history.test.mjs) and
// avoids driving a full kernel run. fixture() supplies the real config/snapshot.
function makeParent({ phase = 'executing_tools', finalText = '', queuedGuidance = [], messages = [], config: override } = {}) {
  const { config, snapshot } = fixture({ tools: [tool()], instructions: 'System' });
  return { configuration: override ?? config,
    snapshot: { ...snapshot, phase, finalText, queuedGuidance, messages } };
}

test('an active source Run cut imports only the transcript up to the tool call and closes the unanswered call as unknown', () => {
  const parent = makeParent({ messages: [
    { role: 'user', content: 'Task' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'src-1', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'src-1', content: 'Future committed success' },
  ], queuedGuidance: [{ role: 'user', kind: 'guidance', content: 'Queued future instruction' }] });
  const { configuration: config } = parent;
  // Host-resolved cut boundary: the transcript prefix up to the tool call.
  const transcript = parent.snapshot.messages.slice(0, 2);
  const before = canonical(parent);

  const messages = projectConversationHistory(parent, transcript, config, digest, { identityNamespace: 'fork-1' });

  assert.equal(canonical(parent), before, 'source record is not mutated');
  assert.equal(parent.snapshot.messages[1].toolCalls[0].callId, 'src-1', 'source tool call id is untouched');

  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Task');
  const call = messages[1].toolCalls[0];
  assert.match(call.callId, /^hist_[a-f0-9]{32}$/);
  const closed = messages[2];
  assert.equal(closed.role, 'tool');
  assert.equal(closed.kind, 'incomplete_tool_observation');
  assert.equal(closed.callId, call.callId, 'unanswered call is paired to the remapped id');
  assert.equal(JSON.parse(closed.content).executionStatus, 'unknown');
  assert.ok(!messages.some(m => m.content === 'Future committed success'), 'post-cut tool success is not imported');
  assert.ok(!messages.some(m => m.content === 'Queued future instruction'), 'queued guidance is not imported');

  // The same active source is rejected by the default session-history projection.
  assert.throws(() => projectSessionHistory(parent, config, digest), { code: 'history_requires_terminal_parent' });
});

test('a conversation cut does not inherit the source final answer even when the source is terminal, unlike projectSessionHistory', () => {
  const finalText = 'Sealed final answer';
  const parent = makeParent({ phase: 'completed', finalText, messages: [
    { role: 'user', content: 'Task' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'src-1', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'src-1', content: 'Committed success' },
    { role: 'assistant', content: finalText },
  ] });
  const { configuration: config } = parent;
  const transcript = parent.snapshot.messages.slice(0, 2);

  const cut = projectConversationHistory(parent, transcript, config, digest, { identityNamespace: 'fork-1' });
  assert.ok(!cut.some(m => m.content === finalText), 'conversation cut does not append or inherit the source final answer');
  assert.ok(!cut.some(m => m.content === 'Committed success'), 'conversation cut does not import post-cut tool success');

  // Contrast: the default session-history projection on the same terminal source
  // does inherit the final answer.
  const session = projectSessionHistory(parent, config, digest);
  assert.ok(session.some(m => m.role === 'assistant' && m.content === finalText), 'session history inherits the source final answer');
});

test('an included tool result pairs with the remapped child-local id and preserves media and explicit provenance', () => {
  const parent = makeParent({ messages: [
    { role: 'user', kind: 'user_document_observation', content: 'Doc', media: [{ type: 'image', digest: 'd1' }] },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'src-1', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'src-1', content: 'Committed result' },
  ] });
  const { configuration: config } = parent;
  // Carry explicit provenance on the user message to verify it is preserved rather
  // than overwritten with the parent run id.
  const transcript = parent.snapshot.messages.map((m, i) =>
    i === 0 ? { ...m, history: { sourceRunId: 'other-run', sourceIndex: 5 } } : m);

  const messages = projectConversationHistory(parent, transcript, config, digest, { identityNamespace: 'fork-1' });

  const call = messages.find(m => m.role === 'assistant').toolCalls[0];
  const result = messages.find(m => m.role === 'tool');
  assert.match(call.callId, /^hist_[a-f0-9]{32}$/);
  assert.equal(result.callId, call.callId, 'tool result is paired to the remapped id');
  assert.equal(result.content, 'Committed result');

  const doc = messages[0];
  assert.equal(doc.kind, 'user_document_observation');
  assert.deepEqual(doc.media, [{ type: 'image', digest: 'd1' }]);
  assert.deepEqual(doc.history, { sourceRunId: 'other-run', sourceIndex: 5 },
    'explicit provenance is preserved, not overwritten with the parent run id');
});

test('an orphan tool result flushes the pending call as unknown and is quoted as a historical observation', () => {
  const parent = makeParent({ messages: [] });
  const { configuration: config } = parent;
  const transcript = [
    { role: 'user', content: 'Task' },
    { role: 'assistant', content: '', toolCalls: [{ callId: 'src-1', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'orphan', content: 'A separate historical receipt' },
  ];

  const messages = projectConversationHistory(parent, transcript, config, digest, { identityNamespace: 'fork-1' });

  const call = messages.find(m => m.role === 'assistant').toolCalls[0];
  assert.match(call.callId, /^hist_[a-f0-9]{32}$/);
  const closed = messages.find(m => m.kind === 'incomplete_tool_observation');
  assert.ok(closed, 'unanswered call is closed as unknown');
  assert.equal(closed.callId, call.callId);
  assert.equal(JSON.parse(closed.content).executionStatus, 'unknown');
  const orphan = messages.find(m => m.kind === 'historical_tool_observation');
  assert.ok(orphan, 'orphan receipt is quoted as a historical observation');
  assert.equal(orphan.role, 'user');
  assert.equal(JSON.parse(orphan.content).status, 'unmatched_tool_result');
  assert.ok(orphan.content.includes('A separate historical receipt'));
});

test('rejects an invalid conversation boundary but accepts an empty transcript', () => {
  const parent = makeParent({ messages: [] });
  const { configuration: config } = parent;
  assert.throws(() => projectConversationHistory(parent, 'not-an-array', config, digest, { identityNamespace: 'fork-1' }),
    { code: 'invalid_conversation_history_boundary' });
  assert.throws(() => projectConversationHistory(parent, [], config, digest, {}),
    { code: 'invalid_conversation_history_boundary' });
  assert.throws(() => projectConversationHistory(parent, [], config, digest, { identityNamespace: '' }),
    { code: 'invalid_conversation_history_boundary' });
  assert.throws(() => projectConversationHistory(parent, [], config, digest, { identityNamespace: '   ' }),
    { code: 'invalid_conversation_history_boundary' });
  assert.deepEqual(projectConversationHistory(parent, [], config, digest, { identityNamespace: 'fork-1' }), []);
});

test('retains provider replay for a matching profile with namespace-mapped ids and drops it when the profile differs', () => {
  const { config, snapshot } = fixture({ tools: [tool()], instructions: 'System' });
  config.profile.providerReplayMode = 'anthropic_content';
  const privateReplay = { compatibilityDigest: 'fixture/v1',
    anthropicContent: [{ type: 'tool_use', id: 'old', name: 'read', input: {} }] };
  const parent = { configuration: config,
    snapshot: { ...snapshot, phase: 'executing_tools', finalText: '', queuedGuidance: [], messages: [
      { role: 'assistant', content: '', toolCalls: [{ callId: 'old', name: 'read', arguments: {} }], providerReplay: privateReplay },
    ] } };
  const transcript = [...parent.snapshot.messages];

  const cut = projectConversationHistory(parent, transcript, config, digest, { identityNamespace: 'fork-1' });
  assert.deepEqual(cut[0].providerReplay, privateReplay);
  assert.equal(cut[0].replayToolIds.old, cut[0].toolCalls[0].callId,
    'replay id maps the original protocol id to the remapped id');

  const changed = { ...config, profile: { ...config.profile, profileVersion: '2' } };
  const dropped = projectConversationHistory(parent, transcript, changed, digest, { identityNamespace: 'fork-1' });
  assert.equal(dropped[0].providerReplay, undefined);
  assert.equal(dropped[0].replayToolIds, undefined);
});
