import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationDigest,
  nativeConversationRewindAdmission,
  nativeConversationRewindMarkers,
  NATIVE_CONVERSATION_REWIND_SOURCE,
} from '../src/providers/native-conversation-rewind.mjs';

// Data-only Session/head fixtures — no Host, Run store, or network. The
// scanner and admission helper are pure functions over event arrays, so the
// only surface they need is snapshotEvents()/isOwnSeq() and a head object.

function markerEvent(seq, nativeRewind) {
  return {
    type: 'user/message', seq,
    data: {
      id: `ak-native-rewind-${nativeRewind.commandId ?? 'x'}`,
      role: 'user',
      source: { kind: NATIVE_CONVERSATION_REWIND_SOURCE, nativeRewind },
      content: [{ type: 'text', text: '对话已回退到所选输入之前。工作区文件保留当前状态。' }],
    },
  };
}

function validMarker(over = {}) {
  const { seq = 4, ...rest } = over;
  return markerEvent(seq, {
    contract: 'native-conversation-rewind/v1',
    commandId: 'cmd-1',
    sessionId: 'sess-1',
    expectedHeadRunId: 'run-3',
    targetMessageId: 'm2',
    generation: 1,
    seed: { contract: 'native-conversation-fork/v1', messages: [{ role: 'user', content: 'kept input' }] },
    ...rest,
  });
}

function makeSession({ id = 'sess-1', events = [], ownSeqs } = {}) {
  const own = ownSeqs ?? new Set(events.map(event => event.seq));
  return { id, snapshotEvents: () => events, isOwnSeq: seq => own.has(seq) };
}

function makeHead({ runId = 'run-3', turnId = 'turn-2', generation = 0, commandId = 'cmd-1' } = {}) {
  return { runId, turnId, conversationBranch: { generation, commandId } };
}

test('scanner selects only own-source rewind marker events', () => {
  const marker = validMarker({ seq: 4 });
  const noise = [
    { type: 'assistant/message', seq: 1, data: { source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, data: { id: 'm1', source: { kind: 'user' }, content: [] } },
    { type: 'user/message', seq: 3, data: { id: 'm2', source: { kind: 'agentkit-native-conversation-fork' }, content: [] } },
  ];
  assert.deepEqual(nativeConversationRewindMarkers([]), [], 'no events yields no markers');
  assert.deepEqual(nativeConversationRewindMarkers(noise), [], 'non-marker events are ignored');
  assert.deepEqual(nativeConversationRewindMarkers([...noise, marker]), [marker], 'only the rewind marker is selected');
});

test('own marker is admitted with a frozen copy of the seed', () => {
  const seed = { contract: 'native-conversation-fork/v1',
    messages: [{ role: 'user', content: 'kept input' }], todos: [{ content: 'kept task', status: 'in_progress' }] };
  const event = validMarker({ seq: 4, sessionId: 'sess-1', generation: 3, commandId: 'cmd-1',
    expectedHeadRunId: 'run-3', targetMessageId: 'm2', seed });
  const session = makeSession({ id: 'sess-1', events: [event] });
  const head = makeHead({ runId: 'run-3', turnId: 'turn-2', generation: 0, commandId: 'cmd-1' });

  const admitted = nativeConversationRewindAdmission({ session, head, turn: 'turn-3' });

  assert.deepEqual(admitted.conversationSeed, seed, 'admitted the marker seed verbatim');
  assert.notEqual(admitted.conversationSeed, seed, 'seed is a frozen copy, not the marker reference');
  assert.deepEqual(admitted.conversationRewind, {
    contract: 'native-conversation-rewind/v1', commandId: 'cmd-1', expectedHeadRunId: 'run-3',
    generation: 3, markerDigest: conversationDigest(event),
  }, 'rewind carries the marker identity and digest');

  const seedBefore = JSON.parse(JSON.stringify(event.data.source.nativeRewind.seed));
  admitted.conversationSeed.messages.push({ role: 'assistant', content: 'tampered' });
  admitted.conversationRewind.commandId = 'tampered-cmd';
  assert.deepEqual(event.data.source.nativeRewind.seed, seedBefore, 'marker seed unchanged after mutating the admitted copy');
  assert.equal(event.data.source.nativeRewind.commandId, 'cmd-1', 'marker commandId unchanged after mutating the admitted rewind');
});

test('consumed marker does not reapply once the head generation catches up', () => {
  const event = validMarker({ seq: 4, sessionId: 'sess-1', generation: 3, commandId: 'cmd-1', expectedHeadRunId: 'run-3' });
  const session = makeSession({ id: 'sess-1', events: [event] });
  // The head sits on the branch this marker created: same generation, same
  // commandId. Admission returns nothing — the marker is consumed.
  const head = makeHead({ runId: 'run-4', turnId: 'turn-4', generation: 3, commandId: 'cmd-1' });
  assert.deepEqual(
    nativeConversationRewindAdmission({ session, head, turn: 'turn-5' }),
    {}, 'a consumed marker does not reapply');
});

test('same-turn redelivery preserves the exact admitted configuration', () => {
  const event = validMarker({ seq: 4, sessionId: 'sess-1', generation: 3, commandId: 'cmd-1' });
  const session = makeSession({ id: 'sess-1', events: [event] });
  const sameTurnConfiguration = {
    conversationSeed: { contract: 'native-conversation-fork/v1', messages: [{ role: 'user', content: 'redelivery seed' }] },
    conversationRewind: { contract: 'native-conversation-rewind/v1', commandId: 'cmd-1', expectedHeadRunId: 'run-3', generation: 3, markerDigest: 'deadbeef' },
  };
  const head = makeHead({ runId: 'run-3', turnId: 'turn-3', generation: 0, commandId: 'cmd-1' });

  const admitted = nativeConversationRewindAdmission({ session, head, turn: 'turn-3', sameTurnConfiguration });

  assert.deepEqual(admitted.conversationSeed, sameTurnConfiguration.conversationSeed, 'preserved the same-turn seed exactly');
  assert.deepEqual(admitted.conversationRewind, sameTurnConfiguration.conversationRewind, 'preserved the same-turn rewind exactly');
  assert.notEqual(admitted.conversationSeed, sameTurnConfiguration.conversationSeed, 'seed returned as a frozen copy');
  assert.notEqual(admitted.conversationRewind, sameTurnConfiguration.conversationRewind, 'rewind returned as a frozen copy');
  assert.notDeepEqual(admitted.conversationSeed, event.data.source.nativeRewind.seed, 'same-turn seed differs from the marker seed');
});

test('inherited parent markers do not act as child commands', () => {
  const parentMarker = validMarker({ seq: 2, sessionId: 'parent-sess', generation: 1, commandId: 'parent-cmd', expectedHeadRunId: 'run-1' });
  const childMarker = validMarker({ seq: 9, sessionId: 'child-sess', generation: 1, commandId: 'child-cmd', expectedHeadRunId: 'run-3' });
  const head = makeHead({ runId: 'run-3', turnId: 'turn-2', generation: 0 });

  // A parent marker names the parent session: the child admits nothing.
  const parentOnly = makeSession({ id: 'child-sess', events: [parentMarker] });
  assert.deepEqual(
    nativeConversationRewindAdmission({ session: parentOnly, head, turn: 'turn-3' }),
    {}, 'parent-only inherited markers are not admitted for the child');

  // With both markers, the child admits its own (seq 9 is own; seq 2 inherited).
  const child = makeSession({ id: 'child-sess', events: [parentMarker, childMarker], ownSeqs: new Set([9]) });
  const admitted = nativeConversationRewindAdmission({ session: child, head, turn: 'turn-3' });
  assert.equal(admitted.conversationRewind?.commandId, 'child-cmd', 'child admits its own marker, not the parent command');
  assert.equal(admitted.conversationRewind?.generation, 1);

  // A marker that carries the child's sessionId but sits on an inherited seq
  // is still rejected — the child did not append that event.
  const inheritedOwn = validMarker({ seq: 2, sessionId: 'child-sess', generation: 1, commandId: 'inherited-cmd', expectedHeadRunId: 'run-3' });
  const inherited = makeSession({ id: 'child-sess', events: [inheritedOwn], ownSeqs: new Set() });
  assert.deepEqual(
    nativeConversationRewindAdmission({ session: inherited, head, turn: 'turn-3' }),
    {}, 'inherited seqs are not admitted even when the sessionId matches');
});

test('per-Session generations allow parent generation 2 plus child generation 1', () => {
  const parentMarker = validMarker({ seq: 2, sessionId: 'parent-sess', generation: 2, commandId: 'parent-cmd', expectedHeadRunId: 'run-1' });
  const childMarker = validMarker({ seq: 9, sessionId: 'child-sess', generation: 1, commandId: 'child-cmd', expectedHeadRunId: 'run-3' });

  // The scanner tracks generation per sessionId, so the child's generation 1
  // does not regress against the earlier parent generation 2.
  const markers = nativeConversationRewindMarkers([parentMarker, childMarker]);
  assert.equal(markers.length, 2, 'both parent and child markers pass the scanner');
  assert.deepEqual(markers, [parentMarker, childMarker], 'generation counters are scoped per session');

  const session = makeSession({ id: 'child-sess', events: [parentMarker, childMarker], ownSeqs: new Set([9]) });
  const admitted = nativeConversationRewindAdmission({
    session, head: makeHead({ runId: 'run-3', turnId: 'turn-2', generation: 0 }), turn: 'turn-3',
  });
  assert.equal(admitted.conversationRewind?.generation, 1, 'child admits its own generation 1');
  assert.equal(admitted.conversationRewind?.commandId, 'child-cmd');
});

test('malformed markers are rejected by the scanner', () => {
  const cases = [
    ['wrong contract', { contract: 'wrong/v1' }],
    ['missing generation', { generation: undefined }],
    ['non-integer generation', { generation: 1.5 }],
    ['zero generation', { generation: 0 }],
    ['negative generation', { generation: -1 }],
    ['empty sessionId', { sessionId: '  ' }],
    ['missing commandId', { commandId: '' }],
    ['missing expectedHeadRunId', { expectedHeadRunId: '' }],
    ['missing targetMessageId', { targetMessageId: '' }],
    ['falsy seed', { seed: null }],
  ];
  for (const [label, over] of cases) {
    const event = validMarker({ seq: 2, ...over });
    assert.throws(
      () => nativeConversationRewindMarkers([event]),
      { code: 'native_conversation_rewind_marker_invalid' },
      `malformed marker rejected: ${label}`,
    );
  }
});

test('repeated or non-increasing generation is rejected for the same session', () => {
  const first = validMarker({ seq: 2, sessionId: 'sess-1', generation: 2, commandId: 'cmd-a' });
  const equal = validMarker({ seq: 5, sessionId: 'sess-1', generation: 2, commandId: 'cmd-b' });
  const lower = validMarker({ seq: 6, sessionId: 'sess-1', generation: 1, commandId: 'cmd-c' });
  assert.throws(() => nativeConversationRewindMarkers([first, equal]),
    { code: 'native_conversation_rewind_marker_invalid' }, 'equal generation rejected');
  assert.throws(() => nativeConversationRewindMarkers([first, lower]),
    { code: 'native_conversation_rewind_marker_invalid' }, 'lower generation rejected');
});

test('stale head is rejected when the head runId does not match the marker', () => {
  const event = validMarker({ seq: 4, sessionId: 'sess-1', generation: 3, commandId: 'cmd-1', expectedHeadRunId: 'run-3' });
  const session = makeSession({ id: 'sess-1', events: [event] });
  // The head advanced to a different run without admitting this marker.
  const head = makeHead({ runId: 'run-9', turnId: 'turn-2', generation: 0, commandId: 'old-cmd' });
  assert.throws(
    () => nativeConversationRewindAdmission({ session, head, turn: 'turn-3' }),
    { code: 'native_conversation_rewind_head_conflict' },
    'stale head runId rejected',
  );
});

test('head generation ahead of the latest own marker is a conflict', () => {
  const event = validMarker({ seq: 4, sessionId: 'sess-1', generation: 3, commandId: 'cmd-1', expectedHeadRunId: 'run-3' });
  const session = makeSession({ id: 'sess-1', events: [event] });
  assert.throws(
    () => nativeConversationRewindAdmission({
      session, head: makeHead({ runId: 'run-9', turnId: 'turn-2', generation: 5, commandId: 'cmd-1' }), turn: 'turn-3',
    }),
    { code: 'native_conversation_rewind_generation_conflict' },
    'head generation greater than the marker generation is rejected');
  assert.throws(
    () => nativeConversationRewindAdmission({
      session, head: makeHead({ runId: 'run-9', turnId: 'turn-2', generation: 3, commandId: 'cmd-other' }), turn: 'turn-3',
    }),
    { code: 'native_conversation_rewind_generation_conflict' },
    'equal generation with a divergent commandId is rejected');
});
