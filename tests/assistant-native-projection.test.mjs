import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectAssistantNativeEvent as event, projectAssistantNativePage as page, projectAssistantNativeFollowFrame as follow,
  projectAssistantNativeProjections as projections, projectAssistantNativeProjectionBaseline as baseline,
  projectAssistantNativeControlFrame as control, projectAssistantNativeAssistantFrame as live,
  projectAssistantNativeAssistantBaseline as assistantBaseline,
} from '../src/assistant-native-projection.mjs';

const secret = 'synthetic-private-canary';
const text = value => [{ type: 'text', text: value }];
const user = (kind = 'user', content = text('Hello')) => ({ id: 'original-message', role: 'user', content,
  source: { kind, rpcId: 'request-one', requestFingerprint: secret, principal: { token: secret }, form: 'snapshot', sections: [{ name: secret, text: secret }], private: secret }, private: secret });
const surface = (type, data, seq = 3) => ({ type, seq, time: 100 + seq, surfaceOp: 'append', data, secret });
const system = () => surface('system/message', { turn: 1, step: 1, message: { id: 'system-one', role: 'system', source: { kind: 'system-prompt', secret }, content: text(secret) }, secret });
const assistant = () => surface('assistant/message', { turn: 1, step: 1, message: { id: 'assistant-one', role: 'assistant', source: { kind: 'model', provider: secret, model: secret, replayState: { token: secret } }, content: [{ type: 'reasoning', text: secret }, ...text('A useful answer')] }, stream: [
  { type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['Bearer ', 'private-secret'] },
  { type: 'reasoning-chunks', time0: 3, index: 1, dt: [], texts: [secret] },
  { type: 'tool-call-chunks', time0: 4, index: 2, id: 'call-one', name: secret, dt: [], args: [secret] },
  { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' }, replayState: { response: secret } } },
], usage: { inputTokens: 10, outputTokens: 2, secret }, secret });
const privateInbox = () => ({ 'next-turn': [user('runtime-context', text(secret)), user()], 'next-step': [], secret });
const assertSafe = value => { assert.ok(!JSON.stringify(value).includes(secret)); assert.ok(!JSON.stringify(value).includes('private-secret')); };

test('surface projection preserves source event metadata and identity without copying internal message fields', () => {
  for (const input of [system(), surface('user/message', user('runtime-context', text(secret))), assistant()]) {
    const before = JSON.stringify(input), output = event(input); assertSafe(output);
    for (const field of ['type', 'seq', 'time', 'surfaceOp']) assert.deepEqual(output[field], input[field]);
    assert.equal(JSON.stringify(input), before); assert.equal(output.secret, undefined);
  }
  assert.deepEqual(event(system()).data.message.content, []);
  assert.deepEqual(event(assistant()).data.message.content, text('A useful answer'));
  const human = event(surface('user/message', user()));
  assert.deepEqual(human.data.source, { kind: 'user', rpcId: 'request-one' }); assert.deepEqual(human.data.content, text('Hello'));
});

test('durable split text blocks cannot reveal a credential after display assembly', () => {
  for (const content of [text('Bearer ').concat(text('split-private-value')),
    text('token=').concat([{ type: 'reasoning', text: secret }], text('split-private-value')),
    text('sk-abcdefgh').concat(text('ijklmnop'))]) {
    const output = event(surface('user/message', user('user', content)));
    assert.ok(!JSON.stringify(output).includes('split-private-value'));
    assert.ok(!JSON.stringify(output).includes('ijklmnop'));
    assert.ok(output.data.content.every(part => part.text === '[已隐藏凭据]'));
  }
  assert.deepEqual(event(surface('user/message', user('user', text('Ordinary ').concat(text('answer'))))).data.content,
    text('Ordinary ').concat(text('answer')));
});

test('replacement and source links are kept exactly while nested envelope extras are omitted', () => {
  const input = { ...system(), seq: 8, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5, secret }, sourceEventSeqs: [3, 5] };
  const output = event(input); assertSafe(output);
  assert.deepEqual(output.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 5 }); assert.deepEqual(output.sourceEventSeqs, [3, 5]);
  for (const surfaceOp of [undefined, { op: 'replace', startSeq: 8, endSeq: 9 }, { op: 'replace', startSeq: 5, endSeq: 3 }]) assert.throws(() => event({ ...input, surfaceOp }), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
});

test('developer clearing removes headerSeq with tool additions and strips request catalog/config secrets', () => {
  const output = event(surface('developer/message', { turn: 1, step: 1, headerSeq: 0, message: { id: 'developer-one', role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: secret }] } }));
  assertSafe(output); assert.equal(output.data.headerSeq, undefined); assert.deepEqual(output.data.message.content, []);
  const header = event({ type: 'request/header', seq: 0, time: 0, data: { reason: 'initial', header: { config: { provider: secret, model: secret, stop: [secret] }, tools: [{ name: secret, description: secret }] } } });
  assert.deepEqual(header.data, { reason: 'initial', header: { config: { provider: '', model: '' } } });
});

test('private and unknown non-surface events become explicit one-to-one ignorable placeholders', () => {
  for (const type of ['approval/asked', 'approval/decided', 'tool/call', 'tool/ptc-dispatch', 'image/offload', 'plugin:future/private']) {
    assert.deepEqual(event({ type, seq: 20, time: 42, data: { nested: secret } }), { type: 'agentkit/privacy-redacted', seq: 20, time: 42, ignorable: true, data: { sourceSeq: 20 } });
  }
  assert.equal(event({ type: 'plugin:future/private', seq: 0, time: 0, data: secret }).data.sourceSeq, 0);
  assert.throws(() => event(surface('new/surface', {})), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
});

test('tool result identity is retained but result bodies, failures and tool-private metadata are omitted', () => {
  const output = event(surface('tool/result', { turn: 1, step: 1, message: { id: 'tool-message', role: 'tool', toolCallId: 'call-one', source: { kind: 'tool', callId: 'call-one', secret }, isError: true, content: text(secret) }, error: { name: secret, code: secret, reason: secret }, meta: { secret } }));
  assertSafe(output); assert.equal(output.data.message.toolCallId, 'call-one'); assert.equal(output.data.message.isError, true); assert.deepEqual(output.data.message.content, []);
});

test('inbox splices and baselines preserve hidden occurrence positions and human request correlation', () => {
  const value = { type: 'agent/inbox/spliced', seq: 0, time: 0, data: { target: 'next-turn', start: 4, removedCount: 2, inserted: privateInbox()['next-turn'], outcome: 'canceled', secret } };
  const output = event(value); assertSafe(output);
  assert.equal(output.data.start, 4); assert.equal(output.data.removedCount, 2); assert.equal(output.data.outcome, 'canceled'); assert.equal(output.data.inserted.length, 2);
  assert.equal(output.data.inserted[0].source.kind, 'runtime-context'); assert.deepEqual(output.data.inserted[0].content, []);
  assert.equal(output.data.inserted[1].source.rpcId, 'request-one');
  const b = baseline({ asOfSeq: 20, values: { inbox: privateInbox(), userQuestions: { active: [{ question: secret }] }, approval: { allowed: true }, custom: secret } });
  assertSafe(b); assert.deepEqual(Object.keys(b.values), ['inbox']); assert.equal(b.values.inbox['next-turn'].length, 2);
});

test('known context producers keep required source structure but no private fields; future source fails closed', () => {
  const sources = [
    { kind: 'skill-invocation', name: secret, form: 'instructions' }, { kind: 'skill-catalog', form: 'catalog', entries: [{ name: secret, description: secret }] },
    { kind: 'agent-instructions', form: 'instructions', changes: [{ path: secret }], baselineIdentity: secret },
    { kind: 'session-reference', form: 'recall', version: 1, references: [{ label: secret, sessionId: secret }] },
    { kind: 'compact-checkpoint', compactionId: 'compact-one', sourceCommandId: 'command-one' },
    { kind: 'goal', goalId: 'goal-one', revision: 1, round: 1 }, { kind: 'user-question-reply', callId: 'call-one', outcome: 'answered' },
    { kind: 'agent-message', form: 'relay', senderSessionId: secret }, { kind: 'subagent-settled', form: 'notice', summary: secret, senderSessionId: secret },
    { kind: 'team-message', teamId: secret, messageId: 'team-message-one', senderId: secret, senderName: secret },
    { kind: 'webhook', provider: secret, source: secret, deliveryId: secret, ruleId: secret, form: 'notice', summary: secret },
  ];
  for (const source of sources) { const output = event(surface('user/message', { ...user(source.kind, text(secret)), source })); assertSafe(output); assert.equal(output.data.source.kind, source.kind); }
  assert.throws(() => event(surface('user/message', user('future-source'))), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
});

test('all stream channels retain dense indexes but never expose chunk-level text or replay data', () => {
  const output = event(assistant()); assertSafe(output); assert.deepEqual(output.data.stream[0].texts, ['', '']);
  assert.deepEqual(output.data.stream[0].dt, [1]); assert.equal(output.data.stream[2].id, 'call-one');
  for (const chunk of [
    { type: 'text-delta', index: 0, text: secret }, { type: 'reasoning-delta', index: 1, text: secret },
    { type: 'tool-call-delta', index: 2, id: 'call-one', name: secret, argumentsDelta: secret },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: secret } },
    { type: 'block-end', index: 0, block: { type: 'text', text: secret } },
    { type: 'finish', reason: { kind: 'error', failure: { message: secret, code: secret } }, replayState: { response: secret } },
  ]) {
    const source = { type: 'chunk', attemptId: 'attempt-one', revision: 4, index: 2, time: 10, chunk, secret };
    const result = live(source); assertSafe(result);
    assert.equal(result.index, 2); assert.equal(result.revision, 4); assert.equal(result.chunk.type, chunk.type);
  }
  const reconnect = assistantBaseline({ revision: 10, activeAttempt: { attemptId: 'attempt-one', startedAfterSeq: -1, turn: 1, step: 1, nextIndex: 5, stream: assistant().data.stream, secret }, secret });
  assertSafe(reconnect); assert.equal(reconnect.activeAttempt.nextIndex, 5); assert.equal(reconnect.activeAttempt.stream.length, 4);
});

test('live starts and settlements preserve the actual attempt and committed source event', () => {
  assert.deepEqual(live({ type: 'start', attemptId: 'attempt-one', revision: 1, startedAfterSeq: -1, turn: 1, step: 1, secret }), { type: 'start', attemptId: 'attempt-one', revision: 1, startedAfterSeq: -1, turn: 1, step: 1 });
  assert.deepEqual(live({ type: 'end', attemptId: 'attempt-one', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3, secret } }), { type: 'end', attemptId: 'attempt-one', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } });
  assert.throws(() => live({ type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 1, chunk: { type: 'future-provider-object', secret } }), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
});

test('control baseline and updates never cross the bound Session or expose unsupported capability projections', () => {
  const p = { asOfSeq: 1, values: { inbox: privateInbox(), permissions: { currentValue: secret } } };
  assertSafe(control({ type: 'baseline', value: { projections: { own: p, foreign: { secret } } } }, 'own'));
  assert.deepEqual(Object.keys(control({ type: 'baseline', value: { projections: { own: p, foreign: p } } }, 'own').value.projections), ['own']);
  assert.equal(control({ type: 'projection', sessionId: 'foreign', key: 'inbox', value: privateInbox(), seq: 3 }, 'own'), null);
  assert.equal(control({ type: 'projection', sessionId: 'own', key: 'userQuestions', value: { secret }, seq: 3 }, 'own'), null);
  const result = control({ type: 'projection', sessionId: 'own', key: 'inbox', value: privateInbox(), seq: 3, secret }, 'own');
  assertSafe(result); assert.equal(result.seq, 3); assert.equal(result.value['next-turn'].length, 2);
});

test('projections retain lifecycle facts and explicit absence or migration without stale metadata', () => {
  assert.equal(projections(null), null); assert.deepEqual(projections({ kind: 'migration-required', values: { secret } }), { kind: 'migration-required', values: {} });
  const output = projections({ kind: 'sequenced', asOfSeq: 10, values: { turnBoundary: { openTurnStartSeq: null, lastStepStartSeq: 2, lastStepBoundary: { kind: 'end', seq: 8, secret }, lastTurn: 1, secret }, sessionListMetadata: { blank: false, lastPromptAt: 20, secret }, secret } });
  assertSafe(output); assert.equal(output.values.turnBoundary.lastStepBoundary.seq, 8); assert.equal(output.values.sessionListMetadata.blank, false);
});

test('follow/page projection is one-to-one, source-scoped and immutable with all opening side-channels sanitized', () => {
  const value = { type: 'snapshot', header: { version: 4, id: 'own', createdAt: 100, isSeeded: false, cwd: secret, agentPreset: secret }, cursor: 3,
    records: [{ type: 'event', event: system() }], hasMore: true, projections: { asOfSeq: 3, values: { inbox: privateInbox() } }, assistantStream: { revision: 0 }, secret };
  const original = JSON.stringify(value), output = follow(value, 'own'); assertSafe(output); assert.equal(JSON.stringify(value), original);
  assert.equal(output.cursor, 3); assert.equal(output.records[0].event.seq, 3); assert.equal(output.hasMore, true);
  assert.deepEqual(output.header, { version: 4, id: 'own', createdAt: 100, isSeeded: false });
  assert.throws(() => follow(value, 'foreign'), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
  assert.throws(() => page({ records: [value.records[0], { type: 'event', event: { ...system(), seq: 5 } }], hasMore: false }), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
});

test('invalid structures fail closed without forwarding the raw error or private payload', () => {
  for (const input of [{}, null, { type: 'turn/start', seq: 0, time: 0, data: null }, { ...system(), seq: -1 }, { ...system(), sourceEventSeqs: [3] }]) assert.throws(() => event(input), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
  const failed = event({ type: 'turn/end', seq: 9, time: 9, data: { turn: 1, reason: { kind: 'error', error: { message: secret, code: secret } } } }); assertSafe(failed);
  const aborted = event({ type: 'turn/end', seq: 9, time: 9, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: secret } } } }); assertSafe(aborted);
  assert.equal(aborted.data.reason.reason.kind, 'hook');
});


test('oversized content is a byte-bounded labeled preview after full-message redaction, without mutating identity or source', () => {
  for (const text of ['文😀'.repeat(100000), '\n\"\\'.repeat(100000)]) {
    const value = surface('user/message', user('user', [{ type: 'text', text }])), original = JSON.stringify(value), result = event(value);
    assert.ok(Buffer.byteLength(JSON.stringify(result.data.content)) <= 32768);
    assert.match(result.data.content.at(-1).text, /展示预览已截断.*源消息未改动.*勿作执行输入/);
    assert.equal(result.data.id, value.data.id); assert.deepEqual(result.data.source, { kind: 'user', rpcId: 'request-one' });
    assert.equal(JSON.stringify(value), original);
    assert.ok(!result.data.content[0].text.endsWith('\uD83D'), 'no split surrogate');
  }
  const sensitive = surface('user/message', user('user', [{ type: 'text', text: 'Bearer ' }, { type: 'text', text: 'private-value'.repeat(1000) }]));
  const output = event(sensitive);
  assert.ok(!JSON.stringify(output).includes('private-value'), 'truncation never precedes whole-message credential detection');
  assert.ok(output.data.content.every(part => part.text === '[已隐藏凭据]'));
});

test('message preview bounds many text/attachment blocks together, including inbox projections', () => {
  const content = Array.from({ length: 1000 }, () => ({ type: 'file', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'report.txt', bytes: 1 } }));
  const output = baseline({ asOfSeq: 1, values: { inbox: { 'next-turn': [user('user', content)], 'next-step': [] } } });
  const preview = output.values.inbox['next-turn'][0];
  assert.ok(Buffer.byteLength(JSON.stringify(preview.content)) <= 32768); assert.match(preview.content.at(-1).text, /展示预览已截断/);
  assert.equal(preview.id, 'original-message'); assert.equal(preview.source.rpcId, 'request-one');
});


test('large compact replay is omitted without changing attempt cursor, revision, or durable message', () => {
  const stream = [{ type: 'text-chunks', time0: 0, index: 0, dt: Array(60000).fill(1), texts: Array(60001).fill(secret) }];
  const value = assistant(); value.data.stream = stream;
  assert.deepEqual(event(value).data.stream, []); assert.deepEqual(event(value).data.message.content, text('A useful answer'));
  const result = assistantBaseline({ revision: 60002, activeAttempt: { attemptId: 'attempt', startedAfterSeq: 5, turn: 1, step: 1, nextIndex: 60001, stream } });
  assert.deepEqual(result.activeAttempt.stream, []); assert.equal(result.activeAttempt.nextIndex, 60001); assert.equal(result.revision, 60002);
  assert.equal(stream[0].texts.length, 60001);
});

test('oversized inbox bodies are withheld across baseline, control, and splices without moving echo identities', () => {
  const inserted = Array.from({ length: 150 }, (_, index) => ({ ...user(), id: `message-${index}`, source: { kind: 'user', rpcId: `rpc-${index}` }, content: text('visible '.repeat(1500)) }));
  const value = { 'next-turn': inserted, 'next-step': [] };
  const b = baseline({ asOfSeq: 1, values: { inbox: value } }).values.inbox['next-turn'];
  const c = control({ type: 'projection', sessionId: 'own', key: 'inbox', seq: 1, value }, 'own').value['next-turn'];
  const e = event({ type: 'agent/inbox/spliced', seq: 1, time: 1, data: { target: 'next-turn', start: 0, inserted } }).data.inserted;
  for (const output of [b, c, e]) {
    assert.ok(Buffer.byteLength(JSON.stringify(output)) < 32768); assert.equal(output.length, inserted.length);
    assert.deepEqual(output.map(message => [message.id, message.source.rpcId]), inserted.map(message => [message.id, message.source.rpcId]));
    assert.ok(output.every(message => message.content.length === 0));
  }
  assert.throws(() => baseline({ asOfSeq: 1, values: { inbox: { 'next-turn': Array(10000).fill(user()), 'next-step': [] } } }), { code: 'ASSISTANT_NATIVE_PROJECTION_UNAVAILABLE' });
});

test('unbroken oversized ASCII tokens are withheld as a whole before credential regex processing', () => {
  const value = event(surface('user/message', user('user', text('x'.repeat(100000)))));
  assert.equal(value.data.content.length, 1); assert.match(value.data.content[0].text, /展示预览已截断/); assert.ok(!value.data.content[0].text.includes('xxxxx'));
});
