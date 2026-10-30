import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryExtractionScheduler, evaluateMemoryExtraction, countMessagesAfterCursor,
} from '../dist/memory-extraction-scheduler.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const user = (id, text, extra = {}) => ({ id, role: 'user', text, ...extra });
const assistant = (id, text, extra = {}) => ({ id, role: 'assistant', text, ...extra });
const snapshot = (boundaryId, messages) => ({ boundaryId, messages });
const eligible = () => snapshot('b1', [user('u1', 'remember that I prefer tea')]);

test('evaluateMemoryExtraction: run when new user prose >= 3 words after cursor', () => {
  assert.deepEqual(evaluateMemoryExtraction(snapshot('b1', [user('u1', 'remember that I prefer tea')])),
    { decision: 'run', messageCount: 1 });
});

test('evaluateMemoryExtraction: skip direct-memory-write when any new message has directMemoryWrite', () => {
  const snap = snapshot('b1', [user('u1', 'remember that I prefer tea'), assistant('a1', '', { directMemoryWrite: true })]);
  const decision = evaluateMemoryExtraction(snap);
  assert.equal(decision.decision, 'skip');
  assert.equal(decision.reason, 'direct-memory-write');
  assert.equal(decision.messageCount, 2);
});

test('evaluateMemoryExtraction: skip no-user-prose for synthetic/model-only/short/assistant-only/cursor-boundary', () => {
  assert.equal(evaluateMemoryExtraction(snapshot('b1', [user('u1', 'remember this', { synthetic: true })])).reason, 'no-user-prose');
  assert.equal(evaluateMemoryExtraction(snapshot('b1', [user('u1', 'remember this please', { modelOnly: true })])).reason, 'no-user-prose');
  assert.equal(evaluateMemoryExtraction(snapshot('b1', [user('u1', 'hi there')])).reason, 'no-user-prose');
  assert.equal(evaluateMemoryExtraction(snapshot('b1', [assistant('a1', 'I will save that')])).reason, 'no-user-prose');
  assert.equal(evaluateMemoryExtraction(snapshot('b1', [user('u1', 'remember that I prefer tea')]), 'u1').reason, 'no-user-prose');
});

test('countMessagesAfterCursor: absent/ found/ unfound cursor', () => {
  const messages = [user('u1', 'one two three'), user('u2', 'four five six')];
  assert.equal(countMessagesAfterCursor(messages, undefined), 2);
  assert.equal(countMessagesAfterCursor(messages, 'u1'), 1);
  assert.equal(countMessagesAfterCursor(messages, 'missing'), 2);
});

test('scheduler: real async scheduling runs execute and advances cursor on success', async () => {
  const calls = [];
  const scheduler = createMemoryExtractionScheduler(async input => { calls.push(input.messageCount); await tick(); return 'success'; });
  assert.equal(scheduler.hasPendingWork(), false);
  scheduler.schedule(eligible());
  assert.equal(scheduler.hasPendingWork(), true);
  await scheduler.drain();
  assert.deepEqual(calls, [1]);
  assert.equal(scheduler.getCursor(), 'b1');
  assert.equal(scheduler.hasPendingWork(), false);
});

test('scheduler: coalesces to the latest pending snapshot, dropping intermediate runs', async () => {
  let gate;
  const calls = [];
  const scheduler = createMemoryExtractionScheduler(async input => {
    calls.push(input.snapshot.boundaryId);
    if (calls.length === 1) await new Promise(resolve => { gate = resolve; });
    return 'success';
  });
  scheduler.schedule(snapshot('b1', [user('u1', 'remember that I prefer tea one')]));
  await tick();
  scheduler.schedule(snapshot('b2', [user('u2', 'remember that I prefer tea two')]));
  scheduler.schedule(snapshot('b3', [user('u3', 'remember that I prefer tea three')]));
  gate(); gate = undefined; await tick();
  await scheduler.drain();
  assert.deepEqual(calls, ['b1', 'b3']);
  assert.equal(scheduler.getCursor(), 'b3');
});

test('scheduler: failed onCursor persistence callback does not advance the in-memory cursor', async () => {
  const commits = [];
  const scheduler = createMemoryExtractionScheduler(async () => 'success',
    { onCursor: async () => { commits.push('attempt'); throw new Error('persist failed'); } });
  scheduler.schedule(eligible());
  await scheduler.drain();
  assert.deepEqual(commits, ['attempt']);
  assert.equal(scheduler.getCursor(), undefined, 'cursor must not advance on failed onCursor');
});

test('scheduler: skip still awaits onCursor and advances only on success', async () => {
  let commits = 0;
  const scheduler = createMemoryExtractionScheduler(async () => 'success', { onCursor: async () => { commits++; } });
  scheduler.schedule(snapshot('b1', [user('u1', 'remember that I prefer tea'), assistant('a1', '', { directMemoryWrite: true })]));
  await scheduler.drain();
  assert.equal(commits, 1);
  assert.equal(scheduler.getCursor(), 'b1');
});

test('scheduler: skip with a failing onCursor does not advance', async () => {
  const scheduler = createMemoryExtractionScheduler(async () => 'success', { onCursor: async () => { throw new Error('nope'); } });
  scheduler.schedule(snapshot('b1', [user('u1', 'remember that I prefer tea'), assistant('a1', '', { directMemoryWrite: true })]));
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), undefined);
});

test('scheduler: execute error does not advance cursor and leaves no pending work', async () => {
  const scheduler = createMemoryExtractionScheduler(async () => { throw new Error('extract failed'); });
  scheduler.schedule(eligible());
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), undefined);
  assert.equal(scheduler.hasPendingWork(), false);
});

test('scheduler: rejected snapshot promise is caught and never runs execute nor advances', async () => {
  const calls = [];
  const scheduler = createMemoryExtractionScheduler(async () => { calls.push('ran'); return 'success'; });
  scheduler.schedule(Promise.reject(new Error('acquisition failed')));
  await scheduler.drain();
  assert.deepEqual(calls, []);
  assert.equal(scheduler.getCursor(), undefined);
  assert.equal(scheduler.hasPendingWork(), false);
});

test('scheduler: no-op advances; error and aborted do not', async () => {
  let mode = 'no-op';
  const scheduler = createMemoryExtractionScheduler(async () => mode);
  scheduler.schedule(snapshot('b1', [user('u1', 'remember that I prefer tea')]));
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), 'b1');
  mode = 'error';
  scheduler.schedule(snapshot('b2', [user('u2', 'remember that I prefer tea too')]));
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), 'b1', 'error does not advance');
  mode = 'aborted';
  scheduler.schedule(snapshot('b3', [user('u3', 'remember that I prefer tea three')]));
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), 'b1', 'aborted does not advance');
});

test('scheduler: shutdown while execute is pending aborts the run and does not advance', async () => {
  let observedSignal;
  let executeResolve;
  const scheduler = createMemoryExtractionScheduler(async input => {
    observedSignal = input.abortSignal;
    await new Promise((resolve, reject) => {
      input.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      executeResolve = resolve;
    });
    return 'success';
  });
  scheduler.schedule(eligible());
  await tick();
  assert.equal(scheduler.hasPendingWork(), true);
  scheduler.shutdown();
  assert.equal(observedSignal.aborted, true);
  // hasPendingWork is false after shutdown by contract; drain still awaits cooperative completion.
  assert.equal(scheduler.hasPendingWork(), false);
  // Release the aborted execute so the run settles and drain returns.
  if (executeResolve) executeResolve();
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), undefined, 'no advance after shutdown');
});

test('scheduler: shutdown while a snapshot Promise is pending clears pending without waiting for acquisition', async () => {
  let acquireResolve;
  const scheduler = createMemoryExtractionScheduler(async () => 'success');
  const pending = new Promise(resolve => { acquireResolve = resolve; });
  scheduler.schedule(pending);
  await tick();
  assert.equal(scheduler.hasPendingWork(), true);
  scheduler.shutdown();
  assert.equal(scheduler.hasPendingWork(), false, 'shutdown clears pending immediately');
  // Resolving the snapshot after shutdown must not run execute or advance.
  acquireResolve(eligible());
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), undefined);
  assert.equal(scheduler.hasPendingWork(), false);
});

test('scheduler: shutdown while onCursor is pending does not advance even if it later resolves', async () => {
  let cursorResolve;
  let cursorCalled = false;
  const scheduler = createMemoryExtractionScheduler(async () => 'success',
    { onCursor: () => { cursorCalled = true; return new Promise(resolve => { cursorResolve = resolve; }); } });
  scheduler.schedule(eligible());
  await tick();
  // execute returned success; onCursor is now pending (cursorCalled true, cursorResolve set).
  assert.ok(cursorCalled, 'onCursor was reached');
  scheduler.shutdown();
  // Resolving onCursor after shutdown must not advance: advanceCursor re-checks shuttingDown.
  if (cursorResolve) cursorResolve();
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), undefined, 'shutdown after execute must not advance even if onCursor resolves');
});

test('scheduler: schedule after shutdown is a no-op and a rejected snapshot gets a handler', async () => {
  const scheduler = createMemoryExtractionScheduler(async () => 'success');
  scheduler.shutdown();
  scheduler.schedule(eligible());
  scheduler.schedule(Promise.reject(new Error('post-shutdown rejection')));
  assert.equal(scheduler.hasPendingWork(), false);
  assert.equal(scheduler.getCursor(), undefined);
  await tick(); // allow the rejected promise's catch handler to run; no unhandled rejection escapes
});

test('scheduler: initialCursor seeds the cursor and is respected by eligibility', async () => {
  const calls = [];
  const scheduler = createMemoryExtractionScheduler(async input => { calls.push(input.messageCount); return 'success'; },
    { initialCursor: 'u1' });
  scheduler.schedule(snapshot('u1', [user('u1', 'remember that I prefer tea')]));
  await scheduler.drain();
  assert.deepEqual(calls, [], 'cursor boundary excluded, no eligible prose after it');
  assert.equal(scheduler.getCursor(), 'u1', 'skip advances to boundary');
});

test('scheduler: drain is idempotent when there is no work', async () => {
  const scheduler = createMemoryExtractionScheduler(async () => 'success');
  await scheduler.drain();
  await scheduler.drain();
  assert.equal(scheduler.hasPendingWork(), false);
});

test('scheduler: schedule promise carries no unhandled rejection after coalescing and shutdown', async () => {
  let executeResolve;
  const scheduler = createMemoryExtractionScheduler(async () => new Promise(resolve => { executeResolve = resolve; }));
  scheduler.schedule(snapshot('b1', [user('u1', 'remember that I prefer tea')]));
  await tick();
  // Coalesce a rejected snapshot while the first run is still active.
  scheduler.schedule(Promise.reject(new Error('coalesced rejection')));
  // The rejected promise is now latestPending; shutdown drops it without await,
  // and schedule-after-shutdown's catch handler covers the rejected coalesced one.
  scheduler.shutdown();
  assert.equal(scheduler.hasPendingWork(), false);
  if (executeResolve) executeResolve('success');
  await scheduler.drain();
  // Reaching here means no unhandled rejection escaped.
  assert.ok(true);
});
