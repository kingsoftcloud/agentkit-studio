import assert from 'node:assert/strict';
import test from 'node:test';
import { readManagedSessionEvents } from '../src/managed-session-history.mjs';

const session = { sessionId: 'public-session', nativeSessionId: 'native-session', epoch: 'epoch-one' };
const nativeEvents = [0, 1].flatMap(turn => [
  { type: 'turn/start', data: {} },
  { type: 'user/message', data: { content: [{ type: 'text', text: 'internal context' }] } },
  { type: 'user/message', data: { source: { rpcId: `request-${turn}` }, content: [{ type: 'text', text: 'hello' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
]).map((event, seq) => ({ ...event, seq, time: 1700000000000 + seq }));

for (const limit of [1, 2, 3]) test(`backward event pages retain prefixes before the request header, limit ${limit}`, async () => {
  const before = JSON.stringify(nativeEvents);
  const handle = { read: async (offset, length) => ({ events: nativeEvents.slice(offset, offset + length) }) };
  const read = request => readManagedSessionEvents({ handle, session, latestSeq: nativeEvents.length,
    request, invocationId: async (_, requestId) => requestId, signal: new AbortController().signal });
  const full = await read({ Limit: 100 });
  assert.equal(full.Events.length, 10);
  const cursor = { HistoryEpoch: full.HistoryEpoch, SnapshotSeqId: full.SnapshotSeqId, CursorSource: full.CursorSource };
  let page = await read({ ...cursor, Limit: limit }), events = page.Events, pages = 1;
  while (page.HasMore) {
    assert.ok(pages++ < 20);
    page = await read({ ...cursor, Limit: limit, BeforeSeqId: page.NextCursor });
    events = [...page.Events, ...events];
  }
  assert.deepEqual(events, full.Events);
  assert.deepEqual(events.map(event => event.SeqId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(JSON.stringify(nativeEvents), before, 'Paging never appends or rewrites native history');
});

test('backward prefix ownership cannot use a header beyond the frozen snapshot', async () => {
  const ranges = [];
  const handle = { read: async (offset, length) => {
    ranges.push([offset, length]);
    return { events: nativeEvents.slice(offset, offset + length) };
  } };
  const page = await readManagedSessionEvents({ handle, session, latestSeq: nativeEvents.length,
    request: { Limit: 1, BeforeSeqId: 3, SnapshotSeqId: 2, HistoryEpoch: session.epoch },
    invocationId: async () => assert.fail('Request header is outside the snapshot'), signal: new AbortController().signal });
  assert.deepEqual(page.Events, []);
  assert.ok(ranges.every(([offset, length]) => offset + length <= 2));
});

test('backward prefix ownership cannot borrow the next turn request header', async () => {
  const events = structuredClone(nativeEvents);
  delete events[2].data.source;
  const handle = { read: async (offset, length) => ({ events: events.slice(offset, offset + length) }) };
  const page = await readManagedSessionEvents({ handle, session, latestSeq: events.length,
    request: { Limit: 1, BeforeSeqId: 3, SnapshotSeqId: events.length, HistoryEpoch: session.epoch },
    invocationId: async () => assert.fail('The next turn cannot establish this turn ownership'), signal: new AbortController().signal });
  assert.deepEqual(page.Events, []);
});

test('an exact offset total cannot silently truncate history at the projection budget', async () => {
  const events = Array.from({ length: 8193 }, (_, seq) => ({ type: 'request/header', data: {}, seq, time: seq }));
  const handle = { read: async (offset, length) => ({ events: events.slice(offset, offset + length) }) };
  await assert.rejects(readManagedSessionEvents({ handle, session, latestSeq: events.length,
    request: { Offset: 0, Limit: 1 }, invocationId: async () => assert.fail('No public turn exists'),
    signal: new AbortController().signal }), { code: 'HISTORY_PROJECTION_BUDGET_EXCEEDED' });
});

test('an empty explicit forward page preserves a cursor beyond the snapshot', async () => {
  const page = await readManagedSessionEvents({ handle: { read: async () => assert.fail('Nothing remains to read') },
    session, latestSeq: nativeEvents.length,
    request: { EventOrder: 'session_seq', AfterSeqId: 20, HistoryEpoch: session.epoch, SnapshotSeqId: nativeEvents.length },
    invocationId: async () => assert.fail('Nothing remains to project'), signal: new AbortController().signal });
  assert.deepEqual(page.Events, []);
  assert.equal(page.EventOrder, 'session_seq'); assert.equal(page.NextCursor, 20); assert.equal(page.HasMore, false);
});
