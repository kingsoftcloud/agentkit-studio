import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeNativeChildHistory, NATIVE_CHILD_HISTORY_CONTRACT } from '../packages/agentkit-harness/src/native/child-history.mjs';

const inventory = (owner, count) => ({ contract: NATIVE_CHILD_HISTORY_CONTRACT, sessionId: 'session', runId: owner,
  inventoryDigest: (owner === 'current' ? 'a' : 'b').repeat(64), tasks: Array.from({ length: count }, (_, index) => ({
    childRunId: `${owner}-child-${index}`, parentRunId: owner, canCancel: true, canSendInput: true, canPromote: true,
  })) });

test('merged paging spans more than a public page per owner without losing rows or widening historical controls', () => {
  const current = inventory('current', 70), other = inventory('historical', 70), sources = [current, other];
  const first = mergeNativeChildHistory({ sessionId: 'session', limit: 64 }, sources), rows = [...first.tasks];
  let page = first;
  while (!page.complete) {
    page = mergeNativeChildHistory({ sessionId: 'session', limit: 64, offset: page.nextOffset,
      inventoryDigest: first.inventoryDigest }, sources); rows.push(...page.tasks);
  }
  assert.equal(first.runId, 'current'); assert.equal(page.totalTasks, 140); assert.equal(rows.length, 140);
  assert.deepEqual(rows.map(task => task.childRunId), [...current.tasks, ...other.tasks].map(task => task.childRunId));
  assert.ok(rows.slice(0, 70).every(task => task.canCancel && task.canPromote && task.canSendInput));
  assert.ok(rows.slice(70).every(task => !task.canCancel && !task.canPromote && !task.canSendInput));
  assert.equal(other.tasks[0].canCancel, true, 'composition cannot mutate either owner inventory');
  for (const changed of [[other, current], [current, { ...other, runId: 'new-historical-head' }], [current, { ...other, inventoryDigest: 'c'.repeat(64) }]])
    assert.throws(() => mergeNativeChildHistory({ sessionId: 'session', offset: 64, inventoryDigest: first.inventoryDigest }, changed), /inventory_changed/);
  assert.throws(() => mergeNativeChildHistory({ sessionId: 'session', offset: 64 }, sources), /inventory_changed/);
});

test('a single owner keeps its existing cursor; ambiguous child IDs and foreign sessions fail closed', () => {
  const current = inventory('current', 2), empty = { ...inventory('historical', 0), runId: null };
  const page = mergeNativeChildHistory({ sessionId: 'session' }, [current, empty]);
  assert.equal(page.inventoryDigest, current.inventoryDigest); assert.deepEqual(page.tasks, current.tasks);
  assert.throws(() => mergeNativeChildHistory({ sessionId: 'session' }, [current, { ...inventory('historical', 1),
    tasks: [{ ...current.tasks[0] }] }]), /ancestry_invalid/);
  assert.throws(() => mergeNativeChildHistory({ sessionId: 'session' }, [current, { ...inventory('historical', 0), sessionId: 'foreign' }]), /ancestry_invalid/);
  assert.throws(() => mergeNativeChildHistory({ sessionId: 'session' }, [current, { ...inventory('historical', 1),
    tasks: [{ ...inventory('historical', 1).tasks[0], parentRunId: 'current' }] }]), /ancestry_invalid/);
});
