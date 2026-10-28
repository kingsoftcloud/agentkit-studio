import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, emptyUsage, copy } from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createStudioObservability } from '../src/studio-observability.mjs';
import { createNativeTraceProjection } from '../src/providers/native-trace-projection.mjs';

async function setup(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'native-trace-')), filename = join(root, 'runs.sqlite');
  let store = new SqliteRunStore(filename), models = 0;
  const obs = createStudioObservability({ storeDir: join(root, 'traces') }), errors = [], stateDir = join(root, 'projection');
  const options = { stateDir, observability: obs, onError: error => errors.push(error) }, projector = createNativeTraceProjection(options);
  const data = fixture(), kernel = new NativeKernel({ store, digest, owner: 'trace-test',
    onCheckpoint: snapshot => projector.checkpoint(snapshot),
    ports: { model: { generate: async () => { models++; return { kind: 'final_candidate', text: 'Done', toolCalls: [],
      usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 3 } }; } } } });
  kernel.start(data.snapshot, data.config);
  const attach = (port = store, source = scope, custom = projector) => custom.attach({ store: port, scope: source, sessionId: 'session', runId: 'run' });
  t.after(async () => { await projector.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, obs, options, projector, kernel, attach, errors, get store() { return store; }, get models() { return models; },
    reopen() { store.close(); store = new SqliteRunStore(filename); } };
}

test('Native trace cold projection retains source events, original times and measured usage without driving the Kernel', async t => {
  const h = await setup(t), handle = h.attach();
  const done = await h.kernel.runUntilIdle(scope, 'run'); await handle.close();
  const first = await h.obs.get(handle.traceId);
  assert.equal(first.status, 'completed'); assert.equal(first.runId, 'run'); assert.equal(first.tokenUsage.totalTokens, 5);
  assert.equal(first.events.length, h.store.events(scope, 'run').length); assert.equal(h.errors.length, 0);
  assert.equal(first.provenance.nativeProjection.revision, done.revision);
  h.reopen(); const second = createNativeTraceProjection(h.options), cold = h.attach(h.store, scope, second);
  await cold.close(); await second.close(); assert.equal(h.models, 1);
  assert.deepEqual(await h.obs.get(handle.traceId), first);
});

test('a stale independent Native trace projector cannot overwrite a newer committed revision', async t => {
  const h = await setup(t), old = copy(h.store.load(scope, 'run'));
  await h.kernel.runUntilIdle(scope, 'run'); const live = h.attach(); await live.close();
  const before = await h.obs.get(live.traceId), staleProjector = createNativeTraceProjection(h.options);
  const stale = h.attach({ load: () => copy(old) }, scope, staleProjector); await stale.close();
  assert.deepEqual(await h.obs.get(live.traceId), before); assert.equal(h.models, 1); assert.equal(h.errors.length, 0);
});

test('Native trace scope checks reject foreign records and preserve exact numeric diagnostic values', async t => {
  const h = await setup(t); await h.kernel.runUntilIdle(scope, 'run');
  const record = h.store.load(scope, 'run'), port = { load: () => {
    const value = copy(record); value.events[0].payload.large = 9007199254740993n; return value;
  } };
  const original = h.attach(port); await original.close();
  const trace = await h.obs.get(original.traceId);
  assert.equal(trace.events[0].payload.large, '9007199254740993');
  assert.equal(trace.provenance.nativeProjection.numericEncoding, 'exact-decimal-strings');
  const foreign = h.attach({ load: () => copy(record) }, { ...scope, userId: 'foreign' }); await foreign.close();
  assert.equal(await h.obs.get(foreign.traceId), null); assert.equal(h.errors.at(-1).code, 'native_trace_scope_mismatch');
});
