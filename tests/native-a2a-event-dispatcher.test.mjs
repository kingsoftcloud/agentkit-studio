import test from 'node:test';
import assert from 'node:assert/strict';
import { createA2AEventDispatcher } from '../src/providers/native-a2a-event-dispatcher.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const limit = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < limit, 'expected dispatcher state'); await delay(5); } }
function setup(t, append, options = {}) {
  const queue = [1, 2].map(sequence => ({ sequence, taskId: 'task', batchId: 'b' + sequence, events: [{ event_id: 'event' + sequence }], attempts: 0 }));
  const deadLetters = [], updates = []; let locked = false, failure;
  const dispatcher = createA2AEventDispatcher({ pending: () => structuredClone(queue[0] ?? null), assertCurrent: () => true,
    deliveryLock: () => { if (locked) return null; locked = true; return () => { locked = false; }; },
    permanentError: () => failure, append, retryMs: 20, timeoutMs: 40,
    update(batch, action, error) { updates.push({ action, batch: batch.batchId, error }); const entry = queue[0];
      assert.equal(entry.batchId, batch.batchId);
      if (action === 'acknowledge') queue.shift(); else { entry.attempts++; entry.lastError = error;
        if (action === 'deadLetter') { deadLetters.push(queue.shift()); failure = error; } }
    }, ...options });
  t.after(() => dispatcher.stop({ flushTimeoutMs: 0 }));
  return { dispatcher, queue, deadLetters, updates, isLocked: () => locked };
}
test('enqueue wake does not wait for a hanging sink; timed out bytes are retried unchanged', async t => {
  const attempts = []; let available = false;
  const h = setup(t, batch => { attempts.push(structuredClone(batch.events)); return available ? {} : new Promise(() => {}); });
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  assert.equal(h.dispatcher.wake(), undefined); assert.equal(h.queue.length, 2);
  await until(() => h.updates.length > 0); assert.equal(h.queue[0].attempts, 1);
  assert.equal(h.queue[0].lastError, 'A2A_EVENT_DELIVERY_UNAVAILABLE'); available = true;
  await h.dispatcher.flush(); assert.equal(h.queue.length, 0); assert.deepEqual(attempts[0], attempts[1]);
});
test('permanent head is retained as a dead letter and following batches drain; explicit flush reports durable failure', async t => {
  const h = setup(t, batch => { if (batch.batchId === 'b1') throw Object.assign(Error('private-token'), { code: 'A2A_EVENT_REF_INVALID' }); return {}; });
  await assert.rejects(h.dispatcher.flush(), { code: 'A2A_EVENT_REF_INVALID' });
  assert.equal(h.queue.length, 0); assert.equal(h.deadLetters.length, 1); assert.equal(h.deadLetters[0].batchId, 'b1');
  assert.equal(h.deadLetters[0].lastError, 'A2A_EVENT_REF_INVALID'); assert.doesNotMatch(JSON.stringify(h.updates), /private-token/);
  await assert.rejects(h.dispatcher.flush(), { code: 'A2A_EVENT_REF_INVALID' });
});
test('a response after timeout or stop cannot acknowledge an unconfirmed batch', async t => {
  let resolve;
  const h = setup(t, () => new Promise(done => { resolve = done; }));
  h.dispatcher.wake(); await until(() => resolve); await h.dispatcher.stop({ flushTimeoutMs: 0 });
  resolve({}); await delay(10); assert.equal(h.queue.length, 2); assert.equal(h.updates.length, 0); assert.equal(h.isLocked(), false);
});
test('concurrent wake and explicit drains serialize one attempt and preserve FIFO', async t => {
  const active = [], order = []; let maximum = 0;
  const h = setup(t, async batch => { active.push(batch.batchId); maximum = Math.max(maximum, active.length);
    order.push(batch.batchId); await delay(10); active.pop(); return {}; });
  h.dispatcher.wake(); h.dispatcher.wake(); await Promise.all([h.dispatcher.flush(), h.dispatcher.flush()]);
  assert.equal(maximum, 1); assert.deepEqual(order, ['b1', 'b2']);
});
test('delivery authority loss cannot send or acknowledge a batch', async t => {
  let allowed = false, calls = 0;
  const h = setup(t, () => { calls++; allowed = false; return {}; }, { assertCurrent: () => allowed });
  await assert.rejects(h.dispatcher.flush(), { code: 'A2A_EVENT_DELIVERY_AUTHORITY_LOST' }); assert.equal(calls, 0);
  allowed = true; await assert.rejects(h.dispatcher.flush(), { code: 'A2A_EVENT_DELIVERY_AUTHORITY_LOST' });
  assert.equal(calls, 1); assert.equal(h.queue.length, 2); assert.equal(h.updates.length, 0);
});
test('asynchronous authority is rejected without an unhandled rejection or append', async t => {
  const h = setup(t, () => assert.fail('asynchronous authority admitted delivery'),
    { assertCurrent: () => Promise.reject(Error('private-authority')) });
  await assert.rejects(h.dispatcher.flush(), { code: 'A2A_EVENT_DELIVERY_AUTHORITY_LOST' });
  await delay(5); assert.equal(h.queue.length, 2);
});
