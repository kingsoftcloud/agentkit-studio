import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { once, getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  NativeKernel, MemoryRunStore, emptyUsage, configure, initialSnapshot, canonical, copy, BACKGROUND_COMMAND_CONTRACT,
} from '../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeBackgroundWatchStore } from '../src/host/services/native-background-watch-store.mjs';
import { createStudioNativeBackgroundWatcher } from '../src/host/services/native-background-watcher.mjs';

const scope = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const realTmp = realpathSync(tmpdir());
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const TASK_ID = 'a'.repeat(64);
const launcher = { name: 'run_command', description: 'Launch', parameters: { type: 'object' },
  readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 30000,
  backgroundCommandPolicy: 'owned-command-launch/v1', contextRole: 'none',
  observationRole: 'none', progressObservation: false, contextRetention: 'normal' };

/** Real Kernel model → launch receipt → final candidate. Model and remote
 * command transport are deterministic ports; no terminal snapshot is seeded. */
async function produceSource(t) {
  const memStore = new MemoryRunStore();
  const config = configure({ profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' },
    contract: { objective: 'Launch a background command' }, hostBindingDigest: 'fixture-host/v1',
    tools: [launcher], backgroundNotificationPolicy: 'completed-before-model/v1' });
  const snapshot = initialSnapshot({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, config, digest(config));
  let calls = 0;
  const kernel = new NativeKernel({ store: memStore, digest, owner: 'launch', now: () => 1,
    ports: { model: { generate: async () => ++calls === 1 ? { kind: 'tool_calls', text: '', usage: emptyUsage(),
      toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] }
      : { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() } },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
    tools: { execute: async request => ({ status: 'ok', content: { backend: 'sandbox/local_process', task_id: TASK_ID },
      backgroundCommandRef: { taskId: TASK_ID, sourceRunId: 'run', operationKey: request.operationKey } }) } } });
  kernel.start(snapshot, config);
  await kernel.runUntilIdle(scope, 'run');
  const record = memStore.load(scope, 'run');
  assert.equal(record.snapshot.phase, 'completed');
  assert.equal(record.snapshot.backgroundCommands[0].notified, false);
  const ref = record.snapshot.backgroundCommands[0].ref;
  return { store: memStore, record, ref };
}

// --- watch store: register with real Native record, flat minimal shape ---

test('register stores flat minimal identity (no full record, no snapshot)', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-flat-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const result = watches.register(record, ref);
  assert.equal(result.key, sha256(canonical({ scope, sourceRunId: 'run', taskId: TASK_ID })));
  assert.equal(result.status, 'watching');
  const w = watches.list()[0];
  // Flat shape: no snapshot, no configuration, no messages, no receipts.
  assert.equal(w.scope.agentId, 'agent');
  assert.equal(w.sourceRunId, 'run');
  assert.equal(w.taskId, TASK_ID);
  assert.equal('snapshot' in w, false, 'must not store snapshot');
  assert.equal('configuration' in w, false, 'must not store configuration');
  assert.equal('intents' in w, false, 'must not store intents');
  assert.equal('receipts' in w, false, 'must not store receipts');
  watches.close();
});

test('register is idempotent — same record returns same key', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-idem-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const r1 = watches.register(record, ref);
  const r2 = watches.register(record, ref);
  assert.equal(r1.key, r2.key);
  assert.equal(r2.status, 'watching');
  watches.close();
});

test('register hard-fails on identity conflict (not silently skipped)', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-conf-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  // Same key (same scope/sourceRunId/taskId) but different buildId → identity conflict.
  // Must pass extractWatch validation first, so change only an identity field
  // that doesn't break the launch proof.
  const drifted = copy(record);
  drifted.snapshot = { ...drifted.snapshot, buildId: 'different-build' };
  assert.throws(() => watches.register(drifted, ref), { code: 'watch_identity_conflict' });
  watches.close();
});

test('register rejects an already-notified command', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-notified-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  // Simulate already-notified.
  const notifiedRecord = copy(record);
  notifiedRecord.snapshot.backgroundCommands[0].notified = true;
  assert.throws(() => watches.register(notifiedRecord, ref), /watch_command_already_notified/);
  watches.close();
});

// --- watch store: list, outcome, admitted, immutability ---

test('admitted watches remain in pending list; discarded excluded', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-pend-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const { key } = watches.register(record, ref);
  watches.recordOutcome(key, { status: 'admitted', noticeRunId: 'wake_real_1' });
  assert.equal(watches.list({ pendingOnly: true }).length, 1);
  assert.equal(watches.list({ pendingOnly: true })[0].status, 'admitted');
  watches.recordOutcome(key, { status: 'discarded', reason: 'already_notified' });
  assert.equal(watches.list({ pendingOnly: true }).length, 0);
  watches.close();
});

test('noticeRunId is monotonic — set once, never replaced', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-notice-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const { key } = watches.register(record, ref);
  watches.recordOutcome(key, { status: 'admitted', noticeRunId: 'wake_real_1' });
  assert.throws(() => watches.recordOutcome(key, { status: 'admitted', noticeRunId: 'wake_real_2' }), { code: 'watch_notice_run_id_immutable' });
  watches.close();
});

test('discarded is terminal — cannot revert', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-term-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const { key } = watches.register(record, ref);
  watches.recordOutcome(key, { status: 'discarded', reason: 'already_notified' });
  watches.recordOutcome(key, { status: 'watching' });
  assert.equal(watches.list().find(w => w.key === key).status, 'discarded');
  watches.close();
});

test('watch store persists across reopen', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-persist-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const { key } = watches.register(record, ref);
  watches.recordOutcome(key, { status: 'admitted', noticeRunId: 'wake_real_1' });
  watches.close();
  const watches2 = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const pending = watches2.list({ pendingOnly: true });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'admitted');
  assert.equal(pending[0].taskId, TASK_ID);
  watches2.close();
});

// --- watch store: corrupt + cross-process owner ---

test('corrupt SQLite fails hard (does not reset)', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-corrupt-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, 'watches.sqlite'), 'NOT A DATABASE', { mode: 0o600 });
  assert.throws(() => createNativeBackgroundWatchStore(join(base, 'watches.sqlite')));
});

test('second construction while first is alive is busy', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-busy-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  assert.throws(() => createNativeBackgroundWatchStore(join(base, 'watches.sqlite')), { code: 'watch_store_owner_busy' });
  watches.close();
  const watches2 = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches2.close();
});

test('cross-process: second process busy; after close recovers', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-xproc-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dbFile = join(base, 'watches.sqlite');
  const script = join(base, 'probe.mjs');
  writeFileSync(script, `import { createNativeBackgroundWatchStore } from '${join(process.cwd(), 'src/host/services/native-background-watch-store.mjs')}';
  try { const s = createNativeBackgroundWatchStore('${dbFile}'); process.stdout.write('OK'); s.close(); }
  catch(e) { process.stdout.write(e.code || 'ERROR'); }`);
  const child1 = spawnSync(process.execPath, ['--experimental-sqlite', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child1.stdout, 'OK', `first: ${child1.stderr}`);
  const child2 = spawnSync(process.execPath, ['--experimental-sqlite', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child2.stdout, 'OK', `second after close: ${child2.stderr}`);
});

test('cross-process: SIGKILL owner, then new process acquires', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-kill-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dbFile = join(base, 'watches.sqlite');
  // Hold a real registry and flushed registration until the parent kills it.
  const holderScript = join(base, 'hold.mjs');
  const { record, ref } = await produceSource(t);
  const recordFile = join(base, 'source.json');
  writeFileSync(recordFile, JSON.stringify({ record, ref }));
  writeFileSync(holderScript, `import { createNativeBackgroundWatchStore } from '${join(process.cwd(), 'src/host/services/native-background-watch-store.mjs')}';
  import { readFileSync } from 'node:fs';
  const store=createNativeBackgroundWatchStore('${dbFile}');
  const {record,ref}=JSON.parse(readFileSync('${recordFile}','utf8'));
  store.register(record,ref);
  process.stdout.write('HELD'); setInterval(()=>store.list({pendingOnly:true}), 60000);`);
  const { spawn } = await import('node:child_process');
  const holder = spawn(process.execPath, ['--experimental-sqlite', holderScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(holder, 'close');
  t.after(async () => { if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL'); await exited; });
  const [held] = await once(holder.stdout, 'data', { signal: AbortSignal.timeout(5000) });
  assert.equal(String(held), 'HELD');
  // Second process should be busy.
  const probeScript = join(base, 'probe.mjs');
  writeFileSync(probeScript, `import { createNativeBackgroundWatchStore } from '${join(process.cwd(), 'src/host/services/native-background-watch-store.mjs')}';
  try { const s = createNativeBackgroundWatchStore('${dbFile}'); process.stdout.write('OK'); s.close(); }
  catch(e) { process.stdout.write(e.code); }`);
  const busy = spawnSync(process.execPath, ['--experimental-sqlite', probeScript], { encoding: 'utf8', timeout: 5000 });
  assert.equal(busy.stdout, 'watch_store_owner_busy', `expected busy, got: ${busy.stdout}`);
  // SIGKILL the holder.
  holder.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
  // Now a new process can acquire.
  const recovered = spawnSync(process.execPath, ['--experimental-sqlite', probeScript], { encoding: 'utf8', timeout: 10000 });
  assert.equal(recovered.stdout, 'OK', `after kill: ${recovered.stderr}`);
  const cold = createNativeBackgroundWatchStore(dbFile);
  assert.equal(cold.list({ pendingOnly: true })[0].taskId, TASK_ID, 'flushed registration survives actual owner death');
  cold.close();
});

// --- watcher: ledger scan + dispatch with original taskId ---

test('tick scans the real ledger and registers a completed source Run', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-scan-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  assert.equal(watches.list().length, 0);
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => [scope], dispatch: async () => ({ status: 'discarded', reason: 'already_notified' }),
  });
  await watcher.tick();
  assert.equal(watches.list().length, 1);
  assert.equal(watches.list()[0].status, 'discarded');
  watcher.close(); watches.close();
});

test('dispatch receives the original taskId, not the registry hash', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-taskid-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  let dispatchedTaskId = null;
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => [], dispatch: async req => {
      dispatchedTaskId = req.taskId;
      return { status: 'discarded', reason: 'already_notified' };
    },
  });
  await watcher.tick();
  assert.equal(dispatchedTaskId, TASK_ID, 'dispatch must receive original taskId, not registry hash');
  assert.notEqual(dispatchedTaskId, watches.list()[0].key, 'taskId must differ from registry key');
  watcher.close(); watches.close();
});

test('tick continues dispatching existing watches even if listScopes fails', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-scopefail-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  const dispatched = [];
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => { throw new Error('scope enum failed'); },
    dispatch: async req => { dispatched.push(req); return { status: 'discarded', reason: 'already_notified' }; },
  });
  await assert.rejects(watcher.tick(), { code: 'scan_errors' });
  assert.equal(dispatched.length, 1, 'existing watch dispatched even if listScopes fails');
  watcher.close(); watches.close();
});

test('duplicate tick shares in-flight promise (no double dispatch)', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-notwin-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  let release;
  const gate = new Promise(r => { release = r; });
  const dispatched = [];
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => [], dispatch: async req => { dispatched.push(req); await gate; return { status: 'watching' }; },
  });
  const p1 = watcher.tick();
  const p2 = watcher.tick();
  release();
  await Promise.all([p1, p2]);
  assert.equal(dispatched.length, 1, 'duplicate tick should not double-dispatch');
  watcher.close(); watches.close();
});

test('transient pending_admission then success on next tick', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-busy2-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  let calls = 0;
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => [], dispatch: async () => {
      calls++;
      return calls === 1 ? { status: 'pending_admission', reason: 'sdk_busy' } : { status: 'discarded', reason: 'already_notified' };
    },
  });
  await watcher.tick();
  assert.equal(watches.list({ pendingOnly: true })[0].status, 'pending_admission');
  await watcher.tick();
  assert.equal(watches.list({ pendingOnly: true }).length, 0);
  watcher.close(); watches.close();
});

test('dispatch exception retains pending with bounded code, no secret leak', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-exc2-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  const errors = [];
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => [], dispatch: async () => { throw new Error('secret-api-key-leak'); },
    onError: e => errors.push(e.code),
  });
  await watcher.tick();
  assert.equal(watches.list({ pendingOnly: true })[0].status, 'pending_admission');
  assert.equal(errors[0], 'dispatch_exception');
  assert.equal(JSON.stringify(watches.list()).includes('secret-api-key-leak'), false);
  watcher.close(); watches.close();
});

// --- watcher: close + cancellation ---

test('close prevents late dispatch from modifying the registry', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-close2-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  let release;
  const gate = new Promise(r => { release = r; });
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => [], dispatch: async () => { await gate; return { status: 'discarded', reason: 'late' }; },
  });
  const tickPromise = watcher.tick();
  watcher.close();
  release();
  await tickPromise.catch(() => {}); // late return observed
  const watch = watches.list().find(w => w.key);
  assert.notEqual(watch.status, 'discarded', 'late dispatch after close should not discard');
  watches.close();
});

test('lifetime signal abort: no unhandledRejection', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-abort-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  watches.register(record, ref);
  const controller = new AbortController();
  const unhandled = [];
  const listener = e => unhandled.push(e.message);
  process.on('unhandledRejection', listener);
  try {
    let release;
    const gate = new Promise(r => { release = r; });
    const watcher = createStudioNativeBackgroundWatcher({
      store, watches, listScopes: async () => { await gate; return []; }, dispatch: async () => ({ status: 'watching' }),
      signal: controller.signal,
    });
    const tickPromise = watcher.tick();
    controller.abort();
    release();
    await tickPromise.catch(() => {});
    await new Promise(r => setTimeout(r, 10));
    assert.equal(unhandled.length, 0);
    watcher.close();
  } finally { process.off('unhandledRejection', listener); }
  watches.close();
});

// --- watcher: start awaits first scan ---

test('start awaits the first scan before starting the timer', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-start2-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const dispatched = [];
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches, listScopes: async () => [scope], dispatch: async () => { dispatched.push(1); return { status: 'discarded', reason: 'already_notified' }; },
    intervalMs: 500,
  });
  await watcher.start();
  assert.equal(dispatched.length, 1, 'start should complete first scan+dispatch');
  assert.equal(watcher.status().running, true);
  watcher.close(); watches.close();
});

// --- cold-process: admitted re-drive ---

test('admitted watch survives reopen and is re-driven by a new coordinator', async (t) => {
  const base = mkdtempSync(join(realTmp, 'bgw-reopen2-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { store, record, ref } = await produceSource(t);
  const watches = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  const { key } = watches.register(record, ref);
  watches.recordOutcome(key, { status: 'admitted', noticeRunId: 'wake_real_1' });
  watches.close();
  const watches2 = createNativeBackgroundWatchStore(join(base, 'watches.sqlite'));
  assert.equal(watches2.list({ pendingOnly: true }).length, 1);
  assert.equal(watches2.list({ pendingOnly: true })[0].status, 'admitted');
  const dispatched = [];
  const watcher = createStudioNativeBackgroundWatcher({
    store, watches: watches2, listScopes: async () => [], dispatch: async req => { dispatched.push(req); return { status: 'discarded', reason: 'already_notified' }; },
  });
  await watcher.tick();
  assert.equal(dispatched.length, 1, 'admitted watch re-driven');
  watcher.close(); watches2.close();
});

async function watcherFixture(t) {
  const base = mkdtempSync(join(realTmp, 'bgw-faults-'));
  const source = await produceSource(t);
  const filename = join(base, 'registry.sqlite');
  const watches = createNativeBackgroundWatchStore(filename), watchers = [];
  watches.register(source.record, source.ref);
  t.after(async () => {
    await Promise.all(watchers.map(watcher => watcher.close()));
    watches.close(); rmSync(base, { recursive: true, force: true });
  });
  return { ...source, base, filename, watches, make(options) {
    const watcher = createStudioNativeBackgroundWatcher({ store: source.store, watches,
      listScopes: async () => [], dispatch: async () => ({ status: 'watching' }), ...options });
    watchers.push(watcher); return watcher;
  } };
}

test('concurrent starts wait for the same scan failure, and a later start can retry', async t => {
  const h = await watcherFixture(t);
  let release, fail = true, scanned = 0, dispatched = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const watcher = h.make({ listScopes: async () => {
    scanned++; await gate;
    if (fail) throw new Error('temporary discovery failure');
    return [];
  }, dispatch: async () => { dispatched++; return { status: 'watching' }; } });
  let resolved = false;
  const first = watcher.start(), second = watcher.start();
  void second.then(() => { resolved = true; }, () => {});
  const rejected = Promise.all([assert.rejects(first, { code: 'scan_errors' }), assert.rejects(second, { code: 'scan_errors' })]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scanned, 1); assert.equal(resolved, false); assert.equal(watcher.status().running, false);
  release(); await rejected;
  assert.equal(dispatched, 1, 'old watches are still driven before the startup error is reported');
  fail = false; await watcher.start();
  assert.equal(scanned, 2); assert.equal(watcher.status().running, true);
  await watcher.close(); assert.equal(watcher.status().running, false);
});

for (const failure of ['list', 'identity_conflict', 'scopes_not_array', 'snapshots_not_array']) {
  test(`scan ${failure} remains visible after the original watch is dispatched`, async t => {
    const h = await watcherFixture(t);
    let dispatched = 0;
    const store = {
      list: (...args) => failure === 'list' ? (() => { throw Error('ledger unavailable'); })()
        : failure === 'snapshots_not_array' ? null : h.store.list(...args),
      load: (...args) => {
        const record = h.store.load(...args);
        return failure === 'identity_conflict'
          ? { ...record, snapshot: { ...record.snapshot, buildId: 'changed-build' } } : record;
      },
    };
    const watcher = h.make({ store, listScopes: async () => failure === 'scopes_not_array' ? null : [scope],
      dispatch: async request => {
        assert.equal(request.taskId, TASK_ID); dispatched++;
        return { status: 'discarded', reason: 'already_notified' };
      } });
    await assert.rejects(watcher.tick(), { code: 'scan_errors' });
    assert.equal(dispatched, 1); assert.equal(h.watches.list({ pendingOnly: true }).length, 0);
    assert.equal(watcher.status().lastError, 'scan_errors');
  });
}

test('malformed persisted rows fail cold open and release their owner lock', async t => {
  const h = await watcherFixture(t);
  h.watches.close();
  const db = new DatabaseSync(h.filename);
  const row = db.prepare('SELECT * FROM native_background_watches').get();
  const update = (watch, identity, key, version, reason = null) => {
    db.exec('DELETE FROM native_background_watches');
    db.prepare('INSERT INTO native_background_watches VALUES (?,?,?,?,?,?,?,?,?)')
      .run(key, identity, canonical(watch), 'watching', reason, null, 1, 1, version);
  };
  const original = JSON.parse(row.watch);
  try {
    for (const [watch, identity, key, version, reason] of [
      [{ ...original, taskId: 'not-a-task' }, row.identity, row.key, 1],
      [{ ...original, snapshot: { unnecessary: 'full record' } }, row.identity, row.key, 1],
      [{ ...original, scope: { ...original.scope, extra: 'wrong' } }, row.identity, row.key, 1],
      [original, 'unrelated-identity', row.key, 1],
      [original, row.identity, 'f'.repeat(64), 1],
      [original, row.identity, row.key, 2],
      [original, row.identity, row.key, 1, 'x'.repeat(100)],
    ]) {
      update(watch, identity, key, version, reason);
      assert.throws(() => createNativeBackgroundWatchStore(h.filename), error => error.code.startsWith('watch_store_'));
    }
    update(original, row.identity, row.key, 1);
    db.prepare('INSERT INTO native_background_watches VALUES (?,?,?,?,?,?,?,?,?)')
      .run('b'.repeat(64), row.identity, row.watch, 'watching', null, null, 2, 2, 2);
    assert.throws(() => createNativeBackgroundWatchStore(h.filename), { code: 'watch_store_schema_unsupported' },
      'a valid first row must not hide a corrupt later row');
    update(original, row.identity, row.key, 1);
    const recovered = createNativeBackgroundWatchStore(h.filename);
    assert.equal(recovered.list().length, 1); recovered.close();
  } finally { db.close(); }
});

test('data file open failure releases ownership and new private directories can be created', t => {
  const base = mkdtempSync(join(realTmp, 'bgw-open-fault-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'new-private');
  const initial = createNativeBackgroundWatchStore(join(dir, 'initial.sqlite')); initial.close();
  mkdirSync(join(dir, 'blocked.sqlite'), { mode: 0o700 });
  assert.throws(() => createNativeBackgroundWatchStore(join(dir, 'blocked.sqlite')));
  const next = createNativeBackgroundWatchStore(join(dir, 'valid.sqlite')); next.close();
});

test('close drains the aborted tick while observing a noncooperative late rejection', async t => {
  const h = await watcherFixture(t);
  let enter, reject, writes = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise((_, fail) => { reject = fail; });
  const watcher = h.make({ watches: { ...h.watches,
    recordOutcome(...args) { writes++; return h.watches.recordOutcome(...args); } },
    dispatch: async () => { enter(); await gate; return { status: 'discarded' }; } });
  const tick = watcher.tick();
  await entered;
  const first = watcher.close(), second = watcher.close();
  assert.equal(first, second);
  await first; await tick;
  h.watches.close(); reject(Error('late noncooperative dispatch'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});

test('repeated polling removes each temporary abort listener', async t => {
  const h = await watcherFixture(t);
  let lifetime;
  const watcher = h.make({ dispatch: async ({ signal }) => { lifetime = signal; return { status: 'watching' }; } });
  for (let index = 0; index < 30; index++) await watcher.tick();
  assert.equal(getEventListeners(lifetime, 'abort').length, 0);
});
