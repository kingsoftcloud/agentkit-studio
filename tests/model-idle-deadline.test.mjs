import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelIdleDeadline } from '../packages/agentkit-harness/src/model-idle-deadline.mjs';

test('ongoing model data can outlive the original request budget', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = createModelIdleDeadline({ timeoutMs: 180000 });
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(60000);
    assert.equal(deadline.signal.aborted, false);
    deadline.touch();
  }
  deadline.dispose();
  t.mock.timers.tick(180001);
  assert.equal(deadline.signal.aborted, false);
});
test('model silence is bounded from the last received data', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = createModelIdleDeadline({ timeoutMs: 180000 });
  t.mock.timers.tick(120000); deadline.touch();
  t.mock.timers.tick(179999); assert.equal(deadline.signal.aborted, false);
  t.mock.timers.tick(1); assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.timedOut, true);
  deadline.dispose();
});
test('user cancellation remains distinct from a model timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const user = new AbortController();
  const deadline = createModelIdleDeadline({ signal: user.signal });
  user.abort();
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.timedOut, false);
  deadline.dispose();
});
