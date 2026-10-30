import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundResourceToolExecutor } from '../src/host/services/resource-tools.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { createMcpLoopbackService } from './fixtures/mcp-loopback-service.mjs';
import { Context } from '@deepseek-ai/cordis';
import { mountRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';

const binding = { resourceId: 'crm', endpointUrl: 'https://crm.example.test/mcp', transport: 'http', envRefs: { Authorization: 'MCP_CRM_TOKEN' } };
const record = refs => ({ spec: { bindings: { mcpServers: refs } } });

test('native bridge retains the authoritative direct descriptor and ignores caller-supplied endpoint data', async () => {
  let actual;
  const execute = createBoundResourceToolExecutor({ agents: { get: async id => id === 'agent' ? record([binding]) : null },
    resources: { callMcpTool: async (...args) => { actual = args; return 'result'; } } });
  assert.equal(await execute({ agentId: 'agent', resourceId: 'crm', name: 'probe', arguments: { q: 1 }, endpointUrl: 'https://forged.example.test', credentialRef: 'platform-key' }), 'result');
  assert.deepEqual(actual.slice(0, 3), [binding, 'probe', { q: 1 }]);
});

test('native bridge refuses unbound IDs, unknown Agents and ambiguous aliases before a resource request', async () => {
  let calls = 0;
  const execute = createBoundResourceToolExecutor({ agents: { get: async id => id === 'missing' ? null : record(id === 'duplicate' ? [binding, binding] : [binding]) },
    resources: { callMcpTool: async () => { calls++; } } });
  await assert.rejects(execute({ agentId: 'agent', resourceId: 'other', name: 'probe' }), { code: 'MCP_RESOURCE_NOT_BOUND' });
  await assert.rejects(execute({ agentId: 'missing', resourceId: 'crm', name: 'probe' }), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(execute({ agentId: 'duplicate', resourceId: 'crm', name: 'probe' }), { code: 'MCP_BINDING_AMBIGUOUS' });
  assert.equal(calls, 0);
});

test('frozen resource selection preserves the Native result codec and dispatch authority guard', async () => {
  let dispatched = 0;
  const signal = new AbortController().signal;
  const stale = Object.assign(new Error('retired Native request'), { code: 'studio_native_tool_authority_stale' });
  const assertCurrent = () => { throw stale; };
  const execute = createBoundResourceToolExecutor({
    agents: { getRevision: async () => record([binding]) },
    resources: { callMcpTool: async (ref, name, args, options) => {
      assert.deepEqual([ref, name, args], [binding, 'probe', { q: 1 }]);
      assert.equal(options.signal, signal);
      assert.equal(options.resultFormat, 'mcp-result/v1');
      assert.equal(options.assertCurrent, assertCurrent);
      options.assertCurrent();
      dispatched++;
    } },
  });
  await assert.rejects(execute({ agentId: 'agent', agentRevision: 7, resourceId: 'crm',
    name: 'probe', arguments: { q: 1 }, signal, resultFormat: 'mcp-result/v1', assertCurrent }),
  { code: 'studio_native_tool_authority_stale' });
  assert.equal(dispatched, 0);
});

for (const mode of ['revision', 'build']) test(`native bridge uses the preset's frozen ${mode} rather than the latest Agent binding`, async () => {
  let actual;
  const frozen = { ...binding, endpointUrl: 'https://frozen.example.test/mcp' };
  const execute = createBoundResourceToolExecutor({ agents: {
    get: async () => { throw new Error('must not load latest Agent'); },
    getRevision: async (id, revision) => { assert.deepEqual([id, revision], ['agent', 7]); return record([frozen]); },
  }, builds: { build: { resolve: async (id, build) => { assert.deepEqual([id, build], ['agent', 'frozen-build']); return record([frozen]); } } },
  resources: { callMcpTool: async ref => { actual = ref; } } });
  await execute({ agentId: 'agent', resourceId: 'crm', name: 'probe', ...(mode === 'revision' ? { agentRevision: 7 } : { buildId: 'frozen-build' }) });
  assert.deepEqual(actual, frozen);
});

for (const transport of ['http', 'sse']) test(`native bridge executes real ${transport} from the stored direct binding without GetMCP`, async t => {
  const server = await createMcpLoopbackService({ transport, getCredential: () => 'synthetic-bridge-token' });
  const adapters = createLocalResourceAdapters({ credentials: { resolve: async () => ({ value: 'synthetic-bridge-token' }) },
    serverClient: { action: async () => { throw new Error('Direct bridge must retain descriptor'); } } });
  t.after(async () => { await adapters.close(); await server.close(); });
  const ref = { resourceId: 'direct', endpointUrl: server.endpoint, transport, envRefs: { Authorization: 'MCP_BRIDGE_TOKEN' } };
  const execute = createBoundResourceToolExecutor({ agents: { get: async () => record([ref]) }, resources: adapters });
  assert.equal((await execute({ agentId: 'agent', resourceId: 'direct', name: server.toolName }))[0].text, server.receipt);
  assert.equal(server.counts.called, 1);
});

test('platform MCP ID-only binding keeps the existing adapter lookup path', async () => {
  let ref;
  const execute = createBoundResourceToolExecutor({ agents: { get: async () => record(['platform-mcp']) }, resources: { callMcpTool: async value => { ref = value; } } });
  await execute({ agentId: 'agent', resourceId: 'platform-mcp', name: 'probe' });
  assert.equal(ref, 'platform-mcp');
});

for (const mode of ['revision', 'build']) test(`registered native MCP tool carries its preset ${mode} through the real Host bridge`, async () => {
  const ctx = new Context(), bridge = mountRuntimeBridge(ctx), registered = [];
  let actual;
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {}; }, schemas: () => [] });
  ctx.provide('skills', {});
  const execute = createBoundResourceToolExecutor({ agents: {
    get: async () => { throw new Error('must use frozen selector from preset'); },
    getRevision: async (id, revision) => { assert.deepEqual([id, revision], ['agent', 7]); return record([binding]); },
  }, builds: { build: { resolve: async (id, build) => { assert.deepEqual([id, build], ['agent', 'frozen-build']); return record([binding]); } } },
  resources: { callMcpTool: async ref => { actual = ref; return 'tool-result'; } } });
  bridge.setResourceToolExecutor(execute);
  try {
    await ctx.plugin({ inject: ['tools', 'skills', 'studioRuntimeBridge'], apply(child) {
      applyPreset(child, { agentId: 'agent', runtime: 'harness', local: true,
        ...(mode === 'revision' ? { agentRevision: 7 } : { buildId: 'frozen-build' }),
        toolContracts: [{ executor: 'mcp', mcpResourceId: 'crm', name: 'probe', parameters: { type: 'object', properties: {} } }],
      });
    } });
    assert.equal(registered.length, 1);
    assert.deepEqual(await registered[0].execute({}, { callId: 'native-call' }), { result: 'tool-result' });
    assert.deepEqual(actual, binding);
  } finally { await ctx.fiber.dispose(); }
});
