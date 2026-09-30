import test from 'node:test';
import assert from 'node:assert/strict';
import { DshPresetAdmission, dshPresetEligibility, dshPresetId, unsupportedDshBindings } from '../src/agent-preset-admission.mjs';
import { createDshRuntimeAdapter, setDshRuntimeAdapter, streamDshRuntime } from '../src/providers/dsh-runtime.mjs';

function agent(overrides = {}) {
  return {
    id: 'demo/agent',
    name: 'Demo Agent',
    metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 3 },
    spec: { runtime: { type: 'dsh-native' }, bindings: {}, ...overrides.spec },
    ...overrides,
  };
}

test('dsh preset admission uses a stable revision-scoped id', () => {
  assert.equal(dshPresetId('demo/agent', 3), 'agentkit-studio-agent-demo_2Fagent-r3');
  assert.deepEqual(dshPresetEligibility(agent()), {
    ok: true,
    agentId: 'demo/agent',
    revision: 3,
    presetId: 'agentkit-studio-agent-demo_2Fagent-r3',
    runtime: 'dsh-native',
    mode: 'dsh-native',
  });
});

test('resource-bearing and non-DSH revisions use the native DSH runtime bridge', () => {
  const resourceAgent = agent({ spec: { runtime: { type: 'dsh-native' }, bindings: { modelProfileIds: ['model:one'], mcpServers: [{ resourceId: 'mcp:one' }] } } });
  assert.deepEqual(unsupportedDshBindings(resourceAgent), ['model', 'mcp']);
  assert.equal(dshPresetEligibility(resourceAgent).mode, 'studio-bridge');
  assert.equal(dshPresetEligibility(agent({ spec: { runtime: { type: 'codex' }, bindings: {} } })).mode, 'studio-bridge');
});

test('the active DSH model route and official persona row make a real native preset', async () => {
  const registered = [];
  const revision = agent({
    spec: {
      runtime: { type: 'dsh-native' },
      instructions: { system: '只用简洁中文回答。' },
      bindings: { modelProfileIds: ['model:provider:deepseek-v4-flash:live'] },
    },
  });
  const admission = new DshPresetAdmission({
    registry: { async register(definition) { registered.push(definition); return async () => {}; } },
    getAgent: async () => revision,
    getActiveModel: async () => ({ values: { modelName: 'deepseek-v4-flash' } }),
  });
  await admission.ensure('demo/agent');
  assert.equal(registered[0].plugins[0].name, '@deepseek-ai/dsh-persona');
  assert.equal(registered[0].plugins[0].config.prefix, '只用简洁中文回答。');
});

test('the bridge preset declares the Studio provider listener for local Harness and Codex', async () => {
  const registered = [];
  const revision = agent({ metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 1, local: true }, spec: { runtime: { type: 'harness' }, bindings: {} } });
  const admission = new DshPresetAdmission({
    registry: { async register(definition) { registered.push(definition); return async () => {}; } },
    getAgent: async () => revision,
  });
  await admission.ensure('demo/agent');
  assert.equal(registered[0].plugins[0].name, '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin');
  assert.equal(registered[0].plugins[0].config.local, true);
});

test('admission registers once and unregisters replaced revisions', async () => {
  const registered = [];
  const unregistered = [];
  const registry = {
    async register(definition) {
      registered.push(definition);
      return async () => { unregistered.push(definition.id); };
    },
  };
  const revision = { ...agent(), metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 1 } };
  const admission = new DshPresetAdmission({ registry, getAgent: async () => revision });
  const first = await admission.ensure('demo/agent');
  const reused = await admission.ensure('demo/agent');
  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(registered.length, 1);
  revision.metadata.revision = 2;
  const replaced = await admission.ensure('demo/agent');
  assert.equal(replaced.presetId, dshPresetId('demo/agent', 2));
  assert.deepEqual(unregistered, [dshPresetId('demo/agent', 1)]);
  await admission.dispose();
  assert.deepEqual(unregistered, [dshPresetId('demo/agent', 1), dshPresetId('demo/agent', 2)]);
});

test('admission reports missing registry as typed error', async () => {
  const admission = new DshPresetAdmission({ getAgent: async () => agent() });
  await assert.rejects(admission.ensure('demo/agent'), error => error.code === 'DSH_PRESET_REGISTRY_UNAVAILABLE');
});

test('the native bridge keeps the DSH model header while routing the transport by Agent', async () => {
  let received;
  const dispose = setDshRuntimeAdapter({
    async *stream(options) {
      received = options;
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  const original = { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] };
  const chunks = [];
  for await (const chunk of streamDshRuntime(original, { agentId: 'demo/agent', runtime: 'harness', local: true })) chunks.push(chunk);
  assert.equal(received.provider, original.provider);
  assert.equal(received.model, 'local:demo/agent');
  assert.equal(original.model, 'deepseek-v4-flash');
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }]);
  dispose();
});

test('the runtime bridge forwards local text and reasoning deltas as they arrive', async () => {
  const event = item => `data: ${JSON.stringify({ conversationItem: item })}\n\n`;
  const adapter = createDshRuntimeAdapter({
    localHandler: async () => async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(event({ kind: 'assistant_reasoning', lifecycle: 'running', payload: { operation: 'append', text: '先分析' } }));
      await new Promise(resolve => setTimeout(resolve, 15));
      response.write(event({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: '答案' } }));
      response.write(event({ kind: 'runtime', lifecycle: 'completed', payload: {} }));
      response.write(`data: ${JSON.stringify({ runtimeEvent: { event_type: 'run.completed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    },
  });
  const iterator = adapter.stream({ model: 'local:demo/agent', messages: [{ role: 'user', content: 'hi' }] });
  const first = await iterator.next();
  assert.deepEqual(first.value, { type: 'block-start', index: 0, blockType: 'reasoning' });
  const rest = [];
  for await (const chunk of iterator) rest.push(chunk);
  assert.deepEqual(rest, [
    { type: 'reasoning-delta', index: 0, text: '先分析' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先分析' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '答案' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '答案' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('the runtime bridge routes Codex Agents to the Codex provider instead of the gateway', async () => {
  const calls = [];
  const adapter = createDshRuntimeAdapter({
    codexRuntime: {
      async *stream(options) {
        calls.push(options);
        yield { type: 'reasoning', text: '思考' };
        yield { type: 'text', text: '回答' };
      },
    },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'local:codex-agent',
    messages: [{ role: 'user', content: '你好' }],
    studioRuntime: 'codex',
  })) chunks.push(chunk);
  assert.equal(calls[0].input, '你好');
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '思考' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '回答' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '回答' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});
