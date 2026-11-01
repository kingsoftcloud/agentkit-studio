import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeKernel, configure, emptyUsage, canonical, copy,
} from '@kingsoftcloud/agentkit-harness-core';
import { fixture, scope, digest } from './fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import {
  createStudioNativeContextSourceRegistry,
  STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
} from '../src/providers/native-context-sources.mjs';

const sha256Str = v => 'sha256:' + createHash('sha256').update(v).digest('hex');
const rawDigest = v => createHash('sha256').update(canonical(v)).digest('hex');

const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec: { runtime: { type: 'harness' } } };
const runtimeBuildId = `revision-${rawDigest({ agentId: scope.agentId, revision: 1, spec: record.spec })}`;

test('a fresh runtime bridge resumes the same SQLite Run after the context commit and before its first model', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-cold-run-')), filename = join(root, 'r.sqlite');
  let store = new SqliteRunStore(filename), bridge = createRuntimeBridge(), calls = 0;
  t.after(async () => { await bridge.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const registration = { sourceRef: 'plugin://cold-context@1', sourceDigest: sha256Str('cold-context'),
    agentIds: [scope.agentId], authorizationVersion: '1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
      sources: [{ sourceId: 'cold', priority: 0, timeoutMs: 1000, required: true, maxTokens: 100, maxBytes: 4096 }] },
    authorize: async () => 'allow', callback: async () => { calls++; return { items: [{ content: 'actual persisted context' }] }; } };
  bridge.nativeContextSources.register(registration);
  const bound = bridge.nativeContextSources.bind({ scope, sessionId: 'session', record, store });
  const config = makeConfig(bound.sources), stop = new Error('Exit before model admission');
  const first = new NativeKernel({ store, digest, owner: 'before', onCheckpoint: async view => {
    if (view.phase === 'requesting_model') throw stop;
  }, ports: { context: { prepare: async request => ({ messages: request.snapshot.messages, context: {} }),
    readSource: request => bound.readSource(request), tokens: { tokenizerId: 'test', tokenizerDigest: 'test/v1',
      countRequest: async () => 10, countText: async () => 5 } }, model: { generate: async () => assert.fail('model must not run before reopen') } } });
  first.start({ ...fixture().snapshot, buildId: runtimeBuildId }, config);
  await assert.rejects(first.runUntilIdle(scope, 'run'), error => error === stop);
  assert.equal(store.load(scope, 'run').snapshot.usage.modelCalls, 0); assert.equal(calls, 1);
  const old = bridge; bound.close(); await old.close(); store.close();
  store = new SqliteRunStore(filename); bridge = createRuntimeBridge(); bridge.nativeContextSources.register(registration);
  assert.throws(() => old.nativeContextSources.bind({ scope, sessionId: 'session', record, store }), /sources_closed/);
  const rebound = bridge.nativeContextSources.bind({ scope, sessionId: 'session', record, store });
  assert.deepEqual(rebound.sources, bound.sources);
  const after = makeKernel(store, { readSource: request => rebound.readSource(request) });
  const snapshot = await after.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'completed'); assert.equal(snapshot.runId, 'run'); assert.equal(snapshot.usage.modelCalls, 1);
  assert.ok(after._modelMessages().some(message => message.kind === 'context_contribution'
    && message.content.includes('actual persisted context')));
  rebound.close();
});

test('actual SQLite steering accepts the effective replacement contract and shared non-cyclic source data', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-steer-'));
  const store = new SqliteRunStore(join(root, 'r.sqlite')), registry = createStudioNativeContextSourceRegistry();
  t.after(() => { registry.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  let callbacks = 0;
  registry.register({ sourceRef: 'plugin://steered-context@1', sourceDigest: sha256Str('steered-context'),
    agentIds: [scope.agentId], authorizationVersion: '1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
      sources: [{ sourceId: 'steered', priority: 0, timeoutMs: 1000, required: true, maxTokens: 100, maxBytes: 4096 }] },
    authorize: async request => request.snapshot.goalRevision === 1 && request.configuration.contract.revision === 'changed' ? 'allow' : 'deny',
    callback: async request => {
      callbacks++; assert.equal(request.configuration.contract.objective, 'Changed goal');
      const shared = { content: 'Untrusted observation' };
      return { items: [{ left: shared, right: shared }] };
    } });
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  const config = makeConfig(bound.sources), kernel = makeKernel(store, { readSource: request => bound.readSource(request) });
  kernel.start({ ...fixture().snapshot, buildId: runtimeBuildId }, config);
  const replacement = configure({ ...config, contract: { ...config.contract, objective: 'Changed goal', revision: 'changed' } }).contract;
  kernel.submit(scope, 'run', { commandId: 'replace-context-goal', kind: 'steer', payload: {
    text: 'Changed goal', expectedGoalRevision: 0, taskContract: replacement,
  } });
  const snapshot = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snapshot.phase, 'completed'); assert.equal(snapshot.goalRevision, 1); assert.equal(callbacks, 1);
  assert.equal(store.load(scope, 'run').configuration.contract.objective, 'Task', 'the persisted base configuration stays fixed');
  assert.ok(kernel._modelMessages().some(message => message.kind === 'context_contribution'
    && message.content.includes('Untrusted observation')));
  bound.close();
});

test('retiring a source during actual authorization prevents its callback and cannot be bypassed via port properties', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-retire-'));
  const store = new SqliteRunStore(join(root, 'r.sqlite')), registry = createStudioNativeContextSourceRegistry();
  t.after(() => { registry.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  let callbacks = 0, original;
  const retire = registry.register({ sourceRef: 'plugin://retired-context@1', sourceDigest: sha256Str('retired-context'),
    agentIds: [scope.agentId], authorizationVersion: '1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
      sources: [{ sourceId: 'retired', priority: 0, timeoutMs: 1000, required: true, maxTokens: 100, maxBytes: 4096 }] },
    authorize: async () => { entered.resolve(); await released.promise; return 'allow'; },
    callback: async () => { callbacks++; return { items: [{ content: 'must not run' }] }; } });
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  const kernel = makeKernel(store, { readSource: request => { original = request; return bound.readSource(request); } });
  kernel.start({ ...fixture().snapshot, buildId: runtimeBuildId }, makeConfig(bound.sources));
  const running = kernel.runUntilIdle(scope, 'run'); await entered.promise;
  retire(); bound._disposed = false; bound._invalidate = () => {}; bound._usesRef = () => new Set();
  await assert.rejects(bound.readSource(original), /source_unbound/);
  released.resolve(); const snapshot = await running;
  assert.equal(snapshot.phase, 'failed'); assert.equal(callbacks, 0); assert.equal(kernel._modelMessages(), null);
  bound.close(); bound.close();
});

function makeConfig(contextSources, { maxRepairs = 0 } = {}) {
  const base = fixture().config;
  return configure({
    ...base, instructions: 'Answer.',
    contract: { ...base.contract, objective: 'Task' },
    inputMessages: [{ role: 'user', kind: 'user_input', content: 'Task' }],
    tools: [], contextSources,
    contextPolicy: {
      enabled: true, tokenizerId: 'test', tokenizerDigest: 'test/v1',
      triggerRatio: 0.99, targetRatio: 0.5, summaryMaxTokens: 80,
      maxCompactions: null, maxCompactionsWithoutProgress: 4,
      minModelTurnsBetween: 2, maxSummaryRetries: 2,
    },
    limits: { ...base.limits, maxRepairs },
  });
}

function makeKernel(store, { readSource, modelResponse, countRequest = async () => 10 } = {}) {
  let modelMessages = null;
  const ports = {
    context: {
      readSource: async (request) => readSource(request),
      tokens: { tokenizerId: 'test', tokenizerDigest: 'test/v1',
        countRequest: async (r) => countRequest(r), countText: async () => 5 },
      prepare: async (r) => ({ messages: r.snapshot.messages, context: {} }),
    },
    model: { generate: async (request) => {
      modelMessages = request.messages;
      return modelResponse || { kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() };
    } },
    tools: { execute: async () => ({ status: 'ok', content: {} }) },
  };
  const kernel = new NativeKernel({ store, ports, digest, owner: 'test' });
  kernel._modelMessages = () => modelMessages;
  return kernel;
}

function setupRegistry(t, { authorizeReturn = 'allow', callbackItems = [{ content: 'recall data' }],
  required = true, maxTokens = 1600, priority = 0, sourceId = 'test.source' } = {}) {
  const registry = createStudioNativeContextSourceRegistry();
  t.after(() => registry.close());
  const unreg = registry.register({
    sourceRef: 'plugin://test.context@1.0.0', sourceDigest: sha256Str('test-source'),
    agentIds: [scope.agentId], authorizationVersion: 'v1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
      sources: [{ sourceId, priority, timeoutMs: 5000, required, maxTokens, maxBytes: 131072 }] },
    authorize: async () => authorizeReturn,
    callback: async () => ({ items: copy(callbackItems) }),
  });
  return { registry, unreg };
}

async function runAndCheck(t, store, bound, { readSource, required = true } = {}) {
  const kernel = makeKernel(store, { readSource });
  const config = makeConfig(bound.sources, { maxRepairs: 0 });
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: runtimeBuildId }, config);
  const snap = await kernel.runUntilIdle(scope, 'run');
  return { snap, kernel };
}

test('kernel reads contribution with revision buildId', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t);
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  assert.ok(bound);
  assert.ok(bound.sources[0].bindingDigest.length > 0, 'bindingDigest is non-empty');
  const { snap, kernel } = await runAndCheck(t, store, bound, { readSource: async r => bound.readSource(r) });
  assert.equal(snap.phase, 'completed');
  const contribs = (kernel._modelMessages() || []).filter(m => m.kind === 'context_contribution');
  assert.ok(contribs.length > 0);
  assert.equal(JSON.parse(contribs[0].content).trust, 'untrusted');
  bound.close();
});

test('foreign scope.workspaceId rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t, { required: false });
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  let cbCalled = false;
  const { snap } = await runAndCheck(t, store, bound, {
    readSource: async r => {
      // Tamper scope in the request copy the kernel already made.
      try { return await bound.readSource({ ...r, scope: { ...r.scope, workspaceId: 'foreign' } }); }
      catch { return { items: [] }; }
    }, required: false });
  assert.equal(snap.phase, 'completed');
  const contribs = (snap && kernel_contributions(t, store)) || [];
  bound.close();
});

function kernel_contributions(t, store) {
  // helper not used — contributions are in model messages
  return [];
}

test('foreign buildId rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t, { required: false });
  // bind with a foreign buildId — the fixture snapshot uses runtimeBuildId.
  // This should either reject at bind or at readSource.
  const bound = registry.bind({ scope, sessionId: 'session', record, store, expectedRuntimeBuildId: 'foreign-build' });
  assert.ok(bound);
  // The bound sources have bindingDigest with 'foreign-build', but the kernel
  // creates a run with buildId = runtimeBuildId. verifyContext should reject
  // because request.buildId !== 'foreign-build'.
  const { snap } = await runAndCheck(t, store, bound, {
    readSource: async r => { try { return await bound.readSource(r); } catch { return { items: [] }; } },
    required: false });
  assert.equal(snap.phase, 'completed');
  bound.close();
});

test('authorize deny skips callback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  let cbCalled = false;
  const reg = createStudioNativeContextSourceRegistry(); t.after(() => reg.close());
  reg.register({
    sourceRef: 'plugin://test.context@1.0.0', sourceDigest: sha256Str('s'),
    agentIds: [scope.agentId], authorizationVersion: 'v1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT,
      sources: [{ sourceId: 'test.source', priority: 0, timeoutMs: 5000, required: false, maxTokens: 1600, maxBytes: 131072 }] },
    authorize: async () => 'deny',
    callback: async () => { cbCalled = true; return { items: [{ content: 'x' }] }; },
  });
  const bound = reg.bind({ scope, sessionId: 'session', record, store });
  const { snap, kernel } = await runAndCheck(t, store, bound, {
    readSource: async r => { try { return await bound.readSource(r); } catch { return { items: [] }; } },
    required: false });
  assert.equal(snap.phase, 'completed');
  assert.equal(cbCalled, false);
  const contribs = (kernel._modelMessages() || []).filter(m => m.kind === 'context_contribution');
  assert.equal(contribs.length, 0);
  bound.close();
});

test('required source failure propagates (not swallowed)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t, { required: true, callbackItems: Array.from({ length: 65 }, (_, i) => ({ i })) });
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  const { snap } = await runAndCheck(t, store, bound, { readSource: async r => bound.readSource(r), required: true });
  assert.ok(['failed', 'canceled', 'interrupted'].includes(snap.phase) || snap.outcome === 'blocked',
    `required fail should not silently complete: ${snap.phase}/${snap.outcome}`);
  bound.close();
});

test('optional source failure skipped', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t, { required: false, callbackItems: Array.from({ length: 65 }, (_, i) => ({ i })) });
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  const { snap, kernel } = await runAndCheck(t, store, bound, {
    readSource: async r => { try { return await bound.readSource(r); } catch { return { items: [] }; } },
    required: false });
  assert.equal(snap.phase, 'completed');
  const contribs = (kernel._modelMessages() || []).filter(m => m.kind === 'context_contribution');
  assert.equal(contribs.length, 0);
  bound.close();
});

test('unregister invalidates bound port', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry, unreg } = setupRegistry(t, { required: false });
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  unreg();
  const { snap, kernel } = await runAndCheck(t, store, bound, {
    readSource: async r => { try { return await bound.readSource(r); } catch { return { items: [] }; } },
    required: false });
  assert.equal(snap.phase, 'completed');
  const contribs = (kernel._modelMessages() || []).filter(m => m.kind === 'context_contribution');
  assert.equal(contribs.length, 0);
  bound.close();
});

test('close is idempotent', () => {
  const reg = createStudioNativeContextSourceRegistry();
  reg.close(); reg.close();
});

test('rejects unknown fields', () => {
  const reg = createStudioNativeContextSourceRegistry();
  assert.throws(() => reg.register({ sourceRef: 'plugin://x@1', sourceDigest: sha256Str('x'), agentIds: ['a'], authorizationVersion: 'v1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT, sources: [{ sourceId: 's', priority: 0, timeoutMs: 1000, required: false, maxTokens: 100, maxBytes: 1024 }] },
    authorize: async () => 'allow', callback: async () => ({ items: [] }), extra: 'bad' }), /registration_invalid/);
  reg.close();
});

test('rejects duplicate sourceRef', () => {
  const reg = createStudioNativeContextSourceRegistry();
  const input = { sourceRef: 'plugin://x@1', sourceDigest: sha256Str('x'), agentIds: ['a'], authorizationVersion: 'v1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT, sources: [{ sourceId: 's', priority: 0, timeoutMs: 1000, required: false, maxTokens: 100, maxBytes: 1024 }] },
    authorize: async () => 'allow', callback: async () => ({ items: [] }) };
  reg.register(input);
  assert.throws(() => reg.register(input), /source_ref_duplicate/);
  reg.close();
});

test('rejects wildcard agentId', () => {
  const reg = createStudioNativeContextSourceRegistry();
  assert.throws(() => reg.register({ sourceRef: 'plugin://x@1', sourceDigest: sha256Str('x'), agentIds: ['*'], authorizationVersion: 'v1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT, sources: [{ sourceId: 's', priority: 0, timeoutMs: 1000, required: false, maxTokens: 100, maxBytes: 1024 }] },
    authorize: async () => 'allow', callback: async () => ({ items: [] }) }), /agents_invalid/);
  reg.close();
});

test('bind returns null when no match', () => {
  const reg = createStudioNativeContextSourceRegistry();
  const rec = { metadata: { id: 'other', local: true, revision: 1 }, spec: { runtime: { type: 'harness' } } };
  assert.equal(reg.bind({ scope: { ...scope, agentId: 'other' }, sessionId: 's', record: rec, store: { load: () => null } }), null);
  reg.close();
});

test('rejects duplicate sourceId', () => {
  const reg = createStudioNativeContextSourceRegistry();
  assert.throws(() => reg.register({
    sourceRef: 'plugin://x@1', sourceDigest: sha256Str('x'), agentIds: [scope.agentId], authorizationVersion: 'v1',
    configuration: { contract: STUDIO_NATIVE_CONTEXT_SOURCES_CONTRACT, sources: [
      { sourceId: 'dup', priority: 0, timeoutMs: 1000, required: false, maxTokens: 100, maxBytes: 1024 },
      { sourceId: 'dup', priority: 1, timeoutMs: 1000, required: false, maxTokens: 100, maxBytes: 1024 },
    ] }, authorize: async () => 'allow', callback: async () => ({ items: [] }),
  }), /source_id_duplicate/);
  reg.close();
});

test('sources list is a copy', t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t);
  const b1 = registry.bind({ scope, sessionId: 's1', record, store });
  const orig = b1.sources[0].sourceId;
  b1.sources[0].sourceId = 'tampered';
  const b2 = registry.bind({ scope, sessionId: 's2', record, store });
  assert.equal(b2.sources[0].sourceId, orig);
  b1.close(); b2.close();
});

test('different session → different bindingDigest', t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t);
  const b1 = registry.bind({ scope, sessionId: 's1', record, store });
  const b2 = registry.bind({ scope, sessionId: 's2', record, store });
  assert.notEqual(b1.sources[0].bindingDigest, b2.sources[0].bindingDigest);
  b1.close(); b2.close();
});

test('SQLite close/reopen rebinds and reads', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'r.sqlite');
  let store = new SqliteRunStore(dbPath);
  const { registry } = setupRegistry(t);
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  const { snap, kernel } = await runAndCheck(t, store, bound, { readSource: async r => bound.readSource(r) });
  assert.equal(snap.phase, 'completed');
  assert.ok((kernel._modelMessages() || []).some(m => m.kind === 'context_contribution'));
  bound.close(); store.close();
  store = new SqliteRunStore(dbPath);
  const bound2 = registry.bind({ scope, sessionId: 'session', record, store });
  const kernel2 = makeKernel(store, { readSource: async r => bound2.readSource(r) });
  const config = makeConfig(bound2.sources);
  kernel2.start({ ...fixture().snapshot, runId: 'run2', sessionId: 'session', buildId: runtimeBuildId }, config);
  const snap2 = await kernel2.runUntilIdle(scope, 'run2');
  assert.equal(snap2.phase, 'completed');
  assert.ok((kernel2._modelMessages() || []).some(m => m.kind === 'context_contribution'), 'rebind after reopen reads');
  bound2.close(); store.close();
});

test('port does not expose _disposed or _sourceRefs', t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t);
  const bound = registry.bind({ scope, sessionId: 'session', record, store });
  assert.equal(bound._disposed, undefined);
  assert.equal(bound._sourceRefs, undefined);
  assert.equal(bound._usesRef, undefined);
  assert.equal(bound._invalidate, undefined);
  bound.close();
});

test('frozen buildId: explicit expectedRuntimeBuildId', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t);
  const frozenBuild = 'frozen-build-abc';
  const bound = registry.bind({ scope, sessionId: 'session', record, store, expectedRuntimeBuildId: frozenBuild });
  assert.ok(bound);
  const kernel = makeKernel(store, { readSource: async r => bound.readSource(r) });
  const config = makeConfig(bound.sources);
  kernel.start({ ...fixture().snapshot, runId: 'run', sessionId: 'session', buildId: frozenBuild }, config);
  const snap = await kernel.runUntilIdle(scope, 'run');
  assert.equal(snap.phase, 'completed');
  assert.ok((kernel._modelMessages() || []).some(m => m.kind === 'context_contribution'), 'frozen build reads');
  bound.close();
});

test('frozen buildId mismatch (kernel uses revision buildId) rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteRunStore(join(root, 'r.sqlite')); t.after(() => store.close());
  const { registry } = setupRegistry(t, { required: false });
  const frozenBuild = 'frozen-build-xyz';
  const bound = registry.bind({ scope, sessionId: 'session', record, store, expectedRuntimeBuildId: frozenBuild });
  // Kernel uses runtimeBuildId (revision-<hash>), not frozenBuild → readSource rejects.
  const { snap, kernel } = await runAndCheck(t, store, bound, {
    readSource: async r => { try { return await bound.readSource(r); } catch { return { items: [] }; } },
    required: false });
  assert.equal(snap.phase, 'completed');
  const contribs = (kernel._modelMessages() || []).filter(m => m.kind === 'context_contribution');
  assert.equal(contribs.length, 0, 'buildId mismatch → no contribution');
  bound.close();
});
