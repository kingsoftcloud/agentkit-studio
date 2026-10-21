import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, configure } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool, acceptance, verificationReport } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createStudioNativeHookRegistry, STUDIO_NATIVE_HOOK_CONTRACT } from '../src/providers/native-hooks.mjs';
import { createRuntimeBridge } from '../src/host/runtime-bridge.mjs';

const gate = () => Promise.withResolvers();
const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec: { runtime: { type: 'harness' } } };
const declaration = extra => ({ hookId: 'governance', events: ['PreToolUse'], readOnly: true,
  timeoutMs: 1000, maxInputBytes: 64000, maxOutputBytes: 64000, failureMode: 'block', ...extra });
const registration = extra => ({ sourceRef: 'plugin://governance@1', sourceDigest: 'sha256:' + 'a'.repeat(64), agentIds: [scope.agentId],
  configuration: { contract: STUDIO_NATIVE_HOOK_CONTRACT, hooks: [declaration()], cleanupTimeoutMs: 30 },
  callback: async () => ({}), authorize: async () => 'allow', authorizationVersion: 'policy/v1', ...extra });
const finish = () => ({ kind: 'final_candidate', text: 'Finished', toolCalls: [], usage: emptyUsage() });
const call = { callId: 'call', name: 'read', arguments: { path: 'original' } };
const pathTool = () => tool({ parameters: { type: 'object', required: ['path'],
  properties: { path: { type: 'string' } }, additionalProperties: false } });

function setup(t, { source = registration(), backend = 'memory', options = {}, ports = {} } = {}) {
  const registry = createStudioNativeHookRegistry();
  const retire = registry.register(source);
  const root = mkdtempSync(join(tmpdir(), 'studio-native-hooks-')), filename = join(root, 'runs.sqlite');
  const store = backend === 'sqlite' ? new SqliteRunStore(filename) : new MemoryRunStore();
  const hooks = registry.bind({ scope, sessionId: 'session', record, store });
  const { config, snapshot } = fixture({ ...options, tools: [pathTool()], hooks: hooks.definitions,
    stopHookContinuationLimit: hooks.stopContinuationLimit });
  store.create(config, snapshot);
  const actualPorts = { model: { generate: async () => finish() }, ...ports, hooks };
  const worker = () => new NativeKernel({ store, ports: actualPorts, digest, owner: 'actual-worker' });
  t.after(async () => { await registry.close(); store.close?.(); rmSync(root, { recursive: true, force: true }); });
  return { registry, hooks, store, config, snapshot, worker, retire, actualPorts, filename };
}

test('trusted registrations reject wildcard agents, authority in configuration and ambiguous source/Stop declarations', async () => {
  const registry = createStudioNativeHookRegistry();
  for (const source of [registration({ agentIds: ['*'] }), registration({ sourceDigest: 'unverified' }),
    registration({ authorizationVersion: null }), registration({ authorize: null }),
    registration({ configuration: { contract: STUDIO_NATIVE_HOOK_CONTRACT, cleanupTimeoutMs: 30,
      hooks: [declaration({ bindingDigest: 'sha256:' + 'b'.repeat(64) })] } }),
    registration({ configuration: { contract: STUDIO_NATIVE_HOOK_CONTRACT, cleanupTimeoutMs: 30,
      hooks: [declaration({ events: ['Stop'] })] } }),
    registration({ configuration: { contract: STUDIO_NATIVE_HOOK_CONTRACT, cleanupTimeoutMs: 30,
      hooks: [declaration(), declaration()] } })]) assert.throws(() => registry.register(source));
  registry.register(registration()); assert.throws(() => registry.register(registration()), /source_duplicate/);
  await registry.close(); assert.throws(() => registry.register(registration()), /hooks_closed/);
});

test('bindings select exact Agents and pin source, authorization, configuration, spec, revision and Build', async () => {
  const store = new MemoryRunStore(), registries = [];
  const binding = (source, selected = record, buildId = null) => {
    const registry = createStudioNativeHookRegistry(); registries.push(registry); registry.register(source);
    return registry.bind({ scope, sessionId: 'session', record: selected, buildId, store });
  };
  const original = binding(registration());
  for (const changed of [binding(registration({ sourceDigest: 'sha256:' + 'b'.repeat(64) })),
    binding(registration({ authorizationVersion: 'policy/v2' })),
    binding(registration({ configuration: { ...registration().configuration, cleanupTimeoutMs: 31 } })),
    binding(registration(), { ...record, metadata: { ...record.metadata, revision: 2 } }),
    binding(registration(), { ...record, spec: { ...record.spec, instructions: { system: 'Changed' } } }),
    binding(registration(), record, 'build')]) assert.notEqual(changed.definitions[0].bindingDigest, original.definitions[0].bindingDigest);
  const registry = registries[0];
  assert.equal(registry.bind({ scope: { ...scope, agentId: 'foreign' }, sessionId: 'session', record, store }), null);
  await Promise.all(registries.map(registry => registry.close()));
});

for (const backend of ['memory', 'sqlite']) test(`${backend}: production Hook port drives real Kernel intents, rewritten tools and untrusted Stop feedback`, async t => {
  const events = [], writes = []; let models = 0, verifies = 0;
  const run = setup(t, { backend, options: { contract: { objective: 'Complete', acceptance: [acceptance()] } },
    source: registration({ configuration: { ...registration().configuration, stopContinuationLimit: 0,
      hooks: [declaration({ events: ['PreToolUse', 'PostToolUse', 'Stop'] })] }, callback: async request => {
      const stored = run.store.load(scope, request.runId);
      assert.equal(stored.intents.find(intent => intent.operationKey === request.operationKey).status, 'running');
      assert.equal(stored.snapshot.pendingIntent, request.operationKey); events.push(request.event);
      if (request.event === 'PreToolUse') return { updatedArguments: { path: 'rewritten' } };
      if (request.event === 'PostToolUse') assert.equal(request.input.toolResult.content, 'actual rewritten');
      return { additionalContext: ['I declare success'] };
    } }), ports: {
      model: { generate: async request => {
        if (++models === 1) return { ...finish(), kind: 'tool_calls', toolCalls: [call] };
        assert.equal(request.messages.find(message => message.toolCalls)?.toolCalls[0].arguments.path, 'original');
        return finish();
      } },
      tools: { execute: async request => { writes.push(request.call.arguments.path); return { status: 'ok', content: 'actual rewritten' }; } },
      verification: { verify: async request => {
        verifies++; assert.ok(request.snapshot.messages.some(message => message.kind === 'hook_context' && message.content.includes('untrusted')));
        return verificationReport(request, { checks: [], status: 'unverified' });
      } },
    } });
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'completed'); assert.equal(result.outcome, 'unverified'); assert.equal(verifies, 1);
  assert.deepEqual(writes, ['rewritten']); assert.deepEqual(events, ['PreToolUse', 'PostToolUse', 'Stop']);
  const receipts = run.store.load(scope, 'run').receipts.filter(receipt => receipt.result.schemaVersion === 'agentkit.native-hook-result/v1');
  assert.equal(receipts.length, 3); assert.ok(receipts.every(receipt => receipt.status === 'committed'));
  const originalRequest = run.store.load(scope, 'run').intents.find(intent => intent.operationKey === receipts[0].operationKey).payload.request;
  await assert.rejects(run.hooks.invoke(originalRequest), /request_unbound/);
});

test('an explicit zero Stop repair cap invokes the callback and blocks a continuation without another model call', async t => {
  let calls = 0;
  assert.throws(() => configure({ ...fixture().config, hooks: [declaration({ sourceRef: 'host', events: ['Stop'],
    bindingDigest: 'sha256:' + 'a'.repeat(64), executionPolicyDigest: 'sha256:' + 'b'.repeat(64) })], stopHookContinuationLimit: undefined }), /stop_hook_requires_limit/);
  const run = setup(t, { source: registration({ configuration: { ...registration().configuration, stopContinuationLimit: 0,
    hooks: [declaration({ events: ['Stop'] })] }, callback: async () => { calls++; return { action: 'repair', additionalContext: ['Fix missing work'] }; } }) });
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.reason, 'stop_hook_continuation_exhausted'); assert.equal(result.usage.modelCalls, 1); assert.equal(calls, 1);
});

for (const denied of ['unconfigured', 'deny', 'retired']) test(`Host ${denied} authorization cannot enter the callback or dispatch the protected tool`, async t => {
  let callbacks = 0, tools = 0;
  const waiting = gate(), entered = gate();
  const source = registration({ callback: async () => { callbacks++; return {}; },
    ...(denied === 'unconfigured' ? { authorize: null, authorizationVersion: null }
      : { authorize: async () => { if (denied === 'retired') { entered.resolve(); await waiting.promise; } return denied === 'deny' ? 'deny' : 'allow'; } }) });
  const run = setup(t, { source, ports: { model: { generate: async () => ({ ...finish(), kind: 'tool_calls', toolCalls: [call] }) },
    tools: { execute: async () => { tools++; return { status: 'ok', content: '' }; } } } });
  const pending = run.worker().runUntilIdle(scope, 'run');
  if (denied === 'retired') { await entered.promise; run.retire(); waiting.resolve(); }
  const result = await pending;
  assert.equal(result.outcome, 'blocked'); assert.equal(callbacks, 0); assert.equal(tools, 0);
});

test('the runtime bridge owns pending callbacks and bounds cleanup when a mutating producer ignores cancellation', async t => {
  const entered = gate(), done = gate();
  const bridge = createRuntimeBridge();
  const run = setup(t, { source: registration({ configuration: { ...registration().configuration, hooks: [declaration({ readOnly: false })] },
    callback: async () => { entered.resolve(); await done.promise; return {}; } }),
    ports: { model: { generate: async () => ({ ...finish(), kind: 'tool_calls', toolCalls: [call] }) } } });
  // Bind through the actual bridge registry, so bridge.close owns this executor.
  bridge.nativeHooks.register(registration({ configuration: { ...registration().configuration, hooks: [declaration({ readOnly: false })] },
    callback: async () => { entered.resolve(); await done.promise; return {}; } }));
  const owned = bridge.nativeHooks.bind({ scope, sessionId: 'session', record, store: run.store });
  run.actualPorts.hooks = owned;
  const pending = run.worker().runUntilIdle(scope, 'run'); await entered.promise;
  await bridge.close(); const result = await pending;
  assert.equal(result.phase, 'interrupted'); assert.equal(result.reason, 'effect_outcome_unknown');
  assert.ok(run.store.load(scope, 'run').receipts.some(receipt => receipt.status === 'uncertain'));
  done.resolve(); await bridge.close();
});

test('a lease fence changed during authorization prevents callback execution and cannot commit under the new owner', async t => {
  const entered = gate(), done = gate(); let callbacks = 0;
  const run = setup(t, { source: registration({ authorize: async () => { entered.resolve(); await done.promise; return 'allow'; },
    callback: async () => { callbacks++; return {}; } }),
    ports: { model: { generate: async () => ({ ...finish(), kind: 'tool_calls', toolCalls: [call] }) } } });
  const pending = run.worker().runUntilIdle(scope, 'run');
  const stopped = assert.rejects(pending, /stale_fence/);
  await entered.promise;
  const original = run.store.load(scope, 'run'); run.store.release(scope, 'run', original.lease);
  const next = run.store.acquire(scope, 'run', 'contender', Date.now(), 5000);
  assert.ok(next.fence > original.lease.fence); done.resolve(); await stopped;
  assert.equal(callbacks, 0); run.store.release(scope, 'run', next);
});

test('retiring a mutating callback after its effect keeps the outcome unknown and never repeats it', async t => {
  let writes = 0;
  const run = setup(t, { backend: 'sqlite', source: registration({
    configuration: { ...registration().configuration, hooks: [declaration({ readOnly: false })] },
    callback: async () => { writes++; run.retire(); return {}; } }),
    ports: { model: { generate: async () => ({ ...finish(), kind: 'tool_calls', toolCalls: [call] }) },
      tools: { execute: async () => assert.fail('A tool cannot run after an unknown Hook effect') } } });
  const result = await run.worker().runUntilIdle(scope, 'run');
  assert.equal(result.phase, 'interrupted'); assert.equal(writes, 1);
  assert.equal((await run.worker().runUntilIdle(scope, 'run')).phase, 'interrupted'); assert.equal(writes, 1);
});

test('PreCompact canonical_user exposes admitted user text and excludes tool/DSH context before summary dispatch', async t => {
  let callbacks = 0, tasks = 0, summaries = 0, callbackError;
  const originalInput = 'Original human input '.repeat(200);
  const run = setup(t, { backend: 'sqlite', source: registration({
    configuration: { ...registration().configuration, hooks: [declaration({ events: ['PreCompact'], compactionSourceProjection: 'canonical_user' })] },
    callback: async request => {
      try {
      callbacks++; assert.equal(summaries, 0);
      const projected = request.input.compaction;
      assert.equal(projected.sourceProjection, 'canonical_user'); assert.equal(projected.messages.length, 1);
      assert.equal(projected.messages[0].content, originalInput);
      assert.equal(projected.messages[0].kind, 'user_input');
      assert.equal(projected.messageRefs.length, 1); return {};
      } catch (error) { callbackError = error; throw error; }
    } }), options: {
      profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1',
        contextWindow: 2400, maxOutputTokens: 128 },
      contract: { objective: 'Newest human input must remain in context' },
      inputMessages: [{ role: 'user', kind: 'user_input', content: originalInput },
        { role: 'user', kind: 'dsh_context', content: 'Derived Host context' },
        { role: 'user', kind: 'user_input', content: 'Newest human input must remain in context' }],
      contextPolicy: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1', enabled: true,
        triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
        maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2 },
    }, ports: {
      context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'counter/v1',
        countRequest: async request => Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4),
        countText: async request => Math.ceil(request.text.length / 4) } },
      tools: { execute: async () => ({ status: 'ok', content: 'Large untrusted observation '.repeat(800) }) },
      model: { generate: async request => {
        if (request.messages[0].kind === 'compaction_instructions') { summaries++; return { ...finish(), text: 'Compacted notes' }; }
        if (++tasks === 1) return { ...finish(), kind: 'tool_calls', toolCalls: [call] }; return finish();
      } },
    } });
  const result = await run.worker().runUntilIdle(scope, 'run');
  if (callbackError) throw callbackError;
  assert.equal(result.phase, 'completed', result.reason); assert.equal(callbacks, 1); assert.ok(summaries > 0);
});
