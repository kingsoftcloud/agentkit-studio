import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeKernel, MemoryRunStore, emptyUsage, prepareEffect, plan, transition, reduceCommand, reduceBrowserReceipt,
  browserRecoveryTransition, sealCandidate, validateBrowserObservation, validateBrowserSessionRef } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from './fixtures.mjs';
const browser = tool({ name: 'browser', readOnly: false, concurrentSafe: false, observationRole: 'browser' });
const call = { callId: 'browser-call', name: 'browser', arguments: {} };
test('browser evidence binds the canonical Host entry and ignores projected model/display paths', () => {
  const { snapshot } = fixture(), ref = reference();
  const result = { status: 'ok', content: { entry_path: 'app/index.html' },
    context: { content: '{"entry_path":"other/index.html"}' },
    browserSessionRef: ref, browserObservation: observation(ref) };
  assert.equal(reduceBrowserReceipt(snapshot, result, browser, call, digest).lastBrowserObservation.entryPath, 'app/index.html');
  const projectedOnly = { ...result, content: 'Host policy view without a typed path' };
  assert.equal(reduceBrowserReceipt(snapshot, projectedOnly, browser, call, digest).lastBrowserObservation.entryPath, undefined);
});
const reference = changes => validateBrowserSessionRef({ sessionId: 'page', scope, runId: 'run', runtimeId: 'browser-owner',
  workspaceRevision: 'workspace-1', ...changes });
const observation = (ref, changes = {}) => validateBrowserObservation({ sessionRef: ref, actionId: 'observe-new', actionSeq: 1,
  status: 'ok', complete: true, retryability: 'safe', viewport: [1280, 720], text: 'Observed page',
  screenshot: { contentRef: 'host:screenshot', width: 1280, height: 720, contentBlock: { type: 'image_url', image_url: { url: 'data:image/png;base64,cG5n' } } },
  ...changes });
const final = text => ({ kind: 'final_candidate', text, toolCalls: [], usage: emptyUsage() });
const report = (ref, status, changes = {}) => ({ status, sessionRef: status === 'restarted' ? { ...ref, generation: 2, leaseEpoch: 2 } : ref,
  lastActionSeq: 4, reason: null, reobserveAvailable: false, ...changes });
function state(configuration = {}, changes = {}) {
  const { config, snapshot } = fixture({ tools: [browser], ...configuration });
  const ref = reference(), evidence = { sessionRef: ref, actionId: 'old-action', actionSeq: 1, digest: 'sha256:old',
    callId: 'old', toolCall: 1, goalRevision: 0, workspaceRevision: null };
  return { config, snapshot: { ...snapshot, phase: 'preparing_context', usage: { ...snapshot.usage, toolCalls: 1 },
    browserSessionRefs: [ref], lastBrowserObservation: evidence, lastBrowserAttemptToolCall: 1, ...changes }, ref };
}
test('only a pinned browser tool admits typed references, including failed and unknown receipts', () => {
  const { snapshot, ref } = state();
  for (const status of ['ok', 'error', 'uncertain']) {
    const result = { status, content: {}, browserSessionRef: ref };
    assert.deepEqual(reduceBrowserReceipt(snapshot, result, tool(), call, digest), {});
    assert.deepEqual(reduceBrowserReceipt(snapshot, result, browser, call, digest).browserSessionRefs, [ref]);
  }
  const forged = reduceBrowserReceipt(snapshot, { status: 'ok', content: {}, browserSessionRef: reference({ runId: 'foreign' }) }, browser, call, digest);
  assert.equal(forged.reason, 'browser_reference_scope_mismatch'); assert.equal(forged.lastBrowserObservation, null);
  assert.throws(() => reduceBrowserReceipt(snapshot, { status: 'ok', content: {}, browserSessionClosed: true }, browser, call, digest),
    { code: 'browser_closure_reference_missing' });
});
test('owner bound, exact closure, replacement identity and the 16-owner limit are enforced', () => {
  const { snapshot, ref } = state(), newer = reference({ generation: 2, leaseEpoch: 2 });
  const current = { ...snapshot, browserSessionRefs: [newer], lastBrowserObservation: { ...snapshot.lastBrowserObservation, sessionRef: newer } };
  const staleClose = reduceBrowserReceipt(current, { status: 'ok', content: {}, browserSessionRef: ref, browserSessionClosed: true }, browser, call, digest);
  assert.deepEqual(staleClose.browserSessionRefs, [newer]); assert.equal(staleClose.lastBrowserObservation, undefined);
  const replacement = reduceBrowserReceipt(snapshot, { status: 'ok', content: {}, browserSessionRef: newer }, browser, call, digest);
  assert.deepEqual(replacement.browserSessionRefs, [newer]); assert.equal(replacement.lastBrowserObservation, null);
  const crowded = { ...snapshot, browserSessionRefs: Array.from({ length: 16 }, (_, index) => reference({ runtimeId: `owner-${index}` })) };
  assert.equal(reduceBrowserReceipt(crowded, { status: 'error', content: {}, browserSessionRef: ref }, browser, call, digest).reason, 'browser_reference_limit');
});
test('only a complete successful typed replacement capture pays the exact retired generation debt', () => {
  const { snapshot, ref } = state(), fresh = reference({ generation: 2, leaseEpoch: 2 });
  const waiting = { ...snapshot, browserReobservationRefs: [ref], lastBrowserObservation: null };
  const result = { status: 'ok', content: { ok: true, screenshot_path: 'forged text' }, browserSessionRef: fresh };
  assert.equal(reduceBrowserReceipt(waiting, result, browser, call, digest).browserReobservationRefs, undefined);
  for (const change of [{ screenshot: null }, { complete: false }, { status: 'error' }]) {
    const changed = reduceBrowserReceipt(waiting, { ...result, browserObservation: observation(fresh, change) }, browser, call, digest);
    assert.equal(changed.browserReobservationRefs, undefined); assert.equal(changed.lastBrowserObservation, undefined);
  }
  const changed = reduceBrowserReceipt(waiting, { ...result, browserObservation: observation(fresh) }, browser, call, digest);
  assert.deepEqual(changed.browserReobservationRefs, []); assert.equal(changed.lastBrowserObservation.callId, call.callId);
  assert.equal(changed.lastBrowserObservation.toolCall, snapshot.usage.toolCalls);
  assert.notEqual(changed.lastBrowserObservation.digest, 'sha256:old');
  const stale = reduceBrowserReceipt(waiting, { ...result, browserSessionRef: ref, browserObservation: observation(ref) }, browser, call, digest);
  assert.deepEqual(stale.browserReobservationRefs, [ref]);
  assert.throws(() => reduceBrowserReceipt(waiting, { ...result, browserObservation: observation(ref) }, browser, call, digest),
    { code: 'browser_observation_reference_mismatch' });
});
test('recovery matches every scope, owner, generation and lease; changed identities cannot reconnect', () => {
  const { snapshot, ref } = state();
  assert.throws(() => browserRecoveryTransition(snapshot, []), { code: 'browser_recovery_count_mismatch' });
  for (const field of ['sessionId', 'runtimeId', 'runId', 'workspaceRevision']) {
    assert.throws(() => browserRecoveryTransition(snapshot, [report(reference({ [field]: 'forged' }), 'reconnected')]),
      { code: 'browser_recovery_reference_mismatch' });
  }
  assert.throws(() => browserRecoveryTransition(snapshot, [report(ref, 'restarted', { sessionRef: { ...ref, generation: 2, leaseEpoch: 1 } })]),
    { code: 'browser_recovery_reference_mismatch' });
  const restarted = browserRecoveryTransition(snapshot, [report(ref, 'restarted')]);
  assert.equal(restarted.snapshot.reason, 'browser_session_unavailable'); assert.equal(restarted.snapshot.candidate, null);
  const invalid = state({}, { browserSessionRefs: [reference({ scope: { ...scope, userId: 'foreign' } })] }).snapshot;
  assert.throws(() => browserRecoveryTransition(invalid, [report(invalid.browserSessionRefs[0], 'lost')]), { code: 'persisted_browser_scope_mismatch' });
});
test('resource loss clears candidate, evidence, cached context and verification; final protocols cannot bypass debt', () => {
  for (const contract of [{ objective: 'finish' }, { objective: 'finish', finalSubmissionSchema: { type: 'object' }, finalOutputFormat: 'json_object' }]) {
    const { config, snapshot, ref } = state({ contract });
    const candidate = { candidateId: 'c', text: 'stale', goalRevision: 0, workspaceRevision: null };
    const before = { ...snapshot, candidate, finalText: 'stale', preparedContext: { messages: [], sourceDigest: 'old' }, verification: { status: 'passed' } };
    const batch = browserRecoveryTransition(before, [report(ref, 'lost', { reobserveAvailable: true })]);
    assert.equal(batch.snapshot.candidate, null); assert.equal(batch.snapshot.verification, null); assert.equal(batch.snapshot.preparedContext, null);
    assert.equal(batch.snapshot.finalText, ''); assert.equal(batch.snapshot.lastBrowserObservation, null);
    assert.deepEqual(batch.snapshot.browserReobservationRefs, [ref]);
    assert.equal(batch.events.at(-1).kind, 'browser.reobservation_required');
    const rejected = plan({ ...batch.snapshot, phase: 'verifying', candidate }, config, { context: false, workspace: false, verification: true });
    assert.equal(rejected.events[0].kind, 'browser.candidate_rejected'); assert.equal(rejected.snapshot.candidate, null);
    const originalBinding = sealCandidate(candidate, snapshot, config, digest).binding;
    const newerBinding = sealCandidate(candidate, { ...snapshot, lastBrowserObservation: { ...snapshot.lastBrowserObservation, actionSeq: 2 } }, config, digest).binding;
    assert.notEqual(originalBinding.subjectContextDigest, newerBinding.subjectContextDigest);
  }
});
test('ordinary guidance cannot revive unavailable resources; reconnect reports cannot erase prior observation debt', () => {
  const { snapshot, ref } = state();
  const lost = browserRecoveryTransition(snapshot, [report(ref, 'lost')]).snapshot;
  for (const kind of ['guide', 'steer']) {
    const batch = reduceCommand(lost, { commandId: kind, kind, payload: { text: 'Keep going' } });
    assert.equal(batch.snapshot.reason, 'browser_session_unavailable');
    assert.equal(batch.events[0].payload.reason, 'recovery_required');
  }
  const other = reference({ runtimeId: 'other', sessionId: 'other-page' });
  const before = { ...snapshot, browserSessionRefs: [ref, other], browserReobservationRefs: [ref] };
  const batch = browserRecoveryTransition(before, [report(ref, 'reconnected'), report(other, 'lost', { reobserveAvailable: true })]);
  assert.deepEqual(batch.snapshot.browserReobservationRefs, [ref, other]);
});
for (const backend of ['memory', 'sqlite']) {
  function setup(t, configuration = {}, changes = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'native-browser-recovery-')), filename = join(directory, 'run.sqlite');
    let store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
    const data = state(configuration, changes);
    const initial = { ...data.snapshot, phase: 'created', usage: emptyUsage(), browserSessionRefs: [],
      lastBrowserObservation: null, lastBrowserAttemptToolCall: null };
    store.create(data.config, initial);
    const lease = store.acquire(scope, 'run', 'fixture-seed', 1, 1);
    const batch = transition(initial, data.snapshot, [{ kind: 'fixture.browser_observed', payload: {} }]);
    store.commit(scope, 'run', lease, 1, 0, batch); store.release(scope, 'run', lease);
    data.snapshot = batch.snapshot;
    t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
    return { ...data, get store() { return store; }, reopen() { if (backend === 'sqlite') { store.close(); store = new SqliteRunStore(filename); } return store; } };
  }
  const drive = (store, ports, options = {}) => new NativeKernel({ store, ports, digest, owner: 'replacement', now: () => 100, ...options });
  for (const status of ['reconnected', 'lost', 'restarted', 'unbound', 'probe-error']) test(`${backend}: ${status} is recorded before any restored model`, async t => {
    const host = setup(t); const store = host.reopen(); let requests = 0;
    const ports = { model: { generate: async () => {
      requests++; assert.ok(store.events(scope, 'run').some(event => event.kind === 'browser.recovered')); return final('Fresh final');
    } }, tools: { execute: async () => assert.fail('no tool dispatched') },
    ...(status === 'unbound' ? {} : { browser: { recoverSessions: async request => {
      assert.deepEqual(request.refs, [host.ref]);
      if (status === 'probe-error') throw Error('private driver details');
      return [report(host.ref, status)];
    } } }) };
    const result = await drive(store, ports).runUntilIdle(scope, 'run');
    assert.equal(result.phase, status === 'reconnected' ? 'completed' : 'interrupted');
    assert.equal(requests, Number(status === 'reconnected'));
    assert.equal(store.events(scope, 'run').filter(event => event.kind === 'browser.recovered').length, 1);
    assert.equal(JSON.stringify(store.events(scope, 'run')).includes('private driver details'), false);
  });
  test(`${backend}: a fresh admitted capture clears debt, while a model claim alone cannot`, async t => {
    const host = setup(t, { limits: { maxModelCalls: 4 } }), store = host.reopen(); let models = 0, captures = 0;
    const result = await drive(store, {
      browser: { recoverSessions: async () => [report(host.ref, 'lost', { reobserveAvailable: true })] },
      model: { generate: async () => ++models === 2 ? { ...final(''), kind: 'tool_calls', toolCalls: [call] } : final('Complete after observation') },
      tools: { execute: async () => { captures++; const fresh = reference({ generation: 2, leaseEpoch: 2 });
        return { status: 'ok', content: 'Fresh screenshot', browserSessionRef: fresh, browserObservation: observation(fresh) }; } },
    }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'completed'); assert.equal(models, 3); assert.equal(captures, 1);
    assert.deepEqual(result.browserReobservationRefs, []); assert.equal(result.browserSessionRefs[0].generation, 2);
    assert.equal(result.lastBrowserObservation.toolCall, 2); assert.equal(result.outcome, 'unverified');
    assert.equal(store.events(scope, 'run').filter(event => event.kind === 'browser.candidate_rejected').length, 1);
  });
  for (const claimed of [false, true]) test(`${backend}: ${claimed ? 'claimed' : 'prepared'} old actions cannot be replayed after page loss`, async t => {
    const host = setup(t), oldStore = host.store, lease = oldStore.acquire(scope, 'run', 'lost-worker', 1, 1);
    const batch = prepareEffect(host.snapshot, 'tool', 'executing_tools', { calls: [call], interaction: null }, {
      pendingTools: [call], messages: [...host.snapshot.messages, { role: 'assistant', content: '', toolCalls: [call] }],
    });
    oldStore.commit(scope, 'run', lease, 1, host.snapshot.revision, batch);
    if (claimed) oldStore.claim(scope, 'run', lease, 1, batch.snapshot.pendingIntent);
    const store = host.reopen(); let effects = 0;
    const result = await drive(store, { browser: { recoverSessions: async () => [report(host.ref, 'lost', { reobserveAvailable: true })] },
      model: { generate: async () => { effects++; return final('unsafe'); } }, tools: { execute: async () => { effects++; return { status: 'ok', content: '' }; } },
    }).runUntilIdle(scope, 'run');
    assert.equal(effects, 0); assert.equal(result.phase, 'interrupted');
    assert.equal(result.reason, claimed ? 'effect_outcome_unknown' : 'browser_session_unavailable');
    const receipt = store.load(scope, 'run').receipts.find(receipt => receipt.operationKey === batch.snapshot.pendingIntent);
    assert.equal(receipt.status, claimed ? 'uncertain' : 'not_dispatched');
    assert.equal(result.lastBrowserObservation, null);
  });
  test(`${backend}: cancel interrupts a stalled read-only probe and fences its late report`, async t => {
    const host = setup(t); let complete, entered;
    const started = new Promise(resolve => { entered = resolve; }), controller = new AbortController();
    const worker = drive(host.store, { browser: { recoverSessions: async () => { entered(); return await new Promise(resolve => { complete = resolve; }); } },
      model: { generate: async () => assert.fail('canceled probe cannot dispatch a model') }, tools: { execute: async () => assert.fail() } });
    const running = worker.runUntilIdle(scope, 'run', { signal: controller.signal }); await started;
    controller.abort(); const result = await running; assert.equal(result.phase, 'canceled');
    const before = host.store.load(scope, 'run'); complete([report(host.ref, 'reconnected')]); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(host.store.load(scope, 'run'), before);
  });
  test(`${backend}: probe time is charged before a model can spend the wall budget`, async t => {
    const host = setup(t, { limits: { maxWallMs: 20 } }); let now = 100;
    const result = await drive(host.store, { browser: { recoverSessions: async () => { now += 30; return [report(host.ref, 'reconnected')]; } },
      model: { generate: async () => assert.fail('probe consumed the wall budget') }, tools: { execute: async () => assert.fail() },
    }, { now: () => now }).runUntilIdle(scope, 'run');
    assert.equal(result.reason, 'execution_budget_exhausted'); assert.equal(result.activeElapsedMs, 30);
  });
  test(`${backend}: pending cancellation wins a race with resource reconciliation commit`, async t => {
    const host = setup(t), commit = host.store.commit.bind(host.store); let injected = false;
    host.store.commit = (...args) => {
      if (!injected && args[5].events.some(event => event.kind === 'browser.recovered')) {
        injected = true; host.store.enqueue(scope, 'run', { commandId: 'cancel-probe-commit', kind: 'cancel', payload: {} });
      }
      return commit(...args);
    };
    const result = await drive(host.store, { browser: { recoverSessions: async () => [report(host.ref, 'lost')] },
      model: { generate: async () => assert.fail('cancellation won') }, tools: { execute: async () => assert.fail() },
    }).runUntilIdle(scope, 'run');
    assert.equal(result.phase, 'canceled'); assert.equal(injected, true);
    assert.equal(host.store.events(scope, 'run').some(event => event.kind === 'browser.recovered'), false);
  });
}
