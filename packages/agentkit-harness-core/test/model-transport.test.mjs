import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, validateModelResult } from '../dist/index.mjs';
import { fixture, scope, digest, tool } from './fixtures.mjs';
const observation = { contract: 'model-transport-observation/v1', phase: 'stream', elapsedMs: 1234, headersMs: 12,
  bodyChunks: 4, bodyBytes: 800, lastByteMs: 1200, lastFrameMs: 1201, lastOutputMs: 1202, lastToolDeltaMs: 1202 };
const result = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage(), transportObservation: observation });

test('transport facts persist with model receipts and events but never enter subsequent model context', async () => {
  const { config, snapshot } = fixture({ tools: [tool()] }), store = new MemoryRunStore();let count = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'transport', ports: { model: { generate: async request => {
    count++;assert.doesNotMatch(JSON.stringify(request.messages), /model-transport-observation|bodyChunks|lastByteMs/);
    return count === 1 ? { ...result(), kind: 'tool_calls', text: '', toolCalls: [{ name: 'read', callId: 'read', arguments: {} }] } : result();
  } }, tools: { execute: async () => ({ status: 'ok', content: 'File evidence.' }) } } });kernel.start(snapshot, config);
  const done = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
  assert.equal(done.finalText, 'Done');assert.equal(count, 2);
  assert.equal(record.events.filter(event => event.kind === 'model.transport_observed').length, 2);
  assert.deepEqual(record.receipts.find(receipt => receipt.result.transportObservation)?.result.transportObservation, observation);
});

test('transport observations cannot smuggle response contents, endpoints or unbounded timings', () => {
  for (const invalid of [{ ...observation, url: 'https://private.invalid/?key=secret' },
    { ...observation, lastByteMs: 2000 }, { ...observation, bodyBytes: -1 }])
    assert.throws(() => validateModelResult({ ...result(), transportObservation: invalid }), /invalid_model_transport_observation/);
  assert.throws(() => validateModelResult({ ...result(), transportObservation: { ...observation, elapsedMs: Infinity } }), /non_json_number/);
});
