import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { fixture, tool, digest } from './fixtures.mjs';

test('immediately resolved ports cannot starve lease renewal across a long chain of durable transitions', { timeout: 15000 }, async () => {
  const store = new MemoryRunStore(), { config, snapshot } = fixture({ tools: [tool()], limits: { leaseMs: 500 } });
  store.create(config, snapshot); let renewals = 0, models = 0, reads = 0;
  const renew = store.renew.bind(store);
  store.renew = (...args) => { renewals++; return renew(...args); };
  const work = () => { const until = performance.now() + 10; while (performance.now() < until) {} };
  const kernel = new NativeKernel({ store, digest, owner: 'worker', ports: {
    model: { generate: async () => { work(); return ++models <= 40 ? {
      kind: 'tool_calls', text: '', toolCalls: [{ callId: `read-${models}`, name: 'read', arguments: {} }], usage: emptyUsage(),
    } : { kind: 'final_candidate', text: 'All observations collected.', toolCalls: [], usage: emptyUsage() }; } },
    tools: { execute: async () => { work(); reads++; return { status: 'ok', content: 'observed' }; } },
  } });
  const done = await kernel.runUntilIdle(snapshot.scope, snapshot.runId);
  assert.equal(done.phase, 'completed'); assert.equal(reads, 40); assert.equal(models, 41);
  assert.ok(renewals >= 2, `expected heartbeat service across task, got ${renewals}`);
});
