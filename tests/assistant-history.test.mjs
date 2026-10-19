import test from 'node:test';
import assert from 'node:assert/strict';
import { displayEvents, displayText } from '../src/assistant-history.mjs';
import { readAssistantHistory, readAssistantImage } from '../src/assistant-history-reader.mjs';

const image = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 3, width: 2, height: 2, name: 'picture.png' };
const file = { attachmentId: `sha256:${'b'.repeat(64)}`, bytes: 50, name: 'report.pdf' };
const user = (rpcId, text = rpcId, source = 'user') => ({ id: `message-${rpcId}`, role: 'user', source: { kind: source, rpcId }, content: [{ type: 'text', text }] });
const assistant = (turn, content, step = 1) => ({ turn, step, message: { id: `reply-${turn}-${step}`, role: 'assistant', source: { kind: 'model', provider: 'private-provider' }, content } });
function fixture() {
  const events = [], calls = [], inbox = { 'next-turn': [], 'next-step': [] };
  const add = (type, data) => { const event = { seq: events.length, time: 1000 + events.length, type, data };
    if (['user/message', 'assistant/message', 'tool/result'].includes(type)) event.surfaceOp = 'append'; events.push(event); return event; };
  const controller = {
    projections: async () => ({ kind: 'sequenced', asOfSeq: events.length - 1, values: { inbox } }),
    page: async request => { calls.push(request); const end = Math.min(request.beforeSeq ?? events.length, request.throughSeq + 1), start = Math.max(0, end - 12);
      return { records: events.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 }; },
    attachment: async () => ({ attachment: image, data: 'YWJj' }),
  };
  return { events, add, controller, inbox, calls, read: input => readAssistantHistory(controller, 'cloud-owned-session', input) };
}

test('safe native envelopes retain tool/image/file data and boundaries, omitting prompts, reasoning and diagnostics', async () => {
  const f = fixture();
  f.add('turn/start', { turn: 1 }); f.add('step/start', { turn: 1, step: 1 });
  f.add('user/message', user('one', '请研究一下'));
  f.add('system/message', { message: { content: [{ type: 'text', text: 'injected-system-secret' }] } });
  f.add('user/message', user('context', 'injected-catalog-secret', 'skill-catalog'));
  f.add('assistant/message', assistant(1, [{ type: 'reasoning', text: 'private-reasoning' }, { type: 'text', text: 'Results **ready**' }, { type: 'image', attachment: image }, { type: 'file', attachment: file }, { type: 'tool-call', id: 'call-one', name: 'search', arguments: '{"apiKey":"private-key"}' }]));
  f.add('tool/call', { turn: 1, step: 1, callId: 'call-one', name: 'search', arguments: 'private-argument' });
  f.add('tool/result', { turn: 1, step: 1, message: { id: 'result', role: 'tool', source: { kind: 'tool', callId: 'call-one' }, toolCallId: 'call-one', content: [{ type: 'text', text: 'Found useful evidence' }, { type: 'image', attachment: image }] }, meta: { password: 'private-meta' } });
  f.add('step/end', { turn: 1, step: 1, reason: { kind: 'completed' } }); f.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const result = await f.read();
  assert.equal(result.status, 'completed');
  const output = result.events.find(event => event.type === 'assistant/message');
  assert.equal(output.surfaceOp, 'append'); assert.equal(output.data.turn, 1); assert.equal(output.data.step, 1);
  assert.deepEqual(output.data.message.content.slice(1, 3), [{ type: 'image', attachment: image }, { type: 'file', attachment: file }]);
  assert.equal(result.events.find(event => event.type === 'tool/call').data.arguments, '{}');
  assert.match(JSON.stringify(result), /Found useful evidence/);
  for (const secret of ['injected-system-secret', 'injected-catalog-secret', 'private-reasoning', 'private-key', 'private-argument', 'private-meta', 'private-provider']) assert.ok(!JSON.stringify(result).includes(secret), secret);
});

test('current state is independent of older display page and of long-turn page truncation', async () => {
  const f = fixture();
  f.add('turn/start', { turn: 1 }); f.add('user/message', user('old')); f.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.add('turn/start', { turn: 2 }); f.add('user/message', user('current'));
  for (let i = 0; i < 220; i++) f.add('assistant/message', assistant(2, [{ type: 'text', text: `step ${i}` }], i + 1));
  assert.equal((await f.read()).status, 'running');
  const older = await f.read({ beforeSeq: 3 });
  assert.equal(older.status, 'running'); assert.deepEqual(older.messages.map(item => item.text), ['old']);
  assert.ok(f.calls.every(call => call.throughSeq === f.events.length - 1));
  assert.ok(f.calls.some(call => call.beforeSeq === 3));
});

test('native queued projection is visible and reconciles accepted request before any turn starts', async () => {
  const f = fixture(); f.inbox['next-turn'].push(user('queued')); f.add('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [...f.inbox['next-turn']] });
  const value = await f.read({ requestId: 'queued' });
  assert.equal(value.status, 'queued'); assert.equal(value.queuedCount, 1); assert.equal(value.queued[0].text, 'queued');
  assert.deepEqual(value.receipt, { accepted: true, observed: true, requestId: 'queued' });
});

test('internal policy and context notices never replace task status or count as queued work', async () => {
  for (const [reason, status] of [[null, 'idle'], ['completed', 'completed'], ['aborted', 'cancelled'], ['error', 'failed'], ['open', 'running']]) {
    const f = fixture();
    if (reason) {
      f.add('turn/start', { turn: 1 }); f.add('user/message', user('finished'));
      if (reason !== 'open') f.add('turn/end', { turn: 1, reason: { kind: reason } });
    }
    for (const kind of ['user-approval', 'runtime-context', 'skill-catalog']) {
      const notice = user(`hidden-${kind}`, 'private injected context', kind);
      f.inbox['next-step'].push(notice);
      f.add('agent/inbox/spliced', { target: 'next-step', start: f.inbox['next-step'].length - 1, inserted: [notice] });
    }
    const snapshot = await f.read({ requestId: 'hidden-user-approval' });
    assert.equal(snapshot.status, status); assert.equal(snapshot.queuedCount, 0); assert.deepEqual(snapshot.queued, []);
    assert.equal(snapshot.receipt, null); assert.equal(JSON.stringify(snapshot).includes('private injected context'), false);
  }
});

test('mixed native inbox counts only visible human and scheduled inputs, including attachment-only work', async () => {
  const f = fixture(); f.add('turn/start', { turn: 1 }); f.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.inbox['next-turn'].push(user('hidden-turn', '', 'runtime-context'), user('timer', 'private schedule context', 'schedule'));
  f.inbox['next-step'].push(user('hidden-step', '', 'user-approval'), { ...user('image-only'), content: [{ type: 'image', attachment: image }] });
  const snapshot = await f.read({ requestId: 'image-only' });
  assert.equal(snapshot.status, 'queued'); assert.equal(snapshot.queuedCount, 2);
  assert.deepEqual(snapshot.queued.map(message => [message.source.kind, message.target]), [['schedule', 'next-turn'], ['user', 'next-step']]);
  assert.equal(snapshot.queued[1].text, ''); assert.equal(snapshot.queued[1].content[0].type, 'image');
  assert.deepEqual(snapshot.receipt, { accepted: true, observed: true, requestId: 'image-only' });
});

test('receipt lookup traverses native history outside the display window, absent stays null', async () => {
  const f = fixture(); f.add('turn/start', { turn: 1 }); f.add('user/message', user('first'));
  for (let i = 0; i < 30; i++) f.add('assistant/message', assistant(1, [{ type: 'text', text: `${i}` }]));
  f.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const value = await f.read({ requestId: 'first' }); assert.equal(value.receipt.requestId, 'first'); assert.ok(!value.messages.some(row => row.requestId === 'first'));
  assert.equal((await f.read({ requestId: 'missing' })).receipt, null);
});

test('failed retries use only the exact failed turn rpcId, including messages beyond page limits', async () => {
  const f = fixture();
  f.add('turn/start', { turn: 1 }); f.add('user/message', user('unrelated')); f.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.add('turn/start', { turn: 2 }); f.add('user/message', user('failed-request', 'repeat this task'));
  for (let i = 0; i < 25; i++) f.add('assistant/message', assistant(2, [{ type: 'text', text: `${i}` }]));
  const end = f.add('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'provider-private', message: 'Bearer provider-secret' } } });
  const value = await f.read({ beforeSeq: 3 });
  assert.equal(value.status, 'failed'); assert.deepEqual(value.retry, { requestId: 'failed-request', text: 'repeat this task', turn: 2, endSeq: end.seq });
  assert.ok(!JSON.stringify(await f.read()).includes('provider-secret')); assert.ok(!JSON.stringify(await f.read()).includes('provider-private'));
});

test('schedule failure never retries an older manual request; combined turns do not arbitrarily pick one', async () => {
  const f = fixture(); f.add('turn/start', { turn: 1 }); f.add('user/message', user('manual')); f.add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.add('turn/start', { turn: 2 }); f.add('user/message', user('schedule', 'injected-schedule-prompt', 'schedule')); f.add('turn/end', { turn: 2, reason: { kind: 'error' } });
  assert.equal((await f.read()).retry, null); assert.ok(!JSON.stringify(await f.read()).includes('injected-schedule-prompt'));
  f.add('turn/start', { turn: 3 }); f.add('user/message', user('first')); f.add('user/message', user('second')); f.add('turn/end', { turn: 3, reason: { kind: 'error' } });
  assert.equal((await f.read()).retry, null);
});

test('pre-step failure recovers the exact claimed inbox request without inventing a human message', async () => {
  const f = fixture(); const pending = user('claimed', 'pre-step work');
  f.add('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [pending] });
  f.add('turn/start', { turn: 1 }); f.add('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  f.add('turn/end', { turn: 1, reason: { kind: 'error' } });
  const result = await f.read(); assert.equal(result.retry.requestId, 'claimed'); assert.deepEqual(result.messages, []);
});

test('migration-required hints never get passed as a sequenced history cursor', async () => {
  const f = fixture(); f.controller.projections = async () => ({ kind: 'migration-required', values: { inbox: { 'next-turn': [user('stale')] } } });
  const result = await f.read(); assert.equal(result.status, 'migration-required'); assert.equal(result.historyState, 'migration-required');
  assert.equal(result.asOfSeq, undefined); assert.equal(f.calls.length, 0); assert.equal(result.receipt, null);
});

test('cancelled turns stay cancelled and queued native work remains distinct', async () => {
  const f = fixture(); f.add('turn/start', { turn: 1 }); f.add('user/message', user('stopped')); f.add('turn/end', { turn: 1, reason: { kind: 'aborted', cause: { reason: 'private-cause' } } });
  assert.equal((await f.read()).status, 'cancelled'); assert.ok(!JSON.stringify(await f.read()).includes('private-cause'));
  f.inbox['next-turn'].push(user('next')); assert.equal((await f.read()).status, 'queued');
});

test('invalid or nonadvancing pages fail safely; invalid cursor is rejected before reading', async () => {
  const f = fixture(); let calls = 0; f.controller.projections = async () => { calls++; return { asOfSeq: 5 }; };
  await assert.rejects(f.read({ beforeSeq: -1 }), { code: 'ASSISTANT_CURSOR_INVALID' }); assert.equal(calls, 0);
  f.controller.page = async () => ({ records: [], hasMore: true }); await assert.rejects(f.read(), { code: 'ASSISTANT_HISTORY_INVALID' });
});

test('raw tool failures, approval reasons and goal failure details never cross the presentation boundary', () => {
  const events = displayEvents([
    { seq: 0, type: 'tool/result', data: { message: { toolCallId: 'call', isError: true, content: [{ type: 'text', text: 'raw secret error' }] }, error: { reason: 'raw exception' }, meta: { token: 'secret' } } },
    { seq: 1, type: 'approval/asked', data: { id: 'approval', toolName: 'write', reason: 'private reason' } },
    { seq: 2, type: 'approval/decided', data: { id: 'approval', outcome: 'unavailable' } },
    { seq: 3, type: 'goal/change', data: { version: 1, operation: 'block', goal: { id: 'goal', revision: 1, objective: 'Write report', phase: 'blocked', blockedReason: { message: 'private block' } } } },
    { seq: 4, type: 'deliverables/presented', data: { turn: 1, callId: 'present', files: [{ path: '/private/workspace/report.pdf', description: 'Final report' }] } },
  ]);
  const json = JSON.stringify(events); for (const secret of ['raw secret', 'raw exception', 'private reason', 'private block', '/private/workspace']) assert.ok(!json.includes(secret));
  assert.equal(events.length, 5); assert.equal(events[4].data.files[0].path, 'report.pdf');
});

test('credential-shaped data is redacted without altering ordinary visible prose', () => {
  assert.equal(displayText('A useful summary.'), 'A useful summary.');
  const credentialUrl = new URL('https://service.test'); credentialUrl.username = 'user'; credentialUrl.password = 'private-secret';
  for (const text of ['Authorization: Bearer private-secret', 'api_key="private-secret"', 'password: private-secret', credentialUrl.href, 'https://service.test?token=private-secret']) assert.ok(!displayText(text).includes('private-secret'));
});

test('image reads are session-scoped, native-authorized and bounded to safe validated raster data', async () => {
  const f = fixture(); f.add('turn/start', { turn: 1 }); f.add('assistant/message', assistant(1, [{ type: 'image', attachment: image }]));
  let called; f.controller.attachment = async input => { called = input; return { attachment: image, data: 'YWJj' }; };
  assert.deepEqual(await readAssistantImage(f.controller, 'cloud-owned-session', image.attachmentId), { attachment: image, data: 'YWJj' });
  assert.deepEqual(called, { sessionId: 'cloud-owned-session', attachmentId: image.attachmentId });
  f.controller.attachment = async () => ({ attachment: { ...image, attachmentId: file.attachmentId }, data: 'YWJj' });
  await assert.rejects(readAssistantImage(f.controller, 'cloud-owned-session', image.attachmentId), { code: 'ASSISTANT_IMAGE_INVALID' });
  f.controller.attachment = async () => ({ attachment: image, data: 'YWJjZA==' });
  await assert.rejects(readAssistantImage(f.controller, 'cloud-owned-session', image.attachmentId), { code: 'ASSISTANT_IMAGE_INVALID' });
});

test('image capability cannot expose images found only inside injected context or failed tools', async () => {
  const f = fixture(); f.add('user/message', { ...user('private', '', 'runtime-context'), content: [{ type: 'image', attachment: image }] });
  f.add('tool/result', { message: { toolCallId: 'failed', isError: true, content: [{ type: 'image', attachment: image }] } });
  f.controller.attachment = async () => { throw new Error('must not read private attachment'); };
  await assert.rejects(readAssistantImage(f.controller, 'cloud-owned-session', image.attachmentId), { code: 'ASSISTANT_IMAGE_NOT_FOUND' });
});

test('nested native tool dispatches preserve pairing and successful content while suppressing failure payloads', async () => {
  const f = fixture(); f.add('turn/start', { turn: 1 }); f.add('step/start', { turn: 1, step: 1 });
  f.add('tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: 'private program' });
  const ids = { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:1', name: 'search', arguments: { credential: 'private-credential' } };
  f.add('tool/ptc-dispatch-start', ids);
  f.add('tool/ptc-dispatch', { ...ids, isError: false, content: [{ type: 'text', text: 'Nested search result' }, { type: 'image', attachment: image }], meta: { secret: 'private-meta' } });
  f.add('tool/ptc-dispatch', { ...ids, subCallId: 'root:ptc:2', isError: true, content: [{ type: 'text', text: 'private-error' }], error: { message: 'private-error' } });
  const result = await f.read(), children = result.events.filter(event => event.type === 'tool/ptc-dispatch');
  assert.equal(children.length, 2); assert.equal(children[0].data.parentCallId, 'root'); assert.deepEqual(children[0].data.arguments, {});
  assert.equal(children[0].data.content[0].text, 'Nested search result');
  for (const secret of ['private-credential', 'private-meta', 'private-error', 'private program']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual((await readAssistantImage(f.controller, 'cloud-owned-session', image.attachmentId)).attachment, image);
});

test('image admission rejects oversized refs and non-raster metadata before native bytes are read', async () => {
  const f = fixture(); f.controller.attachment = async () => { throw new Error('should not read bytes'); };
  f.add('assistant/message', assistant(1, [{ type: 'image', attachment: { ...image, bytes: 21 * 1024 * 1024 } }]));
  await assert.rejects(readAssistantImage(f.controller, 'cloud-owned-session', image.attachmentId), { code: 'ASSISTANT_IMAGE_TOO_LARGE' });
  f.events[0].data.message.content[0].attachment = { ...image, mediaType: 'image/svg+xml' };
  await assert.rejects(readAssistantImage(f.controller, 'cloud-owned-session', image.attachmentId), { code: 'ASSISTANT_IMAGE_NOT_FOUND' });
});

test('failed-turn polling stops at its own boundary rather than rescanning years of completed work', async () => {
  const f = fixture();
  for (let turn = 1; turn < 1000; turn++) { f.add('turn/start', { turn }); f.add('user/message', user(`old-${turn}`)); f.add('turn/end', { turn, reason: { kind: 'completed' } }); }
  f.add('turn/start', { turn: 1000 }); f.add('user/message', user('latest')); f.add('turn/end', { turn: 1000, reason: { kind: 'error' } });
  const value = await f.read(); assert.equal(value.retry.requestId, 'latest'); assert.equal(f.calls.length, 1);
  assert.equal(value.lastTurn, 1000); assert.equal(value.currentTurn, null); assert.equal(value.lastTurnEndSeq, f.events.length - 1);
  f.add('turn/start', { turn: 1001 }); f.add('user/message', user('next'));
  for (let i = 0; i < 30; i++) f.add('assistant/message', assistant(1001, [{ type: 'text', text: `${i}` }]));
  const next = await f.read(); assert.equal(next.currentTurn, 1001); assert.equal(next.turnStartSeq, f.events.length - 32);
});

test('a pre-step claim outside the loaded prefix does not guess at an earlier request to retry', async () => {
  const f = fixture();
  f.add('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user('pre-step')] });
  for (let i = 0; i < 100; i++) f.add('model/selection', { provider: 'private', model: 'private' });
  f.add('turn/start', { turn: 1 }); f.add('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }); f.add('turn/end', { turn: 1, reason: { kind: 'error' } });
  const value = await f.read(); assert.equal(value.retry, null); assert.equal(f.calls.length, 1);
});

test('successful tool text redacts credential field aliases, environment assignments and cookie headers', () => {
  const inputs = [
    '{"token":"credential-canary","count":4}', 'AWS_SECRET_ACCESS_KEY=credential-canary', 'AWS_ACCESS_KEY_ID=credential-canary',
    'AWS_SESSION_TOKEN=credential-canary', '"private_key":"credential-canary"', 'auth-token: credential-canary',
    'sessionCredential = credential-canary', 'credentials: credential-canary', 'clientSecret="credential-canary"',
    'Cookie: ordinary=value; session=credential-canary', 'Set-Cookie: session=credential-canary; Path=/; Secure',
    '--token credential-canary', '--private-key "credential-canary"',
  ];
  for (const input of inputs) {
    const events = displayEvents([{ seq: 0, type: 'tool/result', data: { message: { toolCallId: 'tool', content: [{ type: 'text', text: input }] } } }]);
    assert.ok(!JSON.stringify(events).includes('credential-canary'), input);
  }
  assert.equal(displayText('Found 4 documents and 12 citations.'), 'Found 4 documents and 12 citations.');
});

test('reopened interrupted assistant prefixes retain the native interrupted marker and recent history window', async () => {
  const f = fixture(); f.add('turn/start', { turn: 1 }); f.add('step/start', { turn: 1, step: 1 });
  f.add('user/message', user('cancelled'));
  f.add('assistant/message', { ...assistant(1, [{ type: 'text', text: 'partial response' }]), interrupted: true, stream: [{ chunk: { type: 'reasoning-delta', text: 'private streamed reasoning' } }] });
  f.add('turn/end', { turn: 1, reason: { kind: 'aborted' } });
  const result = await f.read(), output = result.events.find(event => event.type === 'assistant/message');
  assert.equal(output.data.interrupted, true); assert.equal(output.data.message.content[0].text, 'partial response');
  assert.equal(result.status, 'cancelled'); assert.ok(!JSON.stringify(result).includes('private streamed reasoning'));
  assert.deepEqual(f.calls[0].turnWindow, { minMessages: 50, minTurns: 1 }); assert.equal(f.calls[0].maxMessages, 200);
});

test('truncated failed turn cannot retry manual A after later scheduled or manual B was claimed without admission', async () => {
  for (const kind of ['schedule', 'user']) {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.add('model/selection', { provider: 'private', model: 'private' });
    f.add('turn/start', { turn: 1 }); f.add('user/message', user('manual-A'));
    f.add('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [user('later-B', 'later work', kind)] });
    f.add('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] });
    f.add('turn/end', { turn: 1, reason: { kind: 'error' } });
    const value = await f.read(); assert.equal(value.retry, null, kind); assert.equal(f.calls.length, 1);
  }
});

test('a known inserted-and-claimed suffix request can be retried without full historical replay', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.add('model/selection', { provider: 'private', model: 'private' });
  f.add('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user('pre-step')] });
  f.add('turn/start', { turn: 1 }); f.add('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  f.add('turn/end', { turn: 1, reason: { kind: 'error' } });
  const value = await f.read(); assert.equal(value.retry.requestId, 'pre-step'); assert.equal(f.calls.length, 1);
});
