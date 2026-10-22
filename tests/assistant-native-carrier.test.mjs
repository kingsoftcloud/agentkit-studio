import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantNativeCarrierService } from '../src/assistant-native-carrier.mjs';
const wait = signal => signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
const tick = () => new Promise(setImmediate);
const sourceEvent = { type: 'agent/private', seq: 0, time: 1, data: { private: 'CANARY' } };
const sourcePage = { records: [{ type: 'event', event: sourceEvent }], hasMore: false };
function fixture(options = {}) {
  let policy, removed = 0;
  const peers = [], calls = [], streams = [], writes = [];
  const gateway = {
    async invoke(request) {
      calls.push(request);
      if (options.invoke) return options.invoke(request);
      if (request.method === 'page') return sourcePage;
      if (request.method === 'projections') return { kind: 'sequenced', asOfSeq: 0, values: { secret: 'CANARY' } };
      return { items: [{ sessionId: 'session', updatedAt: 3, running: false, blank: false, agentAvailable: true, cwd: 'CANARY',
        projections: { kind: 'sequenced', asOfSeq: 0, values: { secret: 'CANARY' } } }, { sessionId: 'foreign', cwd: 'CANARY' }] };
    },
    wireStream: { async open(endpoint, payload, uplink, peer, signal) {
      streams.push({ endpoint, payload, peer, signal });
      if (options.stream) return options.stream(endpoint, signal);
      return (async function* () {
        if (endpoint === '$events') {
          yield { type: 'ready', clientId: 'real-generation', host: { home: 'CANARY' } };
          yield { type: 'emit', event: 'api-session/status', args: ['session', true] };
          yield { type: 'emit', event: 'api-session/status', args: ['foreign', true] };
          yield { type: 'emit', event: 'api-session/status', args: ['session', 'CANARY'] };
          yield { type: 'emit', event: 'CANARY', args: ['CANARY'] };
          yield { type: 'waterfall', request: { private: 'CANARY' } };
        } else if (endpoint === 'session/control') yield { type: 'baseline', value: { projections: {
          session: { asOfSeq: 0, values: { secret: 'CANARY' } }, foreign: { asOfSeq: 0, values: { secret: 'CANARY' } },
        } } };
        else yield { type: 'snapshot', header: { version: 1, id: 'session', createdAt: 0, isSeeded: false, private: 'CANARY' }, cursor: 0,
          ...sourcePage, projections: { asOfSeq: 0, values: { secret: 'CANARY' } }, assistantStream: { revision: 0 } };
        await wait(signal);
      })();
    } },
  };
  const access = { registerPolicy(_name, value) { policy = value; return () => { removed++; }; }, invalidate() {} };
  const service = createAssistantNativeCarrierService({ ctx: { get: name => ({ typertGateway: gateway, remoteAccess: access })[name] },
    createPeer: ({ principal, interactions }) => {
      const abort = new AbortController();
      const peer = { principal, interactions, signal: abort.signal, disposals: 0, async dispose() { this.disposals++; abort.abort(); } };
      peers.push(peer); return peer;
    }, pollMs: 5, idleMs: 1000, ...options.limits });
  const runAssistant = async (operation, payload) => {
    writes.push({ operation, payload });
    if (options.write) return options.write(operation, payload);
    if (operation === 'cancel') return { accepted: true };
    return operation === 'submit' ? { accepted: true, requestId: payload.requestId, sessionId: 'session' }
      : { receiptId: 'file-receipt', attachment: { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'report.txt', bytes: 4 } };
  };
  const opened = service.open({ sessionId: 'session', runAssistant });
  const request = (op, payload = {}, options) => service.request('session', op, { carrierId: opened.carrierId, ...payload }, options);
  const call = (endpoint, args, options) => request('native-call', { channel: '/api', endpoint, payload: { args } }, options);
  const open = (endpoint, args = {}, streamId = endpoint.replaceAll('/', '-').replace('$', '')) => request('native-stream-open', { streamId, endpoint, payload: { args } });
  return { service, opened, request, call, open, peers, calls, streams, writes, policy: () => policy, removed: () => removed, runAssistant };
}

test('non-owner read policy is limited to exact active session; advertised facade writes do not grant native writes', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  assert.equal(f.peers[0].principal.kind.startsWith('agentkit-assistant-native:'), true);
  assert.equal(f.peers[0].interactions, 'answer');
  const bindings = f.policy().bindings(f.peers[0].principal);
  assert.deepEqual(bindings[0].resource, { kind: 'session', id: 'session' });
  for (const action of ['session/list', 'session/control']) assert.ok(bindings[0].role.actions.includes(action), 'catalog RPCs also need exact-session filtering grants');
  assert.ok(bindings.every(binding => !binding.role.actions.includes('session/prompt')));
  assert.deepEqual(f.policy().bindings({ ...f.peers[0].principal }), [], 'copied principal never gains an internal Peer grant');
  assert.equal(f.opened.capabilities.owner, false);
  assert.ok(f.opened.capabilities.grants[0].actions.includes('session/prompt'));
  await f.request('native-close');
  assert.deepEqual(f.policy().bindings(f.peers[0].principal), []);
});

test('cross-session handle and subagent addressing are rejected before upstream', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await assert.rejects(f.service.request('foreign', 'native-call', { carrierId: f.opened.carrierId }), /原生/);
  for (const address of [{ kind: 'session', sessionId: 'foreign' }, { kind: 'subagent', sessionId: 'session', childSessionId: 'foreign' }]) {
    assert.equal((await f.call('session/page', { request: { address } })).ok, false);
  }
  assert.equal(f.calls.length, 0);
});

test('closed RPC allowlist rejects native commands, policy, paths, steer and event results', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  for (const endpoint of ['$events/result', 'session/create', 'session/selectModel', 'commands/execute', 'settings/write', 'session/modelCatalog', 'session/openWorkspacePath']) {
    assert.equal((await f.call(endpoint, {})).ok, false);
  }
  assert.equal((await f.call('session/prompt', { request: { sessionId: 'session', requestId: 'req', mode: 'steer', content: [{ type: 'text', text: 'hello' }] } })).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0);
});

test('page, projections and list remove foreign session and private fields', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  const outputs = await Promise.all([
    f.call('session/page', { request: { address: { kind: 'session', sessionId: 'session' } } }),
    f.call('session/projections', { request: { sessionId: 'session' } }), f.call('session/list', { _request: {} }),
  ]);
  assert.ok(outputs.every(result => result.ok));
  assert.ok(!JSON.stringify(outputs).includes('CANARY')); assert.ok(!JSON.stringify(outputs).includes('foreign'));
  assert.equal(outputs[0].value.records[0].event.seq, 0);
  assert.equal(outputs[0].value.records[0].event.type, 'agentkit/privacy-redacted');
});

test('prompt and upload use durable facade only, and request cancellation cannot cancel accepted work', async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ write: async (operation, payload) => {
    if (operation === 'submit') { await pending; return { accepted: true, requestId: payload.requestId, sessionId: 'session' }; }
    return { receiptId: 'receipt', attachment: { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'r.txt', bytes: 4 } };
  } }); t.after(() => f.service.dispose());
  const abort = new AbortController();
  const submission = f.call('session/prompt', { request: { sessionId: 'session', requestId: 'req', mode: 'queue', clientTimeZone: 'UTC', content: [{ type: 'text', text: 'hello' }] } }, { signal: abort.signal });
  abort.abort(); finish();
  assert.deepEqual(await submission, { ok: true, value: { accepted: true } });
  const upload = await f.call('fileUploads/upload', { agentId: 'session', request: { name: 'r.txt', data: 'ZGF0YQ==' } });
  assert.equal(upload.ok, true); assert.equal(upload.value.receiptId, 'receipt');
  assert.deepEqual(f.writes.map(row => row.operation), ['submit', 'attachment-upload']); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.writes[0].payload, { requestId: 'req', timezone: 'UTC', content: [{ type: 'text', text: 'hello' }] });
});

test('inline image bytes and caller fingerprints never bypass receipt admission', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  const input = { sessionId: 'session', requestId: 'req', mode: 'queue', content: [{ type: 'image', mediaType: 'image/png', data: 'secret' }] };
  assert.equal((await f.call('session/prompt', { request: input })).ok, false);
  assert.equal((await f.call('session/prompt', { request: { ...input, content: [{ type: 'text', text: 'ok' }], requestFingerprint: 'spoofed' } })).ok, false);
  assert.equal(f.writes.length, 0);
});

test('event generation is real but only the bound running flag leaves the carrier', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.open('$events'); await tick();
  const result = await f.request('native-stream-poll', { streamId: 'events' });
  assert.deepEqual(result, { items: [{ type: 'ready', clientId: 'real-generation', host: { home: '' } },
    { type: 'emit', event: 'api-session/status', args: ['session', true] }], ended: false });
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

test('native cancel is bound to the exact session and never reaches read RPCs', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  assert.equal((await f.call('session/cancel', { request: { sessionId: 'foreign' } })).ok, false);
  assert.equal((await f.call('session/cancel', { request: {} })).ok, false);
  assert.deepEqual(await f.call('session/cancel', { request: { sessionId: 'session' } }), { ok: true, value: { accepted: true } });
  assert.deepEqual(f.writes.map(row => row.operation), ['cancel']);
  assert.equal(f.calls.length, 0);
});

test('control and follow streams sanitize all output paths while access advertises only facade capabilities', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.open('session/control');
  await f.open('session/follow', { request: { address: { kind: 'session', sessionId: 'session' }, assistantStream: true } });
  await f.open('remoteAccess/follow'); await tick();
  for (const streamId of ['session-control', 'session-follow', 'remoteAccess-follow']) {
    const result = await f.request('native-stream-poll', { streamId });
    assert.ok(!JSON.stringify(result).includes('CANARY')); assert.ok(!JSON.stringify(result).includes('foreign'));
    assert.equal(result.items.length, 1);
  }
  assert.equal(f.streams.length, 2, 'facade access baseline does not leak native grants');
});

test('poll cancellation releases only its stream; carrier and cloud task remain alive', async t => {
  const f = fixture(); t.after(() => f.service.dispose());
  await f.open('$events'); await tick(); await f.request('native-stream-poll', { streamId: 'events' });
  const abort = new AbortController();
  const pending = f.request('native-stream-poll', { streamId: 'events' }, { signal: abort.signal });
  abort.abort(); await assert.rejects(pending);
  assert.equal(f.streams[0].signal.aborted, true); assert.equal(f.service.activeCount(), 1); assert.equal(f.writes.length, 0);
  assert.equal(f.peers[0].signal.aborted, false);
});

test('one pending poll per stream and bounded inflight prevent unbounded waits', async t => {
  const f = fixture({ limits: { pollMs: 100, idleMs: 1000, maxInflight: 1 } }); t.after(() => f.service.dispose());
  await f.open('$events'); await tick(); await f.request('native-stream-poll', { streamId: 'events' });
  const first = f.request('native-stream-poll', { streamId: 'events' });
  await assert.rejects(f.request('native-stream-poll', { streamId: 'events' }), error => error.code === 'ASSISTANT_NATIVE_INFLIGHT_LIMIT');
  await f.request('native-stream-cancel', { streamId: 'events' });
  assert.equal((await first).ended, true);
});

test('stream overflow fails closed without returning raw diagnostics', async t => {
  const f = fixture({ limits: { maxFrames: 1 }, stream: async function* () {
    yield { type: 'ready', clientId: 'one', host: { home: 'CANARY' } };
    yield { type: 'ready', clientId: 'two', host: { home: 'CANARY' } };
  } }); t.after(() => f.service.dispose());
  await f.open('$events'); await tick();
  const result = await f.request('native-stream-poll', { streamId: 'events' });
  assert.equal(result.ended, true); assert.equal(result.items.length, 1); assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

test('idle expiry revokes a peer, and close/cancel remain idempotent', async () => {
  const timers = new Map(); let stamp = 0, clock = 0;
  const f = fixture({ limits: { now: () => clock, setTimer: fn => { const id = ++stamp; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) } });
  await f.open('$events'); await tick();
  clock = 1001; for (const callback of [...timers.values()]) callback(); await tick();
  assert.equal(f.service.activeCount(), 0); assert.equal(f.peers[0].signal.aborted, true);
  assert.deepEqual(await f.request('native-close'), { closed: true });
  await f.service.dispose(); assert.equal(f.removed(), 1);
});

test('carrier and stream counts are bounded and disposal rejects new work', async () => {
  const f = fixture({ limits: { maxCarriers: 1, maxStreams: 1 } });
  assert.throws(() => f.service.open({ sessionId: 'session', runAssistant: f.runAssistant }), error => error.code === 'ASSISTANT_NATIVE_CARRIER_LIMIT');
  await f.open('$events');
  await assert.rejects(f.open('session/control'), error => error.code === 'ASSISTANT_NATIVE_STREAM_LIMIT');
  await f.service.dispose();
  assert.equal(f.peers[0].disposals, 1); assert.equal(f.service.activeCount(), 0);
  assert.throws(() => f.service.open({ sessionId: 'session', runAssistant: f.runAssistant }));
});

test('backend errors are generic, and rejected writes never acknowledge durable acceptance', async t => {
  const f = fixture({ invoke: () => { throw new Error('CANARY provider secret'); }, write: () => { throw new Error('CANARY flush failed'); } });
  t.after(() => f.service.dispose());
  for (const result of [await f.call('session/list', { _request: {} }), await f.call('session/prompt', { request: {
    sessionId: 'session', requestId: 'req', mode: 'queue', content: [{ type: 'text', text: 'hello' }],
  } })]) { assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('CANARY')); }
});

test('known durable rejection codes survive with fixed safe messages', async t => {
  const f = fixture({ write: () => { throw Object.assign(new Error('CANARY private details'), { code: 'ASSISTANT_REQUEST_CONFLICT' }); } });
  t.after(() => f.service.dispose());
  const result = await f.call('session/prompt', { request: { sessionId: 'session', requestId: 'req', mode: 'queue', content: [{ type: 'text', text: 'hello' }] } });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'ASSISTANT_REQUEST_CONFLICT');
  assert.ok(!JSON.stringify(result).includes('CANARY')); assert.deepEqual(result.error.details, {});
});

function controlledClock() {
  let time = 0, serial = 0; const timers = new Map();
  return { now: () => time,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, due: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= time) { timers.delete(id); timer.fn(); }
    },
  };
}

test('presence begins only after a genuine ready frame is polled; unrelated activity does not renew it', async t => {
  const clock = controlledClock(), disconnected = [];
  const f = fixture({ limits: { ...clock, idleMs: 60000, presenceMs: 35000, onSessionDisconnect: id => disconnected.push(id) } });
  t.after(() => f.service.dispose());
  assert.equal(f.service.hasLiveSession('session'), false);
  await f.open('session/control'); await tick(); await f.request('native-stream-poll', { streamId: 'session-control' });
  assert.equal(f.service.hasLiveSession('session'), false);
  await f.open('$events'); await tick();
  assert.equal(f.service.hasLiveSession('session'), false, 'server-side opening or queued ready does not mean it was observed');
  await f.request('native-stream-poll', { streamId: 'events' });
  assert.equal(f.service.hasLiveSession('session'), true);
  assert.equal(f.service.hasLiveSession('foreign'), false);
  clock.advance(30000); await f.call('session/list', { _request: {} });
  assert.equal(f.service.hasLiveSession('session'), true);
  clock.advance(5000);
  assert.equal(f.service.hasLiveSession('session'), false);
  assert.deepEqual(disconnected, ['session']);
  assert.equal(f.service.activeCount(), 1, 'presence timeout is separate from carrier idle cleanup');
  clock.advance(1000); assert.equal(f.service.hasLiveSession('session'), false);
  assert.deepEqual(disconnected, ['session'], 'expired presence withdraws once');
});

test('completed subsequent event polls renew the observation deadline without renewing permission', async t => {
  const clock = controlledClock(), disconnected = [];
  const f = fixture({ limits: { ...clock, idleMs: 60000, presenceMs: 35000, onSessionDisconnect: id => disconnected.push(id) } });
  t.after(() => f.service.dispose());
  await f.open('$events'); await tick(); await f.request('native-stream-poll', { streamId: 'events' });
  clock.advance(30000);
  const next = f.request('native-stream-poll', { streamId: 'events' });
  clock.advance(5); await next;
  clock.advance(4995); assert.equal(f.service.hasLiveSession('session'), true);
  clock.advance(30005); assert.equal(f.service.hasLiveSession('session'), false);
  assert.deepEqual(disconnected, ['session']);
  assert.ok(f.policy().bindings(f.peers[0].principal).every(binding => !binding.role.actions.includes('session/prompt')));
});

test('presence combines two independent carriers of the same Session and withdraws only the last one', async t => {
  const disconnected = [], f = fixture({ limits: { onSessionDisconnect: id => disconnected.push(id) } });
  t.after(() => f.service.dispose());
  await f.open('$events'); await tick(); await f.request('native-stream-poll', { streamId: 'events' });
  const second = f.service.open({ sessionId: 'session', runAssistant: f.runAssistant });
  const request = (op, input) => f.service.request('session', op, { carrierId: second.carrierId, ...input });
  await request('native-stream-open', { streamId: 'events', endpoint: '$events', payload: { args: {} } });
  await tick(); await request('native-stream-poll', { streamId: 'events' });
  await f.request('native-close');
  assert.equal(f.service.hasLiveSession('session'), true); assert.deepEqual(disconnected, []);
  await request('native-close');
  assert.equal(f.service.hasLiveSession('session'), false); assert.deepEqual(disconnected, ['session']);
  await request('native-close'); assert.deepEqual(disconnected, ['session']);
});

test('poll abort, upstream end, Peer disposal and service disposal all withdraw observed presence', async () => {
  for (const mode of ['poll-abort', 'upstream-end', 'peer-dispose', 'service-dispose']) {
    const disconnected = [];
    let finish;
    const end = new Promise(resolve => { finish = resolve; });
    const f = fixture({ limits: { onSessionDisconnect: id => disconnected.push(id) },
      ...(mode === 'upstream-end' ? { stream: async function* (_endpoint, signal) {
        yield { type: 'ready', clientId: 'real-generation', host: { home: '' } };
        await Promise.race([end, wait(signal)]);
      } } : {}) });
    try {
      await f.open('$events'); await tick(); await f.request('native-stream-poll', { streamId: 'events' });
      assert.equal(f.service.hasLiveSession('session'), true, mode);
      if (mode === 'poll-abort') {
        const abort = new AbortController(), pending = f.request('native-stream-poll', { streamId: 'events' }, { signal: abort.signal });
        abort.abort(); await assert.rejects(pending);
      } else if (mode === 'upstream-end') { finish(); await tick(); }
      else if (mode === 'peer-dispose') { await f.peers[0].dispose(); await tick(); }
      else await f.service.dispose();
      assert.equal(f.service.hasLiveSession('session'), false, mode);
      assert.deepEqual(disconnected, ['session'], mode);
      assert.equal(f.writes.length, 0);
    } finally { await f.service.dispose(); }
  }
});

const largeRecords = (count, characters = 8192) => Array.from({ length: count }, (_, seq) => ({ type: 'event', event: {
  type: 'user/message', seq, time: seq, surfaceOp: 'append', data: { id: `user-${seq}`, role: 'user', source: { kind: 'user', rpcId: `request-${seq}` }, content: [{ type: 'text', text: '文'.repeat(characters) }] },
} }));

test('byte-aware follow and pages are dense suffixes with source cursors and progress, even if native message groups exceed the hint', async t => {
  const records = largeRecords(50), original = JSON.stringify(records), snapshots = [];
  const f = fixture({ invoke: ({ args }) => ({ records: records.slice(0, args.request.beforeSeq ?? records.length), hasMore: false }),
    stream: async function* (_endpoint, signal) {
      yield { type: 'snapshot', header: { version: 4, id: 'session', createdAt: 0, isSeeded: false }, cursor: 49,
        records, hasMore: false, projections: { asOfSeq: 49, values: {} }, assistantStream: { revision: 0 } };
      await wait(signal);
    } }); t.after(() => f.service.dispose());
  const request = { address: { kind: 'session', sessionId: 'session' }, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 }, assistantStream: true };
  await f.open('session/follow', { request }); await tick();
  const polled = await f.request('native-stream-poll', { streamId: 'session-follow' });
  assert.equal(polled.ended, false); assert.equal(polled.error, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(polled)) <= 256 * 1024);
  const snapshot = polled.items[0]; snapshots.push(snapshot);
  assert.equal(snapshot.cursor, 49); assert.equal(snapshot.records.at(-1).event.seq, 49); assert.equal(snapshot.hasMore, true);
  const normalized = f.streams[0].payload.args.request;
  assert.equal(normalized.maxMessages, 16); assert.equal(normalized.turnWindow, undefined);
  assert.deepEqual(normalized.address, request.address); assert.equal(request.maxMessages, 500);
  let joined = snapshot.records, hasMore = snapshot.hasMore;
  while (hasMore) {
    const beforeSeq = joined[0].event.seq;
    const response = await f.call('session/page', { request: { ...request, throughSeq: 49, beforeSeq } });
    assert.equal(response.ok, true); assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 256 * 1024);
    const page = response.value; assert.ok(page.records.length > 0); assert.equal(page.records.at(-1).event.seq, beforeSeq - 1);
    assert.equal(f.calls.at(-1).args.request.throughSeq, 49); assert.equal(f.calls.at(-1).args.request.beforeSeq, beforeSeq);
    assert.equal(f.calls.at(-1).args.request.turnWindow, undefined); assert.equal(f.calls.at(-1).args.request.maxMessages, 16);
    joined = [...page.records, ...joined]; hasMore = page.hasMore;
  }
  assert.deepEqual(joined.map(record => record.event.seq), records.map(record => record.event.seq));
  assert.equal(JSON.stringify(records), original);
});

test('one oversized message becomes an explicit safe preview on page and live event paths', async t => {
  const records = largeRecords(1, 500000), original = JSON.stringify(records);
  const f = fixture({ invoke: () => ({ records, hasMore: false }), stream: async function* (_endpoint, signal) { yield records[0]; await wait(signal); } });
  t.after(() => f.service.dispose());
  const result = await f.call('session/page', { request: { address: { kind: 'session', sessionId: 'session' }, throughSeq: 0 } });
  assert.equal(result.ok, true); assert.equal(result.value.hasMore, false); assert.equal(result.value.records.length, 1);
  assert.match(result.value.records[0].event.data.content.at(-1).text, /展示预览已截断/);
  await f.open('session/follow', { request: { address: { kind: 'session', sessionId: 'session' } } }); await tick();
  const live = await f.request('native-stream-poll', { streamId: 'session-follow' });
  assert.equal(live.ended, false); assert.equal(live.error, undefined);
  assert.deepEqual(live.items[0], result.value.records[0]); assert.ok(Buffer.byteLength(JSON.stringify(live)) < 256 * 1024);
  assert.equal(JSON.stringify(records), original);
});

test('byte windows never rewrite surface replacement or source references, and irreducible structure fails closed', async t => {
  const records = largeRecords(40);
  records.at(-1).event.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 0 };
  records.at(-1).event.sourceEventSeqs = [0];
  const f = fixture({ invoke: () => ({ records, hasMore: false }) }); t.after(() => f.service.dispose());
  const result = await f.call('session/page', { request: { address: { kind: 'session', sessionId: 'session' }, throughSeq: 39 } });
  assert.equal(result.ok, true); assert.equal(result.value.hasMore, true); assert.ok(result.value.records[0].event.seq > 0);
  assert.deepEqual(result.value.records.at(-1).event.surfaceOp, records.at(-1).event.surfaceOp);
  assert.deepEqual(result.value.records.at(-1).event.sourceEventSeqs, [0]);
  const tiny = fixture({ limits: { maxBytes: 128 }, invoke: () => ({ records: records.slice(-1), hasMore: true }) }); t.after(() => tiny.service.dispose());
  const rejected = await tiny.call('session/page', { request: { address: { kind: 'session', sessionId: 'session' }, throughSeq: 39 } });
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'ASSISTANT_NATIVE_RESPONSE_TOO_LARGE');
});
