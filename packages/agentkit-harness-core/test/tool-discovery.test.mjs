import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, toolDiscoveryDefinitions, modelToolCatalog,
  resolveDiscoveredCalls, executeToolDiscovery, validateModelResult, discoveryAfterCleanup } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const controls = toolDiscoveryDefinitions();
const hidden = overrides => tool({ name: 'mcp__files__publish', description: 'Publish a workspace marker', readOnly: false, concurrentSafe: false,
  parameters: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 9007199254740993n } } },
  discovery: { deferred: true, aliases: ['publish'], mcp: { serverName: 'files', toolName: 'publish' } }, ...overrides });
const result = (calls = [], overrides = {}) => ({ kind: calls.length ? 'tool_calls' : 'final_candidate', text: calls.length ? '' : 'Done',
  toolCalls: calls, usage: emptyUsage(), ...overrides });
const search = { callId: 'search', name: 'ToolSearch', arguments: { query: 'select:publish' } };
const invoke = { callId: 'invoke', name: 'DeferredToolCall', arguments: { name: 'mcp__files__publish', input: { id: 9007199254740993n } } };
const configuration = overrides => fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', tools: [...controls, hidden()], ...overrides });

for (const sqlite of [false, true]) test(`${sqlite ? 'sqlite' : 'memory'}: search loads exact definitions, target owns authority, approval and durable identity`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-tool-discovery-'));
  const store = sqlite ? new SqliteRunStore(join(directory, 'run.sqlite')) : new MemoryRunStore();
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = configuration(); let models = 0, effects = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'discovery', ports: {
    model: { generate: async request => {
      assert.equal(request.tools.some(tool => tool.name === hidden().name), false);
      assert.ok(request.tools.find(tool => tool.name === 'ToolSearch').description.includes(hidden().name));
      if (++models === 1) return result([search]);
      if (models === 2) {
        const loaded = JSON.parse(request.messages.at(-1).content);
        assert.deepEqual(loaded.tool_names, [hidden().name]);
        // BigInt is encoded exactly by the Native JSON codec, not rounded to Number.
        assert.match(request.messages.at(-1).content, /9007199254740993/);
        assert.equal(loaded.definitions[0].call, 'DeferredToolCall');
        return result([invoke]);
      }
      return result();
    } }, tools: { execute: async request => {
      assert.equal(request.call.name, hidden().name); assert.equal(request.definition.name, hidden().name);
      assert.equal(request.definition.readOnly, false); assert.equal(request.definition.concurrentSafe, false);
      assert.deepEqual(request.call.arguments, { id: 9007199254740993n });
      if (!request.interaction) return { status: 'approval_required', content: {}, interactionId: 'approval' };
      assert.equal(request.interaction.callId, 'invoke'); effects++;
      return { status: 'ok', content: 'Published' };
    } },
  } });
  kernel.start(snapshot, config);
  const pending = await kernel.runUntilIdle(scope, 'run');
  assert.equal(pending.phase, 'awaiting_interaction'); assert.equal(effects, 0);
  assert.equal(pending.pendingTools[0].name, hidden().name);
  kernel.submit(scope, 'run', { commandId: 'allow', kind: 'submit_interaction', payload: {
    interactionId: pending.pendingInteraction.interactionId, decision: 'allow' } });
  const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.equal(effects, 1);
  assert.deepEqual(done.toolDiscovery, { discovered: [hidden().name], promoted: [] });
  const actual = store.load(scope, 'run').intents.filter(intent => intent.kind === 'tool').flatMap(intent => intent.payload.calls);
  assert.ok(actual.some(call => call.name === hidden().name && call.modelCallWrapper === 'DeferredToolCall'));
  assert.equal(actual.some(call => call.name === 'DeferredToolCall'), false);
  assert.deepEqual(store.load(scope, 'run').configuration, config);
});

test('hidden direct calls are rejected with a bounded retry; unsearched wrappers never reach external tools', async () => {
  for (const wrapped of [false, true]) {
    const { config, snapshot } = configuration({ limits: { maxModelCalls: 4 } }); let executions = 0, models = 0;
    const store = new MemoryRunStore();
    const kernel = new NativeKernel({ store, digest, owner: 'reject', ports: {
      model: { generate: async () => ++models < 4 ? result([wrapped ? invoke : { callId: 'direct', name: hidden().name, arguments: { id: 9007199254740993n } }]) : result() },
      tools: { execute: async () => { executions++; return { status: 'ok', content: '' }; } },
    } });
    kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
    assert.equal(executions, 0); assert.ok(models <= 4); assert.equal(done.toolDiscovery.discovered.length, 0);
    assert.match(done.messages.filter(message => message.role === 'tool')[0].content, wrapped ? /not_loaded_or_not_deferred/ : /not_advertised/);
  }
});

test('full definitions must fit escaped model-view budget before granting discovery', () => {
  const { config, snapshot } = configuration({ limits: { maxToolResultBytes: 1024 }, tools: [...controls,
    hidden({ description: '"'.repeat(2000) })] });
  const output = executeToolDiscovery(snapshot, config, search);
  assert.deepEqual(output.content.tool_names, []); assert.deepEqual(output.content.definitions, []);
  assert.equal(output.content.omitted_count, 1);
  assert.equal(resolveDiscoveredCalls(snapshot, config, [invoke])[0].name, 'DeferredToolCall');
});

test('resolved write failure remains unknown and cannot be blindly replayed', async () => {
  const { config, snapshot } = configuration(); let models = 0, effects = 0;
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'unknown', ports: {
    model: { generate: async () => result([++models === 1 ? search : invoke]) },
    tools: { execute: async () => { effects++; throw Error('Connection lost after write'); } },
  } });
  kernel.start(snapshot, config); const stopped = await kernel.runUntilIdle(scope, 'run');
  assert.equal(effects, 1); assert.equal(stopped.reason, 'effect_outcome_unknown');
  await kernel.runUntilIdle(scope, 'run'); assert.equal(effects, 1);
  const unknown = store.load(scope, 'run').receipts.find(receipt => receipt.result.results?.some(result => result.status === 'uncertain'));
  assert.ok(unknown); assert.equal(unknown.result.results[0].status, 'uncertain');
});

test('resolved target schema rejects invalid nested input before any external callback', async () => {
  const { config, snapshot } = configuration(); let models = 0;
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'schema', ports: {
    model: { generate: async request => {
      if (++models === 1) return result([search]);
      if (models === 2) return result([{ ...invoke, arguments: { name: hidden().name, input: { id: 1 } } }]);
      assert.match(request.messages.at(-1).content, /invalid_arguments/); return result();
    } }, tools: { execute: async () => assert.fail('Target schema must validate first') },
  } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
});

test('read-only deferred targets use the existing parallel scheduler after resolution', async () => {
  const definitions = ['left', 'right'].map(name => hidden({ name, discovery: { deferred: true },
    readOnly: true, concurrentSafe: true, parameters: { type: 'object' } }));
  const { config, snapshot } = configuration({ tools: [...controls, ...definitions] });
  let models = 0, entered = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'parallel', ports: {
    model: { generate: async () => ++models === 1 ? result([{ ...search, arguments: { query: 'select:left,right' } }])
      : models === 2 ? result(definitions.map(tool => ({ callId: tool.name, name: 'DeferredToolCall', arguments: { name: tool.name, input: {} } }))) : result() },
    tools: { execute: async request => {
      assert.equal(request.definition.readOnly, true); assert.equal(request.definition.concurrentSafe, true);
      if (++entered === 2) release(); await both; return { status: 'ok', content: request.call.name };
    } },
  } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(entered, 2);
});

test('discovery cannot widen allowed tools, accept forged wrapper metadata, or reinterpret old configurations', () => {
  const { config, snapshot } = configuration({ contract: { objective: 'Scoped', allowedToolNames: controls.map(tool => tool.name) } });
  assert.deepEqual(executeToolDiscovery(snapshot, config, search).content.tool_names, []);
  assert.throws(() => validateModelResult(result([{ ...invoke, modelCallWrapper: 'DeferredToolCall' }])), /model_must_not_set_call_wrapper/);
  assert.throws(() => configuration({ contract: { objective: 'No search', allowedToolNames: [] } }), /control_binding_invalid/);
  for (const discovery of [null, { deferred: false }, { deferred: true, mcp: null }])
    assert.throws(() => configuration({ tools: [...controls, hidden({ discovery })] }), /invalid_tool_discovery_metadata/);
  const legacy = fixture({ tools: [tool()] });
  assert.equal(Object.hasOwn(legacy.config, 'toolDiscoveryPolicy'), false);
  assert.equal(Object.hasOwn(legacy.snapshot, 'toolDiscovery'), false);
  assert.deepEqual(modelToolCatalog(legacy.snapshot, legacy.config), legacy.config.tools);
});

test('SQLite cold resume preserves discovery; next Session turn promotes only still-allowed tools', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-tool-search-cold-')), filename = join(directory, 'run.sqlite');
  let store = new SqliteRunStore(filename), stopped = false, models = 0, effects = 0;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = configuration();
  let kernel = new NativeKernel({ store, digest, owner: 'first', onCheckpoint: async snapshot => {
    if (!stopped && snapshot.toolDiscovery.discovered.length) {
      stopped = true; kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
    }
  }, ports: { model: { generate: async () => { models++; return result([search]); } }, tools: { execute: async () => assert.fail('Search must be internal') } } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'paused');
  assert.equal(models, 1); store.close(); store = new SqliteRunStore(filename);
  kernel = new NativeKernel({ store, digest, owner: 'second', ports: {
    model: { generate: async () => ++models === 2 ? result([invoke]) : result() },
    tools: { execute: async request => { assert.equal(request.call.name, hidden().name); effects++; return { status: 'ok', content: 'Published' }; } },
  } });
  kernel.attach(scope, 'run'); kernel.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed'); assert.equal(effects, 1);
  const next = kernel.start({ ...snapshot, runId: 'run2', turnId: 'turn2' }, config);
  assert.deepEqual(next.toolDiscovery.promoted, [hidden().name]);
  assert.ok(modelToolCatalog(next, config).some(tool => tool.name === hidden().name));
});

test('context pruning promotes only retired search receipts; compaction promotes all loaded schemas', () => {
  const { snapshot } = configuration(); snapshot.toolDiscovery = { discovered: ['one', 'two'], promoted: [] };
  snapshot.messages.push({ role: 'tool', content: 'schemas', callId: 'retired', discoveredToolNames: ['one'] });
  const pruned = discoveryAfterCleanup(snapshot, { state: { compactions: 0 }, toolResultPruning: { toolCallIds: ['retired'] } });
  assert.deepEqual(pruned.promoted, ['one']);
  assert.deepEqual(discoveryAfterCleanup(snapshot, { state: { compactions: 1 } }).promoted, ['one', 'two']);
});

test('compaction promotes definitions and recounts the actual catalog before the next dispatch', async () => {
  const { config, snapshot } = configuration({ profile: { profileId: 'context', profileVersion: '1', providerFamily: 'fixture',
    compatibilityDigest: 'fixture/v1', contextWindow: 12000, maxOutputTokens: 128 }, contextPolicy: {
    tokenizerId: 'counter', tokenizerDigest: 'count/v1', enabled: true, triggerRatio: .9, targetRatio: .5,
    summaryMaxTokens: 128, maxCompactions: null, maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 1, maxSummaryRetries: 1 } });
  let tasks = 0, summaries = 0; const counts = [];
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'compact', ports: {
    context: { tokens: { tokenizerId: 'counter', tokenizerDigest: 'count/v1', countText: async request => Math.ceil(request.text.length / 4),
      countRequest: async request => { counts.push(request.tools.map(tool => tool.name)); return Math.ceil(JSON.stringify(request.messages).length / 4) + 100; } } },
    model: { generate: async request => {
      if (request.purpose === 'compaction') { summaries++; return result([], { text: 'Search found a publish tool.' }); }
      tasks++;
      if (tasks === 1) return result([search]);
      if (tasks === 2) return result([], { kind: 'context_overflow', text: '' });
      assert.ok(request.tools.some(tool => tool.name === hidden().name));
      assert.ok(counts.at(-1).includes(hidden().name)); return result();
    } }, tools: { execute: async () => assert.fail('No external effect expected') },
  } });
  kernel.start(snapshot, config); const done = await kernel.runUntilIdle(scope, 'run');
  assert.equal(done.phase, 'completed'); assert.ok(summaries > 0); assert.equal(tasks, 3);
  assert.deepEqual(done.toolDiscovery.promoted, [hidden().name]);
});
