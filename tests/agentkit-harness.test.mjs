import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentKitHarness, HarnessError } from '../src/providers/agentkit-harness.mjs';

async function collect(iterator) { const events = []; for await (const event of iterator) events.push(event); return events; }

function modelFrom(chunks, { waitForAbort = false } = {}) {
  let calls = 0;
  return { get calls() { return calls; }, async *stream({ signal }) {
    calls += 1;
    for (const chunk of chunks) {
      if (waitForAbort) await new Promise(resolve => setTimeout(resolve, 2));
      if (signal.aborted) throw new HarnessError('canceled', 'cancelled');
      yield chunk;
    }
  } };
}

test('independent harness creates, lists and closes sessions with paged local state', async () => {
  const harness = new AgentKitHarness({ model: modelFrom(['ok']) });
  const first = await harness.createSession({ sessionId: 'ses_a', agentId: 'agent_a' });
  await harness.createSession({ sessionId: 'ses_b' });
  assert.equal(first.agentId, 'agent_a');
  const page = await harness.listSessions({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, '1');
  assert.equal((await harness.listSessions({ cursor: page.nextCursor })).items[0].sessionId, 'ses_b');
  await harness.closeSession('ses_a');
  await assert.rejects(() => collect(harness.prompt({ sessionId: 'ses_a', input: 'no' })), { code: 'session_closed' });
});

test('text streaming emits the 12-field canonical envelope and monotonic session sequence', async () => {
  const harness = new AgentKitHarness({ model: modelFrom(['Hel', { delta: 'lo' }]), executionLocus: 'endpoint-local' });
  await harness.createSession({ sessionId: 'ses_stream' });
  const events = await collect(harness.prompt({ sessionId: 'ses_stream', input: 'hi', idempotencyKey: 'idem_1' }));
  assert.ok(events.length >= 5);
  assert.deepEqual(Object.keys(events[0]).sort(), ['errorInfo', 'eventId', 'executionLocus', 'idempotencyKey', 'interactionId', 'kind', 'runId', 'sequence', 'sessionId', 'snapshotReplay', 'timestamp', 'watermark'].sort());
  assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
  assert.equal(events.find(event => event.kind.type === 'assistant.completed').kind.data.text, 'Hello');
  assert.equal(events.at(-1).kind.type, 'run.completed');
});

test('idempotency replays stored event IDs without invoking the model again', async () => {
  const model = modelFrom(['one']);
  const harness = new AgentKitHarness({ model });
  await harness.createSession({ sessionId: 'ses_replay' });
  const first = await collect(harness.prompt({ sessionId: 'ses_replay', input: 'same', idempotencyKey: 'same_key' }));
  const replay = await collect(harness.prompt({ sessionId: 'ses_replay', input: 'same', idempotencyKey: 'same_key' }));
  assert.equal(model.calls, 1);
  assert.deepEqual(replay.map(event => event.eventId), first.map(event => event.eventId));
  assert.ok(replay.every(event => event.snapshotReplay === 'replay'));
});

test('cancel and resume use explicit cancel plus resend semantics', async () => {
  const model = modelFrom(['a', 'b', 'c'], { waitForAbort: true });
  const harness = new AgentKitHarness({ model });
  await harness.createSession({ sessionId: 'ses_cancel' });
  const iterator = harness.prompt({ sessionId: 'ses_cancel', input: 'long', idempotencyKey: 'cancel_key' });
  const started = await iterator.next();
  const runId = started.value.runId;
  await harness.cancelRun({ sessionId: 'ses_cancel', runId });
  const canceled = await collect(iterator);
  assert.equal(canceled.at(-1).kind.type, 'run.canceled');
  const resumed = await collect(harness.resumeRun({ sessionId: 'ses_cancel', input: 'long', idempotencyKey: 'resume_key' }));
  assert.equal(resumed.at(-1).kind.type, 'run.completed');
  assert.equal(model.calls, 2);
});
