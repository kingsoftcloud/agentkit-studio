import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { fixture, tool, digest } from './fixtures.mjs';

test('the driver uses atomic current state rather than historical receipt hydration for ordinary execution', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture({ tools: [tool()] });
  store.create(config, snapshot);
  let models = 0, tools = 0, checkpoints = 0;
  store.load = () => { throw Error('unexpected full-history read in driver'); };
  const kernel = new NativeKernel({ store, digest, owner: 'owner',
    onCheckpoint: async () => { checkpoints++; }, ports: {
      model: { generate: async () => ++models === 1 ? {
        kind: 'tool_calls', text: '', toolCalls: [{ callId: 'read', name: 'read', arguments: {} }], usage: emptyUsage(),
      } : { kind: 'final_candidate', text: 'Observed the original file.', toolCalls: [], usage: emptyUsage() } },
      tools: { execute: async () => { tools++; return { status: 'ok', content: 'file content' }; } },
    } });
  const done = await kernel.runUntilIdle(snapshot.scope, snapshot.runId);
  assert.equal(done.phase, 'completed'); assert.equal(tools, 1); assert.equal(models, 2);
  assert.ok(checkpoints > 2);
});

test('a queued control remains authoritative at the driver boundary', async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture(); store.create(config, snapshot);
  store.enqueue(snapshot.scope, snapshot.runId, { commandId: 'cancel', kind: 'cancel', payload: {} });
  store.load = () => { throw Error('unexpected full-history read for cancellation'); };
  const kernel = new NativeKernel({ store, digest, owner: 'owner', ports: {
    model: { generate: async () => { throw Error('canceled work must never dispatch'); } },
  } });
  const done = await kernel.runUntilIdle(snapshot.scope, snapshot.runId);
  assert.equal(done.phase, 'canceled'); assert.equal(done.usage.modelCalls, 0);
});
