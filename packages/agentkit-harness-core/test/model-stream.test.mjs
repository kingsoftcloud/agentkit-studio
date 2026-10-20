import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRunStore, NativeKernel, emptyUsage } from '../dist/index.mjs';
import { fixture, scope, digest } from './fixtures.mjs';
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(generate, options = {}, overrides = {}) {
  const store = new MemoryRunStore(), { config, snapshot } = fixture(overrides);
  store.create(config, snapshot);
  const kernel = new NativeKernel({ store, digest, owner: 'stream-worker', ports: {
    model: { generate }, tools: { execute: async () => assert.fail('stream cannot dispatch tools') },
  }, ...options });
  return { store, kernel, run: () => kernel.runUntilIdle(scope, 'run') };
}
test('live public prefix precedes model settlement and is copied into its durable receipt', async () => {
  const seen = [], entered = gate(), finish = gate();
  const host = setup(async (request, emit) => {
    const value = { kind: 'text', text: 'Native', metadata: { secret: 'private replay' } };
    emit(value); value.text = 'mutated'; entered.resolve(); await finish.promise;
    emit({ kind: 'text', text: ' result' });
    return { ...final('Native result'), displayStream: { records: ['port-forged'] } };
  }, { onStream: (context, event, record) => {
    seen.push({ operationKey: context.operationKey, event: structuredClone(event), record: structuredClone(record) });
    event.text = 'observer mutation'; record.event.text = 'observer mutation';
  } });
  const running = host.run(); await entered.promise;
  assert.equal(seen[0].event.text, 'Native');
  assert.equal(host.store.load(scope, 'run').receipts.length, 0);
  finish.resolve(); const result = await running;
  assert.equal(result.finalText, 'Native result');
  const record = host.store.load(scope, 'run'), fact = record.events.find(event => event.kind === 'model.completed');
  assert.equal(fact.payload.operationKey, seen[0].operationKey);
  assert.deepEqual(fact.payload.displayStream.records, seen.map(item => item.record));
  assert.deepEqual(record.receipts[0].result.displayStream, fact.payload.displayStream);
  assert.equal(JSON.stringify(fact).includes('private replay'), false);
  const before = seen.length; await host.run(); assert.equal(seen.length, before);
});
test('stream cap limits the UTF-8 display prefix without truncating the authoritative result', async () => {
  const seen = [];
  const host = setup(async (request, emit) => {
    emit({ kind: 'text', text: '中' }); emit({ kind: 'text', text: '界'.repeat(200) }); emit({ kind: 'text', text: 'tail' });
    return final('中' + '界'.repeat(200) + 'tail');
  }, { onStream: (_, event) => seen.push(event) }, { limits: { maxModelStreamBytes: 150 } });
  const result = await host.run(), display = host.store.load(scope, 'run').receipts[0].result.displayStream;
  assert.equal(seen.length, 1); assert.equal(display.records[0].event.text, '中'); assert.equal(display.truncated, true);
  assert.equal(result.finalText.length, 205);
});
test('display recording can be disabled while the final result remains complete', async () => {
  const seen = [];
  const host = setup(async (_, emit) => { emit({ kind: 'text', text: 'Complete' }); return final('Complete'); },
    { onStream: (_, event) => seen.push(event) }, { limits: { maxModelStreamBytes: 0 } });
  assert.equal((await host.run()).finalText, 'Complete'); assert.deepEqual(seen, []);
  assert.equal(host.store.load(scope, 'run').receipts[0].result.displayStream.truncated, true);
  assert.throws(() => fixture({ limits: { maxModelStreamBytes: null } }), { code: 'invalid_limit:maxModelStreamBytes' });
});
test('only whitelisted tool display metadata survives and observers cannot veto a model result', async () => {
  const host = setup(async (_, emit) => {
    emit({ kind: 'invalid', text: 'discard' }); emit({ kind: 'tool_delta', text: '{}', metadata: { index: true } });
    emit({ kind: 'tool_delta', text: '{', metadata: { index: 3, callId: 'provider-id', name: 'read', signature: 'private' } });
    emit({ kind: 'thinking', text: 'Visible reasoning', metadata: { encrypted_content: 'private' } });
    return final('Done');
  }, { onStream: () => { throw Error('broken display observer'); } });
  assert.equal((await host.run()).phase, 'completed');
  const display = host.store.load(scope, 'run').receipts[0].result.displayStream;
  assert.equal(display.discarded, 2);
  assert.deepEqual(display.records[0].event.metadata, { index: 3, callId: 'provider-id', name: 'read' });
  assert.equal(JSON.stringify(display).includes('private'), false);
});
for (const mode of ['timeout', 'cancel', 'throw']) test(`${mode}: incomplete display prefix is durable and late callbacks are fenced`, async () => {
  let lateEmit, entered = gate(); const seen = [];
  const host = setup(async (_, emit) => {
    lateEmit = emit; emit({ kind: 'text', text: 'Unsealed prefix' }); entered.resolve();
    if (mode === 'throw') throw Error('connection lost');
    await new Promise(() => {});
  }, { onStream: (_, event) => seen.push(event) }, {
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
      requestTimeoutMs: 35, maxProviderRetries: 0, retryInitialDelayMs: 0 },
  });
  const running = host.run(); await entered.promise;
  if (mode === 'cancel') host.kernel.submit(scope, 'run', { kind: 'cancel', commandId: 'cancel-stream', payload: {} });
  await running;
  const record = host.store.load(scope, 'run'), event = record.events.find(event => event.kind === 'model.stream_interrupted');
  assert.equal(event.payload.displayStream.records[0].event.text, 'Unsealed prefix');
  assert.deepEqual(record.receipts[0].result.displayStream, event.payload.displayStream);
  lateEmit({ kind: 'text', text: 'late leaked output' }); assert.equal(seen.length, 1);
  assert.equal(record.snapshot.messages.some(message => message.content.includes('Unsealed prefix')), false);
});
test('a schema-rejected plain draft never escapes through display callbacks or stored display records', async () => {
  const seen = [];
  const host = setup(async (_, emit) => { emit({ kind: 'text', text: 'Rejected private draft' }); return final('Rejected private draft'); },
    { onStream: (_, event) => seen.push(event) }, { contract: { objective: 'Submit JSON', finalSubmissionSchema: { type: 'object' }, finalOutputFormat: 'json_object' },
      limits: { maxModelCalls: 1, finalizationReserveModelCalls: 0 } });
  await host.run(); assert.deepEqual(seen, []);
  const record = host.store.load(scope, 'run');
  assert.equal(record.receipts[0].result.displayStream, undefined);
  assert.equal(record.events.find(event => event.kind === 'model.completed').payload.text, '');
});
