import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage, toolDiscoveryDefinitions, modelToolCatalog, advertisedTools,
  executeToolDiscovery, discoveryAfterCleanup } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const hidden = tool({ name: 'mcp__files__publish', description: 'Publish a workspace marker',
  readOnly: false, concurrentSafe: false, discovery: { deferred: true } });
const search = { callId: 'search', name: 'ToolSearch', arguments: { query: 'select:mcp__files__publish' } };
const invoke = { callId: 'write', name: hidden.name, arguments: {} };
const result = (toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate',
  text: toolCalls.length ? '' : 'Completed', toolCalls, usage: emptyUsage() });
const configured = overrides => fixture({ toolDiscoveryPolicy: 'local-tool-search/v1', tools: [...toolDiscoveryDefinitions(), hidden],
  profile: { profileId: 'native-search', profileVersion: '1', providerFamily: 'anthropic-messages',
    compatibilityDigest: 'native-search/v1', providerToolSearchPolicy: 'anthropic-deferred/v1' }, ...overrides });

test('native references keep the complete scoped catalog but do not authorize unsearched calls', async () => {
  const { config, snapshot } = configured(); let models = 0, writes = 0;
  const store = new MemoryRunStore(), kernel = new NativeKernel({ store, digest, owner: 'native-search', ports: {
    model: { generate: async request => {
      assert.ok(request.tools.some(definition => definition.name === hidden.name && definition.discovery?.deferred));
      assert.equal(request.tools.some(definition => definition.name === 'DeferredToolCall'), false);
      if (++models === 1) return result([invoke]);
      if (models === 2) { assert.match(request.messages.at(-1).content, /not_advertised/); return result([search]); }
      if (models === 3) {
        assert.deepEqual(request.messages.at(-1).discoveredToolNames, [hidden.name]);
        assert.equal(request.messages.at(-1).content.includes('parameters'), false);
        return result([{ ...invoke, callId: 'authorized' }]);
      }
      return result();
    } },
    tools: { execute: async request => { assert.equal(request.call.name, hidden.name); writes++; return { status: 'ok', content: 'Published' }; } },
  } });
  kernel.start(snapshot, config);
  assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  assert.equal(writes, 1); assert.equal(models, 4);
});

test('reference receipts fit without serializing large schemas; local mode retains its exact definition budget', () => {
  const definition = { ...hidden, description: '"'.repeat(10000) };
  const { config, snapshot } = configured({ tools: [...toolDiscoveryDefinitions(), definition], limits: { maxToolResultBytes: 1024 } });
  const native = executeToolDiscovery(snapshot, config, search);
  assert.deepEqual(native.content.tool_names, [hidden.name]); assert.deepEqual(native.content.definitions, []);
  const local = executeToolDiscovery(snapshot, { ...config, profile: { ...config.profile, providerToolSearchPolicy: 'local-only/v1' } }, search);
  assert.deepEqual(local.content.tool_names, []); assert.equal(local.content.omitted_count, 1);
  const denied = { ...config, contract: { ...config.contract, allowedToolNames: ['ToolSearch', 'DeferredToolCall'] } };
  assert.deepEqual(executeToolDiscovery(snapshot, denied, search).content.tool_names, []);
});

test('native reference schemas survive exhausted execution budgets without authorizing another tool', () => {
  const { config, snapshot } = configured({ limits: { maxToolCalls: 1 } });
  const exhausted = { ...snapshot, usage: { ...snapshot.usage, toolCalls: 1 } };
  assert.ok(modelToolCatalog(exhausted, config).some(definition => definition.name === hidden.name));
  assert.equal(advertisedTools(exhausted, config).some(definition => definition.name === hidden.name), false);
  const local = { ...config, profile: { ...config.profile, providerToolSearchPolicy: 'local-only/v1' } };
  assert.equal(modelToolCatalog(exhausted, local).some(definition => definition.name === hidden.name), false);
});

test('SQLite cold restore retains native discovery and direct execution authority', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-provider-discovery-')), path = join(directory, 'runs.sqlite');
  let store = new SqliteRunStore(path), stopped = false, effects = 0;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { config, snapshot } = configured();
  let kernel = new NativeKernel({ store, digest, owner: 'first', onCheckpoint: async state => {
    if (!stopped && state.toolDiscovery.discovered.length) {
      stopped = true; kernel.submit(scope, 'run', { commandId: 'pause', kind: 'pause', payload: {} });
    }
  }, ports: { model: { generate: async () => result([search]) }, tools: { execute: async () => assert.fail('Search is internal') } } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'paused');
  store.close(); store = new SqliteRunStore(path); let models = 0;
  kernel = new NativeKernel({ store, digest, owner: 'second', ports: {
    model: { generate: async request => {
      assert.equal(request.profile.providerToolSearchPolicy, 'anthropic-deferred/v1');
      return ++models === 1 ? result([invoke]) : result();
    } }, tools: { execute: async () => { effects++; return { status: 'ok', content: 'Published' }; } },
  } });
  kernel.attach(scope, 'run'); kernel.submit(scope, 'run', { commandId: 'resume', kind: 'resume', payload: {} });
  const completed = await kernel.runUntilIdle(scope, 'run');
  assert.equal(completed.phase, 'completed'); assert.equal(effects, 1);
  assert.deepEqual(store.load(scope, 'run').configuration, config);
  const cleanup = discoveryAfterCleanup(completed, { state: { compactions: 1 } });
  const catalog = modelToolCatalog({ ...completed, toolDiscovery: cleanup }, config);
  assert.equal(catalog.find(definition => definition.name === hidden.name).discovery, undefined);
});

test('native provider mode cannot be admitted for another protocol or without discovery controls', () => {
  const { config } = configured();
  assert.throws(() => configured({ profile: { ...config.profile, providerFamily: 'openai-chat' } }), /provider_tool_search_policy/);
  assert.throws(() => configured({ toolDiscoveryPolicy: undefined, tools: [] }), /provider_tool_search_policy/);
  assert.throws(() => configured({ profile: { ...config.profile, providerToolSearchPolicy: 'unknown' } }), /provider_tool_search_policy/);
  const legacy = fixture();
  assert.equal(Object.hasOwn(legacy.config.profile, 'providerToolSearchPolicy'), false);
});

test('new Native bindings omit removed historical references without rewriting the source receipt or restoring tool authority', async () => {
  const { buildAnthropicRequest } = await import('@kingsoftcloud/agentkit-harness-node/native/model-anthropic');
  const { config, snapshot } = configured();
  const store = new MemoryRunStore(); let models = 0;
  let kernel = new NativeKernel({ store, digest, owner: 'original', ports: {
    model: { generate: async () => ++models === 1 ? result([search]) : result() },
    tools: { execute: async () => assert.fail('No external operation expected') },
  } });
  kernel.start(snapshot, config); assert.equal((await kernel.runUntilIdle(scope, 'run')).phase, 'completed');
  const original = store.load(scope, 'run'), receipt = original.snapshot.messages.find(message => message.discoveredToolNames?.length);
  assert.deepEqual(receipt.discoveredToolNames, [hidden.name]);
  const next = configured({ tools: [...toolDiscoveryDefinitions(), { ...hidden, name: 'other_tool' }] });
  kernel = new NativeKernel({ store, digest, owner: 'updated', ports: {
    model: { generate: async request => {
      const historical = request.messages.find(message => message.discoveredToolNames !== undefined);
      assert.deepEqual(historical.discoveredToolNames, []);
      const body = buildAnthropicRequest({ protocol: 'anthropic-messages', baseUrl: 'https://model.invalid/v1',
        apiKey: 'fixture', model: 'pinned' }, request).body;
      assert.equal(body.includes('"tool_reference"'), false);
      assert.equal(request.tools.some(definition => definition.name === hidden.name), false);
      return result();
    } }, tools: { execute: async () => assert.fail('Removed tool must not execute') },
  } });
  kernel.start({ ...next.snapshot, runId: 'next', turnId: 'next' }, next.config);
  assert.equal((await kernel.runUntilIdle(scope, 'next')).phase, 'completed');
  assert.deepEqual(store.load(scope, 'run').snapshot.messages.find(message => message.discoveredToolNames?.length), receipt);
});
