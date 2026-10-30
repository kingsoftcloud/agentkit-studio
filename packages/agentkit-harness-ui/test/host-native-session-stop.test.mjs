import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSessionStop } from '../src/host/state/native-session-stop.mjs';

const waiting = { sessionId: 'session', runId: 'original-run', state: 'recovering', phase: 'awaiting_interaction' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject }; };

test('waiting for tool interaction can stop the original Session without answering that interaction', async () => {
  const reply = deferred(), calls = [];
  const control = createNativeSessionStop({ sessionId: 'session', requestStop: id => { calls.push(id); return reply.promise; } });
  control.observe(waiting, true);
  assert.equal(control.getSnapshot().canStop, true);
  const request = control.request();
  assert.equal(control.getSnapshot().phase, 'requesting');
  assert.equal(await control.request(), false);assert.deepEqual(calls, ['session']);
  reply.resolve({ ok: true, value: { accepted: true } });assert.equal(await request, true);
  assert.equal(control.getSnapshot().phase, 'requested');assert.equal(control.getSnapshot().canStop, false);
  // Permission/interaction may change while cancellation settles. The button
  // still represents a request until the actual owner reports quiescence.
  control.observe({ ...waiting, phase: 'executing_tools' }, true);
  assert.equal(control.getSnapshot().visible, true);assert.equal(control.getSnapshot().phase, 'requested');
  control.observe({ ...waiting, phase: 'canceled', state: 'closed' }, false);
  assert.equal(control.getSnapshot().visible, false);
});

test('foreign, inactive and managed owners cannot be stopped by the local Session port', async () => {
  const control = createNativeSessionStop({ sessionId: 'session', requestStop: () => assert.fail('No control authority') });
  for (const [status, running] of [[{ ...waiting, sessionId: 'foreign' }, true],
    [{ ...waiting, state: 'available' }, true], [{ ...waiting, managed: {} }, true],
    [waiting, false], [{ ...waiting, phase: 'requesting_model' }, true]]) {
    control.observe(status, running);
    assert.equal(control.getSnapshot().visible, false);assert.equal(await control.request(), false);
  }
  const absent = createNativeSessionStop({ sessionId: 'session' });absent.observe(waiting, true);
  assert.equal(absent.getSnapshot().canStop, false);assert.equal(await absent.request(), false);
});

test('failed or malformed acknowledgements remain retryable without claiming stopped', async () => {
  for (const result of [undefined, { accepted: true }, { ok: false, error: { message: 'PRIVATE_PROVIDER_DETAIL' } },
    { ok: true, value: { accepted: false } }]) {
    let calls = 0;
    const control = createNativeSessionStop({ sessionId: 'session', requestStop: async () =>
      ++calls === 1 ? result : { ok: true, value: { accepted: true } } });
    control.observe(waiting, true);assert.equal(await control.request(), false);
    assert.equal(control.getSnapshot().phase, 'error');assert.equal(control.getSnapshot().canStop, true);
    assert.doesNotMatch(JSON.stringify(control.getSnapshot()), /PRIVATE_PROVIDER_DETAIL/);
    assert.equal(await control.request(), true);assert.equal(calls, 2);
  }
});

test('late replies never overwrite a replacement Run or a disposed view', async () => {
  const reply = deferred();
  const control = createNativeSessionStop({ sessionId: 'session', requestStop: () => reply.promise });
  control.observe(waiting, true);const request = control.request();
  control.observe({ ...waiting, runId: 'next-run' }, true);
  reply.resolve({ ok: true, value: { accepted: true } });assert.equal(await request, false);
  assert.equal(control.getSnapshot().phase, 'idle');assert.equal(control.getSnapshot().canStop, true);
  const late = deferred(), disposed = createNativeSessionStop({ sessionId: 'session', requestStop: () => late.promise });
  let updates = 0;disposed.subscribe(() => updates++);disposed.observe(waiting, true);
  const ending = disposed.request();disposed.dispose();const previous = updates;
  late.reject(Error('connection closed'));assert.equal(await ending, false);assert.equal(updates, previous);
});
