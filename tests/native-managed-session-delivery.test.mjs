import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudioManagedSessionDelivery, MANAGED_SESSION_DELIVERY } from '../src/host/services/native-managed-session-delivery.mjs';

test('Session delivery resumes a partial turn and acknowledges an identical terminal payload once', async () => {
  const events = [];
  const session = { id: 'session', snapshotEvents: () => structuredClone(events),
    append: (type, data, options) => events.push({ type, data: structuredClone(data), ...options }) };
  const externalTurns = {
    contract: 'dsh.external-turn-host/v1', idleAdmissionContract: 'dsh.external-turn-start/v1', claim() {},
    pending() { return events.some(event => event.type === 'turn/end') ? null : events.find(event => event.type === 'turn/owner')?.data; },
    async start(prepare, execute) {
      session.append('turn/start', { turn: 1 });
      session.append('turn/owner', await prepare({ turn: 1 }));
      return this.resume(MANAGED_SESSION_DELIVERY, execute);
    },
    async resume(engine, execute) {
      assert.equal(this.pending().engine, engine);
      const result = await execute({ turn: 1, signal: new AbortController().signal });
      session.append('turn/end', { turn: 1, reason: result.reason });
      return result;
    },
  };
  const agent = { session, externalTurns, whenIdle: async () => {} };
  const receiptEvent = 'agentkit/managed-session-delivery';
  let failFlush = true;
  let stop;
  const ctx = { get: () => ({ flush: async () => {
    if (failFlush && events.some(event => event.type === receiptEvent)) { failFlush = false; return false; }
    return true;
  } }), effect: fn => { stop = fn(); } };
  const claim = { deliveryContract: MANAGED_SESSION_DELIVERY, sessionId: session.id, runId: 'run',
    configDigest: 'a'.repeat(64), input: 'Original user message.', source: { provider: 'agentkit-harness', model: 'fixture' } };
  const final = { ...claim, phase: 'completed', finalText: 'One answer.', view: 'b'.repeat(64), events: [{ seq: 2, kind: 'run.terminal' }] };
  const signal = new AbortController().signal;

  let delivery = createStudioManagedSessionDelivery({ ctx });
  assert.deepEqual(await delivery.claim(agent, claim, signal), { received: true });
  await assert.rejects(delivery.finish(agent, final, signal), { code: 'MANAGED_SESSION_DELIVERY_NOT_DURABLE' });
  assert(externalTurns.pending());
  await stop();

  delivery = createStudioManagedSessionDelivery({ ctx });
  assert.deepEqual(await delivery.finish(agent, final, signal), { received: true });
  assert.deepEqual(await delivery.finish(agent, final, signal), { received: true });
  await assert.rejects(delivery.finish(agent, { ...final, finalText: 'Replacement.' }, signal),
    { code: 'MANAGED_SESSION_DELIVERY_CHANGED' });
  for (const type of ['turn/start', 'turn/end', 'user/message', 'assistant/message', receiptEvent, 'agentkit/native-engine-event'])
    assert.equal(events.filter(event => event.type === type).length, 1);
  assert.deepEqual(events.find(event => event.type === 'assistant/message').data.stream, []);
  await stop();
});
