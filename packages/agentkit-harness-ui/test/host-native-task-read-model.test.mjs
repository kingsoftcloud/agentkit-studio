import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTaskReadModel } from '../src/host/state/native-task-read-model.mjs';

const gate = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));
const status = (runId = 'run') => ({ contract: 'agentkit.studio-native-recovery/v1', agentId: 'agent', sessionId: 'session',
  runId, presentationTurn: 1, state: 'closed', canResume: false, phase: 'failed', outcome: 'failed',
  error: { code: 'NATIVE_EXECUTION_NOT_COMPLETED', message: 'Canonical error' } });
const child = n => ({ childRunId: 'child-' + n, parentRunId: 'run', sessionId: 'child-session-' + n, role: 'reader', snapshotRevision: 1 });
const page = (tasks = [], extra = {}) => ({ contract: 'agentkit.studio-native-child-history/v1', sessionId: 'session', runId: 'run',
  inventoryDigest: 'a'.repeat(64), tasks, totalTasks: tasks.length, offset: 0, nextOffset: tasks.length, complete: true, ...extra });
const reader = hostRemote => createNativeTaskReadModel({ hostRemote, agentId: 'agent', sessionId: 'session' });

test('initial presentation publishes status and the entire paged child inventory atomically', async () => {
  const first = gate(), second = gate(), frames = [];let reads = 0;
  const view = reader({ nativeRecoveryStatus: async () => status(), nativeChildHistory: async request => {
    assert.equal(request.agentId, 'agent');assert.equal(request.sessionId, 'session');
    return ++reads === 1 ? first.promise : second.promise;
  } });
  view.subscribe(frame => frames.push(frame));
  const request = view.refresh();assert.equal(view.refresh(), request);await tick();
  assert.equal(view.getSnapshot().phase, 'loading');assert.equal(view.getSnapshot().observation, null);
  first.resolve(page([child(1)], { totalTasks: 2, complete: false }));await tick();
  assert.equal(view.getSnapshot().observation, null, 'first directory page is not a partial UI frame');
  second.resolve(page([child(2)], { totalTasks: 2, offset: 1, nextOffset: 2 }));await request;
  const ready = view.getSnapshot();assert.equal(ready.phase, 'ready');
  assert.equal(ready.observation.status.error.message, 'Canonical error');assert.equal(ready.observation.children.length, 2);
  assert.ok(frames.every(frame => frame.observation === null || frame.observation.children.length === 2));view.dispose();
});

test('a failed refresh retains the last complete frame and never exposes the new partial status', async () => {
  let fail = false;
  const view = reader({ nativeRecoveryStatus: async () => ({ ...status(), reason: fail ? 'new-partial-reason' : 'initial' }),
    nativeChildHistory: async () => { if (fail) throw Error('private transport failure');return page(); } });
  await view.refresh();const previous = view.getSnapshot().observation;fail = true;await view.refresh();
  assert.equal(view.getSnapshot().phase, 'ready');assert.equal(view.getSnapshot().observation, previous);
  assert.equal(view.getSnapshot().observation.status.reason, 'initial');assert.doesNotMatch(view.getSnapshot().error, /private/);view.dispose();
});

test('a turn change during a read retries the current owner without painting a mixed frame', async () => {
  let statuses = 0, directories = 0;
  const view = reader({ nativeRecoveryStatus: async () => status(++statuses === 1 ? 'old' : 'current'),
    nativeChildHistory: async () => page([], { runId: ++directories === 1 ? 'old' : 'current' }) });
  const frames = [];view.subscribe(frame => { if (frame.observation) frames.push(frame.observation); });
  await view.refresh();assert.equal(view.getSnapshot().observation.status.runId, 'current');
  assert.ok(frames.every(frame => frame.status.runId === 'current'));view.dispose();
});

test('a refresh after a control acknowledgment crosses an existing in-flight read instead of reusing it', async () => {
  const first = gate();let reads = 0;
  const view = reader({ nativeRecoveryStatus: async () => { if (++reads === 1) await first.promise;return status(); },
    nativeChildHistory: async () => page() });
  const old = view.refresh(), afterControl = view.refresh({ fresh: true });
  assert.notEqual(afterControl, old);first.resolve();await afterControl;
  assert.equal(reads, 4, 'two complete reads; the second begins after the prior read settles');view.dispose();
});

test('foreign status, duplicate children and changed page identities never become presentation state', async () => {
  for (const remote of [
    { nativeRecoveryStatus: async () => ({ ...status(), sessionId: 'foreign' }), nativeChildHistory: async () => page() },
    { nativeRecoveryStatus: async () => status(), nativeChildHistory: async () => page([child(1), child(1)]) },
    { nativeRecoveryStatus: async () => status(), nativeChildHistory: async () => page([], { sessionId: 'foreign' }) },
    { nativeRecoveryStatus: async () => status(), nativeChildHistory: async request => request.offset
      ? page([child(2)], { inventoryDigest: 'b'.repeat(64), offset: 1, totalTasks: 2, nextOffset: 2 })
      : page([child(1)], { complete: false, totalTasks: 2 }) },
  ]) {
    const view = reader(remote);await view.refresh();
    assert.equal(view.getSnapshot().phase, 'error');assert.equal(view.getSnapshot().observation, null);view.dispose();
  }
});

test('late responses after disposal cannot restore an old session or trigger execution', async () => {
  const deferred = gate();let executionCalls = 0;
  const view = reader({ nativeRecoveryStatus: () => deferred.promise, nativeChildHistory: async () => page(),
    resumeNativeRun: () => { executionCalls++; } });
  const pending = view.refresh();view.dispose();deferred.resolve(status());await pending;
  assert.equal(view.getSnapshot().observation, null);assert.equal(executionCalls, 0);
});
