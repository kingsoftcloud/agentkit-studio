import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeChildHistory } from '../packages/agentkit-harness-node/src/native/child-history.mjs';
import { fixture, scope } from './fixtures/native-core.mjs';

function history() {
  const { config, snapshot } = fixture();
  const previous = { ...snapshot, phase: 'completed' };
  const head = { ...snapshot, runId: 'later', parentRunId: previous.runId };
  const records = new Map([previous, head].map(snapshot => [snapshot.runId,
    { configuration: structuredClone(config), snapshot, lease: null, fence: 0, pendingIntent: null }]));
  const read = [];
  const store = { sessionHead: () => head,
    authority(given, runId) { assert.deepEqual(given, scope); read.push(runId); return structuredClone(records.get(runId)); },
    load() { throw Error('detail journal required'); } };
  return { service: createNativeChildHistory({ scope, store }), records, read, store };
}

test('empty child discovery authenticates the full lineage without loading any transcript or receipt', () => {
  const h = history(); const page = h.service.list({ sessionId: 'session' });
  assert.equal(page.runId, 'later'); assert.deepEqual(page.tasks, []);
  assert.equal(page.totalTasks, 0); assert.deepEqual(h.read, ['later', 'run']);
});

test('declared children and uncommitted live starts still require the original detail journal', () => {
  const h = history(); h.records.get('later').snapshot.childRunIds = ['child'];
  assert.throws(() => h.service.list({ sessionId: 'session' }), /detail journal required/);
  const live = history(); const service = createNativeChildHistory({ scope, store: live.store, liveTasks: () => [{ childRunId: 'uncommitted' }] });
  assert.throws(() => service.list({ sessionId: 'session' }), /detail journal required/);
});

test('compact discovery cannot hide a foreign session, a lineage cycle, or frozen configuration drift', () => {
  for (const kind of ['session', 'cycle', 'config']) {
    const h = history(), old = h.records.get('run');
    if (kind === 'session') old.snapshot.sessionId = 'foreign';
    if (kind === 'cycle') old.snapshot.parentRunId = 'later';
    if (kind === 'config') old.configuration.instructions += 'changed';
    assert.throws(() => h.service.list({ sessionId: 'session' }),
      { code: kind === 'config' ? 'stored_configuration_mismatch' : 'child_history_ancestry_invalid' });
  }
});
