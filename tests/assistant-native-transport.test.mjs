import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createAssistantNativeTransport } from '../src/client/dsh/assistant-native-transport.mjs';
const scope = 'a'.repeat(64);
const receipt = { receiptId: 'receipt-one', kind: 'image', mediaType: 'image/png', attachment: { attachmentId: 'sha256:' + 'b'.repeat(64), name: 'one.png', bytes: 3 } };
const input = { sessionId: 'cloud-session', requestId: 'request-one', mode: 'queue', clientTimeZone: 'UTC', content: [{ type: 'image', mediaType: 'image/png', data: 'YWJj', name: 'one.png' }] };
const prompt = value => ['/api', 'session/prompt', { args: { request: value } }];
function bench({ memory = new Map(), change, scopeId = scope, sessionId = 'cloud-session', crypto = webcrypto } = {}) {
  const calls = [], storage = { get length() { return memory.size; }, key: index => [...memory.keys()][index] ?? null, getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  const execute = async (_agent, operation, value, signal) => {
    calls.push({ operation, value, signal });
    if (operation === 'native-open') return { carrierId: webcrypto.randomUUID(), sessionId, journalScope: scopeId, representation: 'assistant-public-projection/v1', capabilities: { owner: false, durableSubmit: true } };
    if (change) { const response = await change(operation, value, signal); if (response !== undefined) return response; }
    if (operation === 'attachment-upload') return { ...receipt, kind: value.kind, ...(value.kind === 'file' ? { mediaType: undefined } : {}) };
    if (operation === 'native-call') return { ok: true, value: { accepted: true } };
    return {};
  };
  return { calls, memory, storage, open: () => createAssistantNativeTransport({ execute, agentId: 'assistant', storage, crypto }) };
}

test('native image send journals only receipt before durable submission and preserves exact ID', async () => {
  const b = bench({ change(operation, value) { if (operation === 'native-call') {
    const saved = [...b.memory.values()].join(); assert.ok(saved.includes('receipt-one')); assert.ok(!saved.includes('YWJj'));
    assert.deepEqual(value.payload.args.request, { sessionId: 'cloud-session', requestId: 'request-one', mode: 'queue', content: [{ type: 'image', receiptId: 'receipt-one', mediaType: 'image/png', name: 'one.png' }], clientTimeZone: 'UTC' });
  } } });
  const transport = await b.open();
  assert.deepEqual(await transport.rpc.call(...prompt(input)), { ok: true, value: { accepted: true } });
  assert.equal(b.memory.size, 0); assert.equal(b.calls.filter(row => row.operation === 'attachment-upload').length, 1);
  await transport.dispose();
});

test('lost ACK restores receipt journal without reupload and rejects content changes on the same ID', async () => {
  let unknown = true;
  const b = bench({ change(operation) { if (operation === 'native-call' && unknown) throw new Error('ACK lost'); } });
  const first = await b.open();
  assert.equal((await first.rpc.call(...prompt(input))).ok, false);
  assert.ok(first.getState().pending); assert.equal(b.memory.size, 1);
  assert.equal((await first.rpc.call(...prompt({ ...input, content: [{ ...input.content[0], name: 'changed.png' }] }))).ok, false);
  assert.equal(b.calls.filter(row => row.operation === 'attachment-upload').length, 1);
  await first.dispose(); unknown = false;
  const second = await b.open(); assert.equal(second.getState().pending.request.requestId, input.requestId);
  assert.equal(await second.confirm(), true);
  assert.equal(b.calls.filter(row => row.operation === 'attachment-upload').length, 1); assert.equal(b.memory.size, 0);
  await second.dispose();
});

test('new deployment or native Session never recovers a prior deployment journal', async () => {
  const b = bench({ change(operation) { if (operation === 'native-call') throw new Error('lost'); } });
  const first = await b.open(); await first.rpc.call(...prompt(input)); await first.dispose();
  for (const options of [{ scopeId: 'c'.repeat(64) }, { sessionId: 'other-session' }]) {
    const next = await bench({ memory: b.memory, ...options }).open(); assert.equal(next.getState().pending, null); await next.dispose();
  }
});

test('storage failure prevents durable admission; different pending ID prevents accidental duplicate', async () => {
  const b = bench({ change(operation) { if (operation === 'native-call') throw new Error('lost'); } });
  const first = await b.open(); await first.rpc.call(...prompt(input));
  assert.equal((await first.rpc.call(...prompt({ ...input, requestId: 'different' }))).ok, false);
  assert.equal(b.calls.filter(row => row.operation === 'native-call').length, 1);
  await first.dispose();
  const c = bench(); c.storage.setItem = () => { throw new Error('storage full'); };
  const second = await c.open(); assert.equal((await second.rpc.call(...prompt(input))).ok, false);
  assert.equal(c.calls.filter(row => row.operation === 'native-call').length, 0); await second.dispose();
});

test('native file upload uses the dedicated bounded attachment channel and cannot address a foreign session', async () => {
  const b = bench(), transport = await b.open();
  const args = { agent: 'cloud-session', request: { name: 'one.txt', data: 'YWJj' } };
  assert.equal((await transport.rpc.call('/api', 'fileUploads/upload', { args })).ok, true);
  assert.equal((await transport.rpc.call('/api', 'fileUploads/upload', { args: { ...args, agent: 'foreign' } })).ok, false);
  assert.equal(b.calls.filter(row => row.operation === 'attachment-upload').length, 1);
  assert.equal(b.calls.filter(row => row.operation === 'native-call').length, 0); await transport.dispose();
});

test('disposing a poll cancels only its stream and closes its carrier, never cloud work', async () => {
  let polling;
  const b = bench({ change(operation, value, signal) {
    if (operation === 'native-stream-open') return { opened: true };
    if (operation === 'native-stream-poll') return new Promise((resolve, reject) => { polling = true; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  } });
  const transport = await b.open(), controller = new AbortController();
  const stream = transport.rpc.open('/api', 'session/follow', { args: {} }, controller.signal)[Symbol.asyncIterator]();
  const waiting = stream.next().catch(error => error);
  while (!polling) await new Promise(resolve => setTimeout(resolve, 0));
  await transport.dispose(); await waiting;
  assert.ok(b.calls.some(row => row.operation === 'native-stream-cancel'));
  assert.ok(b.calls.some(row => row.operation === 'native-close'));
  assert.ok(!b.calls.some(row => /cancel-turn|^cancel$/.test(row.operation)));
});

test('every native operation carries the same explicit conversation, including attachments and close', async () => {
  const b = bench();
  const transport = await createAssistantNativeTransport({ execute: async (id, operation, value, signal) => {
    assert.equal(value.conversation, 'custom-conversation');
    if (operation === 'native-open') return { carrierId: 'carrier-custom', sessionId: 'cloud-session', journalScope: scope, representation: 'assistant-public-projection/v1', capabilities: { owner: false, durableSubmit: true } };
    if (operation === 'attachment-upload') return receipt;
    if (operation === 'native-call') return { ok: true, value: { accepted: true } };
    if (operation === 'native-stream-poll') return { items: [], ended: true };
    return {};
  }, agentId: 'assistant', conversation: 'custom-conversation', storage: b.storage, crypto: webcrypto });
  await transport.rpc.call(...prompt(input));
  for await (const _item of transport.rpc.open('/api', '$events', { args: {} }, new AbortController().signal)) { /* no rows */ }
  await transport.dispose();
});

test('expired receipts can be discarded only after a deterministic not-admitted answer', async () => {
  let code = 'ASSISTANT_REQUEST_CONFLICT';
  const b = bench({ change(operation) { if (operation === 'native-call') return { ok: false, error: { code, message: 'safe failure' } }; } });
  const transport = await b.open(); await transport.rpc.call(...prompt(input));
  assert.equal(transport.discardExpired(), false); assert.equal(b.memory.size, 1);
  code = 'ASSISTANT_ATTACHMENT_EXPIRED'; assert.equal(await transport.confirm(), false);
  assert.equal(transport.discardExpired(), true); assert.equal(b.memory.size, 0);
  await transport.dispose();
});

test('malformed journal blocks admission and survives unchanged for recovery', async () => {
  const key = `agentkit.assistant.native.pending.${scope}.cloud-session`;
  const b = bench({ memory: new Map([[key, '{broken']]) }), transport = await b.open();
  assert.equal(transport.getState().invalid, true); assert.equal(await transport.confirm(), false);
  assert.equal((await transport.rpc.call(...prompt(input))).ok, false);
  assert.equal(b.memory.get(key), '{broken');
  assert.equal(b.calls.filter(call => call.operation === 'native-call').length, 0);
  await transport.dispose();
});

test('closing during image upload cannot admit a late result to the old session', async () => {
  const uploaded = Promise.withResolvers(), started = Promise.withResolvers();
  const b = bench({ change(operation) { if (operation === 'attachment-upload') { started.resolve(); return uploaded.promise; } } });
  const transport = await b.open(), sending = transport.rpc.call(...prompt(input));
  await started.promise; await transport.dispose(); uploaded.resolve(receipt);
  assert.equal((await sending).ok, false); assert.equal(b.memory.size, 0);
  assert.equal(b.calls.filter(call => call.operation === 'native-call').length, 0);
});

test('validates all attachment limits before uploading or digesting unsupported data', async () => {
  const b = bench(), transport = await b.open();
  for (const content of [Array.from({ length: 9 }, () => input.content[0]), [{ ...input.content[0], data: 'broken base64' }], [{ type: 'text', text: 'x'.repeat(32001) }]]) {
    assert.equal((await transport.rpc.call(...prompt({ ...input, content }))).ok, false);
  }
  assert.equal(b.calls.filter(call => call.operation === 'attachment-upload').length, 0); assert.equal(b.memory.size, 0);
  await transport.dispose();
});

test('terminal carrier errors block the native graph and preserve the safe failure marker', async () => {
  const b = bench({ change(operation) { if (operation === 'native-stream-poll') throw Object.assign(new Error('gone'), { code: 'ASSISTANT_NATIVE_STALE' }); } });
  const transport = await b.open();
  await assert.rejects(async () => { for await (const _ of transport.rpc.open('/api', '$events', {}, new AbortController().signal, { emptyUplink: true })) { /* no data */ } }, error => error.dshRemoteStreamFailure?.kind === 'remote');
  assert.equal(transport.getState().disconnected, true);
  await transport.dispose();
});

test('two simultaneous composers cannot overwrite or delete another unknown-ACK request journal', { timeout: 10000 }, async () => {
  const uploadA = Promise.withResolvers(), uploadB = Promise.withResolvers(); let uploads = 0, unknown = true;
  const hashes = [Promise.withResolvers(), Promise.withResolvers()], hashing = Promise.withResolvers();
  const firstUpload = Promise.withResolvers(), bothUploads = Promise.withResolvers(); let digestCalls = 0;
  const crypto = { randomUUID: () => webcrypto.randomUUID(), subtle: { async digest(...args) {
    const index = digestCalls++;
    if (digestCalls === 2) hashing.resolve();
    const result = await webcrypto.subtle.digest(...args);
    await hashes[index].promise; return result;
  } } };
  const b = bench({ crypto, change(operation, value) {
    if (operation === 'attachment-upload') {
      uploads++; firstUpload.resolve(value.name); if (uploads === 2) bothUploads.resolve();
      // Request identity owns the gate; WebCrypto completion order does not.
      return value.name === 'request-A.png' ? uploadA.promise : uploadB.promise;
    }
    if (operation === 'native-call' && value.payload.args.request.requestId === 'request-A' && unknown) throw Error('A ACK lost');
  } });
  const first = await b.open(), second = await b.open();
  const sendingA = first.rpc.call(...prompt({ ...input, requestId: 'request-A', content: [{ ...input.content[0], name: 'request-A.png' }] }));
  const sendingB = second.rpc.call(...prompt({ ...input, requestId: 'request-B', content: [{ ...input.content[0], name: 'request-B.png' }] }));
  await hashing.promise;
  // Reproduce the schedule that used to swap the gates and deadlock awaiting A.
  hashes[1].resolve(); assert.equal(await firstUpload.promise, 'request-B.png');
  hashes[0].resolve(); await bothUploads.promise;
  uploadA.resolve({ ...receipt, receiptId: 'receipt-A' }); assert.equal((await sendingA).ok, false);
  uploadB.resolve({ ...receipt, receiptId: 'receipt-B' }); assert.equal((await sendingB).ok, true);
  assert.equal(b.memory.size, 1); assert.match([...b.memory.keys()][0], /request-A$/);
  assert.equal(first.getState().pending.request.requestId, 'request-A');
  unknown = false; assert.equal(await first.confirm(), true);
  assert.deepEqual(b.calls.filter(call => call.operation === 'native-call').map(call => call.value.payload.args.request.requestId), ['request-A', 'request-B', 'request-A']);
  assert.equal(b.memory.size, 0); assert.equal(uploads, 2);
  await first.dispose(); await second.dispose();
});

test('refresh enumerates independent pending records and confirms each original ID without an index race', async () => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()]; let uploads = 0, unknown = true;
  const b = bench({ change(operation) {
    if (operation === 'attachment-upload') return gates[uploads++].promise;
    if (operation === 'native-call' && unknown) throw Error('ACK lost');
  } });
  const first = await b.open(), second = await b.open();
  const sends = [first.rpc.call(...prompt({ ...input, requestId: 'request-A' })), second.rpc.call(...prompt({ ...input, requestId: 'request-B' }))];
  while (uploads < 2) await new Promise(resolve => setTimeout(resolve, 0));
  gates[0].resolve({ ...receipt, receiptId: 'receipt-A' }); gates[1].resolve({ ...receipt, receiptId: 'receipt-B' });
  await Promise.all(sends); assert.equal(b.memory.size, 2); await first.dispose(); await second.dispose();
  unknown = false;
  const refreshed = await b.open(); assert.equal(refreshed.getState().pending.request.requestId, 'request-A');
  assert.equal(await refreshed.confirm(), true); assert.equal(refreshed.getState().pending.request.requestId, 'request-B');
  assert.equal(await refreshed.confirm(), true); assert.equal(b.memory.size, 0); assert.equal(await refreshed.confirm(), false);
  assert.equal(uploads, 2); await refreshed.dispose();
});

test('legacy single-key native journals remain recoverable with the same receipt and request ID', async () => {
  let unknown = true;
  const b = bench({ change(operation) { if (operation === 'native-call' && unknown) throw Error('ACK lost'); } });
  const first = await b.open(); await first.rpc.call(...prompt(input)); await first.dispose();
  const [[perRequest, record]] = [...b.memory]; b.memory.delete(perRequest); b.memory.set(`agentkit.assistant.native.pending.${scope}.cloud-session`, record);
  unknown = false;
  const refreshed = await b.open(); assert.equal(refreshed.getState().pending.request.requestId, input.requestId);
  assert.equal(await refreshed.confirm(), true); assert.equal(b.memory.size, 0);
  assert.equal(b.calls.filter(call => call.operation === 'attachment-upload').length, 1); await refreshed.dispose();
});

test('a newly discovered other-tab pending record is visible and confirmable instead of silently blocking', async () => {
  let unknown = true;
  const b = bench({ change(operation) { if (operation === 'native-call' && unknown) throw Error('ACK lost'); } });
  const first = await b.open(), second = await b.open(); await first.rpc.call(...prompt(input));
  assert.equal((await second.rpc.call(...prompt({ ...input, requestId: 'other-id' }))).ok, false);
  assert.equal(second.getState().pending.request.requestId, input.requestId);
  unknown = false; assert.equal(await second.confirm(), true);
  assert.equal(b.calls.filter(call => call.operation === 'attachment-upload').length, 1); await first.dispose(); await second.dispose();
});
