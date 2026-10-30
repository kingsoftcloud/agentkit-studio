import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduceAll } from '../src/reducer.mjs';
import { taskStatusLabel } from '../src/project.mjs';
const finish = verificationRequired => reduceAll(initialState(), [
  { v: 1, type: 'task.started', id: 's', taskId: 'conversation' },
  { v: 1, type: 'task.finished', id: 'f', outcome: 'unverified', verificationRequired },
]);
test('ordinary completion stays neutral without changing the unverified outcome into verified success', () => {
  const state = finish(false);
  assert.equal(state.taskState, 'unverified'); assert.equal(state.taskOutcome, 'unverified');
  assert.equal(taskStatusLabel(state), 'Finished');
  assert.equal(taskStatusLabel(finish(undefined)), 'Finished');
  assert.equal(taskStatusLabel(finish('true')), 'Finished');
  assert.equal(taskStatusLabel(finish(true)), 'Unverified');
});
