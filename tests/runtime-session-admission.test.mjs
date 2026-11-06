import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionAdmission, runtimeOwner, SESSION_ADMISSION_DEFAULTS } from '../src/runtime-session-admission.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (sessionId, turnId, extra = {}) => ({ sessionId, turnId, requestId: `req-${turnId}`, ...extra });

async function admission(t, options = {}) {
  const instance = createSessionAdmission({ waitTimeoutMs: 500, turnTimeoutMs: 60_000, fenceGraceMs: 100, heartbeatMs: 20, ...options });
  t.after(() => instance.close());
  return instance;
}

test('one Session admits one turn; a second request waits and runs in arrival order', async t => {
  const gate = await admission(t);
  const first = await gate.acquire(request('s1', 'turn-a'));
  assert.equal(first.queued, false);

  let secondSettled = false;
  const second = gate.acquire(request('s1', 'turn-b')).then(handle => { secondSettled = true; return handle; });
  await sleep(20);
  assert.equal(secondSettled, false, 'the second turn must wait for the active one');
  assert.equal(gate.describe('s1').queue.length, 1);
  assert.equal(gate.describe('s1').holder.runId, 'turn-a');

  assert.equal(first.release(), true);
  const acquired = await second;
  assert.equal(acquired.turnId, 'turn-b');
  assert.equal(acquired.queued, true);
  assert.equal(gate.describe('s1').holder.runId, 'turn-b');
  assert.equal(acquired.release(), true);
  assert.equal(gate.describe('s1').holder, null);
  assert.deepEqual(gate.metrics().admitted, 2);
});

test('a full wait queue refuses with the holder and a retry delay', async t => {
  const gate = await admission(t, { queueLimit: 1, retryAfterMs: 3000 });
  const holder = await gate.acquire(request('s1', 'turn-a'));
  const waiting = gate.acquire(request('s1', 'turn-b'));
  await assert.rejects(gate.acquire(request('s1', 'turn-c')), error => {
    assert.equal(error.code, 'RUNTIME_SESSION_BUSY');
    assert.equal(error.status, 409);
    assert.equal(error.retryAfterMs, 3000);
    assert.equal(error.detail.holder.runId, 'turn-a');
    assert.equal(error.detail.holder.requestId, 'req-turn-a');
    assert.equal(error.detail.queue.length, 1);
    assert.equal(error.detail.queue.limit, 1);
    assert.match(error.message, /turn-a/);
    return true;
  });
  assert.equal(gate.metrics().refused, 1);
  holder.release();
  (await waiting).release();
});

test('a queued turn whose wait expires is refused and leaves the queue', async t => {
  const gate = await admission(t, { waitTimeoutMs: 30 });
  const holder = await gate.acquire(request('s1', 'turn-a'));
  await assert.rejects(gate.acquire(request('s1', 'turn-b')), { code: 'RUNTIME_SESSION_WAIT_TIMEOUT', status: 409 });
  assert.equal(gate.describe('s1').queue.length, 0);
  assert.equal(gate.metrics().waitedOut, 1);
  holder.release();
});

test('a retried request joins the turn already owning the Session instead of a second admission', async t => {
  const gate = await admission(t);
  const holder = await gate.acquire(request('s1', 'turn-a'));
  let duplicateSettled = false;
  const duplicate = gate.acquire({ sessionId: 's1', turnId: 'turn-a', requestId: 'retry-of-a' })
    .then(handle => { duplicateSettled = true; return handle; });
  await sleep(25);
  assert.equal(duplicateSettled, false);
  assert.equal(gate.metrics().admitted, 1, 'a retry must not open a second turn while the first runs');

  holder.release();
  const joined = await duplicate;
  assert.equal(joined.turnId, 'turn-a');
  assert.equal(gate.metrics().admitted, 2, 'after settling, the retry replays under the same turn id');
  joined.release();
});

test('an expired turn is aborted, then fenced so the queued turn can take over', async t => {
  const gate = await admission(t, { turnTimeoutMs: 25, fenceGraceMs: 25 });
  let timedOut = 0, fenced = 0;
  const stuck = await gate.acquire(request('s1', 'turn-stuck', {
    onTurnTimeout: () => { timedOut++; }, onFence: () => { fenced++; } }));
  const next = gate.acquire(request('s1', 'turn-next'));
  await sleep(40);
  assert.equal(timedOut, 1, 'the deadline must abort the stuck turn');
  assert.equal(gate.describe('s1').holder.expiring, true);
  await sleep(40);
  assert.equal(fenced, 1, 'the lease is revoked after the fence grace');
  const acquired = await next;
  assert.equal(acquired.turnId, 'turn-next');
  assert.equal(stuck.release(), false, 'a fenced turn must not release the new holder');
  assert.equal(gate.describe('s1').holder.runId, 'turn-next');
  assert.equal(gate.metrics().reclaimed, 1);
  acquired.release();
});

test('a client abort removes a queued turn without disturbing the holder', async t => {
  const gate = await admission(t);
  const holder = await gate.acquire(request('s1', 'turn-a'));
  const controller = new AbortController();
  const waiting = gate.acquire(request('s1', 'turn-b', { signal: controller.signal }));
  await sleep(10);
  controller.abort(new Error('client left'));
  await assert.rejects(waiting, /client left/);
  assert.equal(gate.describe('s1').queue.length, 0);
  assert.equal(gate.describe('s1').holder.runId, 'turn-a');
  holder.release();
});

test('session cancellation refuses queued turns and runtime close settles every lease', async t => {
  const gate = await admission(t);
  const holder = await gate.acquire(request('s1', 'turn-a'));
  const waiting = gate.acquire(request('s1', 'turn-b'));
  await sleep(10);
  gate.cancelSession('s1');
  await assert.rejects(waiting, { code: 'RUNTIME_CANCELLED' });
  assert.equal(holder.release(), true);

  const other = await gate.acquire(request('s2', 'turn-c'));
  const queued = gate.acquire(request('s2', 'turn-d'));
  await sleep(10);
  gate.close();
  await assert.rejects(queued, { code: 'RUNTIME_STOPPING' });
  assert.equal(other.release(), false, 'close() already settled the lease');
  await assert.rejects(gate.acquire(request('s3', 'turn-e')), { code: 'RUNTIME_STOPPING' });
});

test('owner identity and defaults are explicit', async t => {
  const owner = runtimeOwner({ instanceId: 'runtime-1', pid: 42, host: 'host-a', startedAt: 1 });
  assert.deepEqual(owner, { instanceId: 'runtime-1', pid: 42, host: 'host-a', startedAt: 1 });
  const gate = await admission(t);
  assert.equal(gate.owner.instanceId.length >= 8, true);
  const handle = await gate.acquire(request('s1', 'turn-a'));
  assert.deepEqual(handle.owner, gate.owner);
  assert.equal(handle.describe().runId, 'turn-a');
  handle.release();
  assert.equal(SESSION_ADMISSION_DEFAULTS.queueLimit, 8);
  assert.equal(SESSION_ADMISSION_DEFAULTS.turnTimeoutMs, 10 * 60_000);
});
