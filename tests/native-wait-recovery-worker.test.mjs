/** Tests for the Native wait recovery worker. Covers async boundaries,
 *  concurrent tick coalescing, close-late-callback, per-candidate failure
 *  isolation, and automatic timer-triggered ticks. Not a migration proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWaitRecoveryWorker } from '../src/host/services/native-wait-recovery-worker.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const candidate = (runId = 'r1', sessionId = 's1') => ({ scope, sessionId, runId });

function ac() { return new AbortController(); }

// ---- validation ----------------------------------------------------------

test('rejects missing/wrong dependency functions and signal', () => {
  const s = ac().signal;
  assert.throws(() => createNativeWaitRecoveryWorker({ restore() {}, signal: s }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
  assert.throws(() => createNativeWaitRecoveryWorker({ listCandidates() {}, signal: s }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
  assert.throws(() => createNativeWaitRecoveryWorker({ listCandidates() {}, restore() {}, signal: null }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
  assert.throws(() => createNativeWaitRecoveryWorker({ listCandidates() {}, restore() {}, signal: 'x' }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
  assert.throws(() => createNativeWaitRecoveryWorker({ listCandidates() {}, restore() {}, signal: s, intervalMs: 50 }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
  assert.throws(() => createNativeWaitRecoveryWorker({ listCandidates() {}, restore() {}, signal: s, intervalMs: 300001 }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
  assert.throws(() => createNativeWaitRecoveryWorker({ listCandidates() {}, restore() {}, signal: s, intervalMs: 100.5 }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
  assert.throws(() => createNativeWaitRecoveryWorker({ listCandidates() {}, restore() {}, signal: s, onError: 'x' }), { code: 'A2A_WAIT_RECOVERY_INVALID' });
});

test('accepts intervalMs boundary 100 and 300000', () => {
  const s = ac().signal;
  const w1 = createNativeWaitRecoveryWorker({ listCandidates() { return []; }, restore() {}, signal: s, intervalMs: 100 });
  const w2 = createNativeWaitRecoveryWorker({ listCandidates() { return []; }, restore() {}, signal: s, intervalMs: 300000 });
  assert.equal(typeof w1.start, 'function');
  assert.equal(typeof w2.close, 'function');
});

// ---- start + status ------------------------------------------------------

test('start runs first tick and restores all valid candidates', async () => {
  const restored = [];
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return [candidate('r1'), candidate('r2')]; },
    restore(c) { restored.push(c.runId); }, signal: s, intervalMs: 1000,
  });
  await w.start();
  await w.tick(); // drain first tick
  assert.deepEqual(restored.sort(), ['r1', 'r2']);
  assert.equal(w.status().restoredCount, 2);
  assert.equal(w.status().tickCount, 1);
  await w.close();
});

test('start does not block on long restore (resolves while restore in-flight)', async () => {
  let restoreStarted = false, restoreResolve;
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return [candidate()]; },
    restore() { restoreStarted = true; return new Promise(r => { restoreResolve = r; }); },
    signal: s, intervalMs: 1000,
  });
  const startP = w.start();
  await startP; // start resolves before restore completes
  while (!restoreStarted) await Promise.resolve();
  assert.ok(restoreStarted, 'restore was invoked');
  assert.equal(w.status().restoredCount, 0, 'restore not yet counted');
  restoreResolve();
  await sleep(5);
  assert.equal(w.status().restoredCount, 1);
  await w.close();
});

// ---- per-candidate failure isolation -------------------------------------

test('per-candidate restore failure does not block subsequent candidates', async () => {
  const restored = [];
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return [candidate('r1'), candidate('r2'), candidate('r3')]; },
    restore(c) { if (c.runId === 'r2') throw Object.assign(new Error('boom'), { code: 'A2A_WAIT_RECOVERY_RESTORE_FAILED' }); restored.push(c.runId); },
    signal: s, intervalMs: 1000,
  });
  await w.start();
  await assert.rejects(w.tick(), AggregateError);
  assert.deepEqual(restored.sort(), ['r1', 'r3']);
  assert.equal(w.status().restoredCount, 2);
  assert.equal(w.status().lastError, 'A2A_WAIT_RECOVERY_RESTORE_FAILED');
  await w.close();
});

test('invalid candidate is reported and skipped, others restored', async () => {
  const restored = [];
  const errors = [];
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return [candidate('r1'), { scope: null, sessionId: 's', runId: 'r2' }, candidate('r3')]; },
    restore(c) { restored.push(c.runId); }, signal: s, intervalMs: 1000, onError: e => errors.push(e.code),
  });
  await w.start();
  await assert.rejects(w.tick(), AggregateError);
  assert.deepEqual(restored.sort(), ['r1', 'r3']);
  assert.ok(errors.includes('A2A_WAIT_RECOVERY_CANDIDATE_INVALID'));
  await w.close();
});

test('listCandidates returning non-array is reported', async () => {
  const errors = [];
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return {}; }, restore() {}, signal: s, intervalMs: 1000, onError: e => errors.push(e.code),
  });
  await w.start();
  await assert.rejects(w.tick(), AggregateError);
  assert.ok(errors.includes('A2A_WAIT_RECOVERY_INVALID'));
  await w.close();
});

test('onError receives only code, no candidate input', async () => {
  let seen = null;
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return [candidate('secret-run')]; },
    restore() { throw new Error('leak'); }, signal: s, intervalMs: 1000, onError: e => seen = e,
  });
  await w.start();
  await assert.rejects(w.tick(), AggregateError);
  assert.ok(seen && typeof seen.code === 'string');
  assert.equal(JSON.stringify(seen).includes('secret-run'), false, 'no candidate id in error');
  assert.equal(JSON.stringify(seen).includes('leak'), false, 'no raw message in error');
  await w.close();
});

test('unknown error code is normalized to A2A_WAIT_RECOVERY_RESTORE_FAILED', async () => {
  const errors = [];
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return [candidate()]; },
    restore() { throw Object.assign(new Error('x'), { code: 'TOTALLY_UNKNOWN' }); },
    signal: s, intervalMs: 1000, onError: e => errors.push(e.code),
  });
  await w.start();
  await assert.rejects(w.tick(), AggregateError);
  assert.equal(errors[0], 'A2A_WAIT_RECOVERY_RESTORE_FAILED');
  await w.close();
});

// ---- concurrent tick coalescing ------------------------------------------

test('concurrent tick calls share inflight (no duplicate restore)', async () => {
  const restored = [];
  const s = ac().signal;
  let slowList;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return new Promise(r => { slowList = r; }); },
    restore(c) { restored.push(c.runId); }, signal: s, intervalMs: 1000,
  });
  const t1 = w.tick();
  const t2 = w.tick();
  assert.equal(t1, t2, 'same inflight promise returned');
  await Promise.resolve();
  slowList([candidate('r1')]);
  await Promise.all([t1, t2]);
  assert.deepEqual(restored, ['r1'], 'restore ran once despite two ticks');
  await w.close();
});

// ---- close + late callbacks ---------------------------------------------

test('close stops timer; no further ticks after close', async () => {
  let ticks = 0;
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { ticks++; return []; }, restore() {}, signal: s, intervalMs: 100,
  });
  await w.start();
  await Promise.resolve();
  assert.ok(ticks >= 1);
  await w.close();
  const ticksAtClose = ticks;
  await sleep(250);
  assert.equal(ticks, ticksAtClose, 'no ticks after close');
});

test('late listCandidates result after close is discarded (no restore)', async () => {
  const restored = [];
  let resolveList;
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return new Promise(r => { resolveList = r; }); },
    restore(c) { restored.push(c.runId); }, signal: s, intervalMs: 1000,
  });
  await w.start();
  await w.close();
  resolveList([candidate('r1')]); // late result
  await sleep(20);
  assert.deepEqual(restored, [], 'late listCandidates did not restore');
});

test('late restore result after close does not update restoredCount', async () => {
  let resolveRestore;
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return [candidate()]; },
    restore() { return new Promise(r => { resolveRestore = r; }); }, signal: s, intervalMs: 1000,
  });
  await w.start();
  await sleep(5);
  await w.close();
  const before = w.status();
  resolveRestore();
  await sleep(20);
  assert.deepEqual(w.status(), before, 'late restore did not mutate closed status');
});

test('close does not hang on uncooperative in-flight tick', async () => {
  let resolveList;
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return new Promise(r => { resolveList = r; }); },
    restore() {}, signal: s, intervalMs: 1000,
  });
  await w.start();
  // tick is inflight (listCandidates pending), never resolve it
  const closeP = w.close();
  // close should resolve within a reasonable bound despite pending listCandidates
  const settled = await Promise.race([closeP.then(() => true), sleep(500).then(() => false)]);
  assert.ok(settled, 'close resolved despite uncooperative in-flight tick');
  resolveList([]); // cleanup
});

test('close is idempotent', async () => {
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({ listCandidates() { return []; }, restore() {}, signal: s, intervalMs: 1000 });
  await w.close();
  await w.close();
  assert.equal(w.status().closed, true);
});

// ---- external signal abort ----------------------------------------------

test('external signal abort stops timer and prevents ticks', async () => {
  let ticks = 0;
  const c = ac();
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { ticks++; return []; }, restore() {}, signal: c.signal, intervalMs: 100,
  });
  await w.start();
  assert.ok(ticks >= 1);
  c.abort(new Error('external'));
  await sleep(250);
  const ticksAtAbort = ticks;
  await sleep(250);
  assert.equal(ticks, ticksAtAbort, 'no ticks after external abort');
  await w.close();
});

test('pre-aborted signal: start does not tick', async () => {
  let ticks = 0;
  const c = ac(); c.abort();
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { ticks++; return []; }, restore() {}, signal: c.signal, intervalMs: 1000,
  });
  await w.start();
  await sleep(20);
  assert.equal(ticks, 0);
  await w.close();
});

// ---- automatic timer ticks ----------------------------------------------

test('automatic timer triggers multiple ticks over time', async () => {
  let ticks = 0;
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { ticks++; return []; }, restore() {}, signal: s, intervalMs: 120,
  });
  await w.start();
  await sleep(500);
  assert.ok(ticks >= 3, `expected >=3 ticks, got ${ticks}`);
  await w.close();
});

// ---- errors bounded ------------------------------------------------------

test('errors are bounded to a max count', async () => {
  const many = Array.from({ length: 300 }, (_, i) => candidate(`r${i}`));
  const s = ac().signal;
  const w = createNativeWaitRecoveryWorker({
    listCandidates() { return many; },
    restore() { throw Object.assign(new Error('x'), { code: 'A2A_WAIT_RECOVERY_RESTORE_FAILED' }); },
    signal: s, intervalMs: 1000,
  });
  await w.start();
  await assert.rejects(w.tick(), AggregateError);
  await sleep(10);
  assert.ok(w.status().errors.length <= 256, `errors bounded: ${w.status().errors.length}`);
  await w.close();
});
