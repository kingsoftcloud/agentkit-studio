import test from 'node:test';
import assert from 'node:assert/strict';
import { DshPresetAdmission, dshModelSelection, dshPresetEligibility, dshPresetId, unsupportedDshBindings } from '../src/agent-preset-admission.mjs';
import { createDshRuntimeAdapter, setDshResourceToolExecutor, setDshRuntimeAdapter, streamDshRuntime, routeDshRuntime, unbindDshAgentRoutes } from '../src/providers/dsh-runtime.mjs';
import { apply as applyDshRuntimePlugin } from '../src/providers/dsh-runtime-plugin.mjs';

function agent(overrides = {}) {
  return {
    id: 'demo/agent',
    name: 'Demo Agent',
    metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 3 },
    spec: { runtime: { type: 'dsh-native' }, bindings: {}, ...overrides.spec },
    ...overrides,
  };
}

test('pinned A2A specs reach only the local whole-turn Native preset without sharing mutable Agent objects', async () => {
  const specs = [{ local_name: 'remote', binding_id: 'binding', space_id: 'space', target_agent_id: 'remote-id', expected_version_id: 'version' }];
  for (const runtime of ['harness', 'codex', 'dsh-native']) {
    let registered;
    const record = agent({ spec: { runtime: { type: runtime }, bindings: { a2a: specs } } });
    const admission = new DshPresetAdmission({ nativeEngineContract: 'agentkit.native-dsh-turn/v1',
      getAgent: async () => record, registry: { register: async value => { registered = value; } } });
    await admission.ensure('demo/agent');
    const config = registered.plugins.find(row => row.name.endsWith('/dsh-runtime-plugin'))?.config;
    if (runtime === 'harness') {
      assert.deepEqual(config.a2aBindings, specs); assert.notEqual(config.a2aBindings, specs);
    } else assert.equal(config?.a2aBindings, undefined);
  }
});

test('Skill-bound presets reuse DSH loader and shell and register definitions in their scope', async () => {
  let definition;
  const skill = { name: 'demo-skill', description: 'Check JSON', content: 'Run the script', source: 'custom', resourceBase: { kind: 'directory', path: '/tmp/test-skill' } };
  const admission = new DshPresetAdmission({ registry: { register: async value => { definition = value; } }, getAgent: async () => agent({ spec: { runtime: { type: 'harness' }, bindings: { skills: ['demo'] } } }), getSkillDefinitions: async () => [skill] });
  await admission.ensure('demo/agent');
  assert.ok(definition.plugins.some(item => item.name === '@deepseek-ai/dsh-tool-skill'));
  assert.ok(definition.plugins.some(item => item.name === '@deepseek-ai/dsh-tool-bash'));
  const runtime = definition.plugins.find(item => item.name.endsWith('/dsh-runtime-plugin'));
  assert.deepEqual(runtime.config.skillDefinitions, [skill]);
  const registrations = [];
  applyDshRuntimePlugin({ tools: {}, skills: { register: value => { registrations.push(value); return () => {}; } }, on() {}, effect: install => install() }, runtime.config);
  assert.deepEqual(registrations, [skill]);
});

test('dsh preset admission uses a stable revision-scoped id', () => {
  assert.equal(dshPresetId('demo/agent', 3), 'agentkit-studio-agent-demo_2Fagent-r3');
  assert.deepEqual(dshPresetEligibility(agent()), {
    ok: true,
    agentId: 'demo/agent',
    revision: 3,
    presetId: 'agentkit-studio-agent-demo_2Fagent-r3',
    runtime: 'dsh-native',
    local: true,
    mode: 'dsh-native',
  });
});

test('resource-bearing and non-DSH revisions use the native DSH runtime bridge', () => {
  const resourceAgent = agent({ spec: { runtime: { type: 'dsh-native' }, bindings: { modelProfileIds: ['model:one'], mcpServers: [{ resourceId: 'mcp:one' }] } } });
  assert.deepEqual(unsupportedDshBindings(resourceAgent), ['model', 'mcp']);
  assert.equal(dshPresetEligibility(resourceAgent).mode, 'studio-bridge');
  assert.equal(dshPresetEligibility(agent({ spec: { runtime: { type: 'codex' }, bindings: {} } })).mode, 'studio-bridge');
});

test('Studio deployments use the frozen cloud bridge through the native session', async () => {
  const registered = [];
  const cloud = agent({
    source: 'studio-deployment', deployment: { id: `dep_${'a'.repeat(32)}` },
    metadata: { id: 'cloud/agent', name: 'Cloud Agent', revision: 4, local: false },
    spec: { runtime: { type: 'harness' }, bindings: {} },
  });
  const eligibility = dshPresetEligibility(cloud);
  assert.equal(eligibility.ok, true);
  assert.equal(eligibility.local, false);
  assert.equal(eligibility.mode, 'studio-bridge');
  const admission = new DshPresetAdmission({
    registry: { async register(definition) { registered.push(definition); return async () => {}; } },
    getAgent: async () => cloud,
    getToolContracts: async () => { throw new Error('cloud Agent must not query local Tool registry'); },
  });
  await admission.ensure('cloud/agent');
  assert.equal(registered[0].plugins[0].name, '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin');
  assert.equal(registered[0].plugins[0].config.local, false);
  assert.equal(registered[0].plugins[0].config.runtime, 'harness');
  for (const type of ['adk', 'langgraph', 'openclaw', 'hermes']) assert.equal(dshPresetEligibility({ ...cloud, spec: { runtime: { type } } }).ok, false);
  assert.equal(dshPresetEligibility({ ...cloud, source: 'agentengine-server' }).code, 'STUDIO_DEPLOYMENT_REQUIRED');
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
  assert.equal(registered[0].plugins[0].config.includeRuntimeContext, false);
});

test('local runtime presets reuse the official composition including delivery tools', async () => {
  for (const runtime of ['harness','codex','dsh-native']) {
    const registered=[];
    const revision=agent({spec:{runtime:{type:runtime},instructions:{system:'Studio persona'},bindings:{}}});
    const base=[{id:'persona',name:'@deepseek-ai/dsh-persona',config:{suffix:'Workspace {{cwd}}'}},
      {id:'present',name:'@deepseek-ai/dsh-tool-present'},
      {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs'}];
    const admission=new DshPresetAdmission({getAgent:async()=>revision,getBasePlugins:async()=>base.map(row=>structuredClone(row)),
      registry:{async register(definition){registered.push(definition);return async()=>{};}}});
    await admission.ensure('demo/agent');
    const rows=registered[0].plugins;
    assert.equal(rows.filter(row=>row.name==='@deepseek-ai/dsh-persona').length,1);
    assert.equal(rows.find(row=>row.id==='persona').config.suffix,'Workspace {{cwd}}');
    assert.equal(rows.find(row=>row.id==='persona').config.prefix,'Studio persona');
    assert.ok(rows.some(row=>row.name==='@deepseek-ai/dsh-tool-present'));
    assert.ok(rows.some(row=>row.name==='@deepseek-ai/dsh-tool-fs'));
    assert.equal(base[0].config.prefix,undefined,'official base must remain unchanged');
  }
});

test('whole-turn Native owns Web; ordinary legacy presets retain their base Web plugin', async () => {
  const base = [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' }];
  for (const [runtime, nativeEngineContract, keepWeb] of [
    ['harness', 'agentkit.native-dsh-turn/v1', false], ['harness', undefined, true],
    ['codex', 'agentkit.native-dsh-turn/v1', true], ['dsh-native', 'agentkit.native-dsh-turn/v1', true],
  ]) {
    let definition;
    const admission = new DshPresetAdmission({ nativeEngineContract,
      getAgent: async () => agent({ spec: { runtime: { type: runtime }, bindings: { tools: ['workspace_status'] } } }),
      getBasePlugins: async () => base.map(row => structuredClone(row)),
      registry: { register: async value => { definition = value; } },
    });
    await admission.ensure('demo/agent');
    assert.equal(definition.plugins.some(row => row.name === '@deepseek-ai/dsh-tool-web'), keepWeb, runtime);
    assert.ok(definition.plugins.some(row => row.name === '@deepseek-ai/dsh-tool-present'));
  }
  assert.equal(base.length, 2);
});

test('explicit Studio Web bindings replace the same-scope base plugin for both legacy runtimes', async () => {
  for (const runtime of ['dsh-native', 'codex']) for (const catalogId of [false, true]) {
    let definition;
    const base = [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }, { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' }];
    const admission = new DshPresetAdmission({
      getAgent: async () => agent({ spec: { runtime: { type: runtime },
        bindings: { tools: [catalogId ? 'catalog-resource-web' : 'web_fetch'] } } }),
      getBasePlugins: async () => base,
      getToolContracts: async () => catalogId ? [{ name: 'web_fetch', executor: 'builtin', enabled: true }] : [],
      registry: { register: async value => { definition = value; } },
    });
    await admission.ensure('demo/agent');
    assert.equal(definition.plugins.some(row => row.name === '@deepseek-ai/dsh-tool-web'), false);
    assert.ok(definition.plugins.some(row => row.name === '@deepseek-ai/dsh-tool-fs'));
    assert.equal(base.length, 2, 'Do not mutate the Host base preset array');
  }
});

test('a single Agent model resolves to the Studio-published DSH session route', () => {
  const revision = agent({ spec: { runtime: { type: 'harness' }, bindings: { modelProfileIds: ['deepseek-v4-flash'] } } });
  assert.deepEqual(dshModelSelection(revision, { values: { modelProfiles: [{ id: 'ksyun:deepseek-v4-flash', provider: 'ksyun', modelName: 'deepseek-v4-flash', enabled: true }] } }), {
    provider: 'agentkit-studio-ksyun-deepseek-v4-flash', model: 'deepseek-v4-flash',
  });
  assert.deepEqual(dshModelSelection(agent({ spec: { bindings: { modelProfileIds: ['deepseek-v4-flash', 'other-model'] } } }), { values: { modelProfiles: [{ id: 'profile', provider: 'ksyun', modelName: 'deepseek-v4-flash', enabled: true }] } }), {
    provider: 'agentkit-studio-profile', model: 'deepseek-v4-flash',
  });
});

test('the explicit primary model takes precedence over the whitelist order', () => {
  const revision = agent({ spec: { bindings: { modelProfileId: 'primary-b', modelProfileIds: ['other-a', 'primary-b'] } } });
  const settings = { values: { modelProfiles: [{ id: 'other-a', modelName: 'A' }, { id: 'primary-b', modelName: 'B' }] } };
  assert.equal(dshModelSelection(revision, settings).model, 'B');
});

test('preset admission returns the session model selection without changing eligibility', async () => {
  const registered = [];
  const revision = agent({ metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 1, local: true }, spec: { runtime: { type: 'harness' }, bindings: { modelProfileIds: ['deepseek-v4-flash'] } } });
  const admission = new DshPresetAdmission({
    registry: { async register(definition) { registered.push(definition); return async () => {}; } },
    getAgent: async () => revision,
    getModelSelection: async () => ({ provider: 'agentkit-studio-ksyun-deepseek-v4-flash', model: 'deepseek-v4-flash' }),
  });
  const result = await admission.ensure('demo/agent');
  assert.deepEqual(result.modelSelection, { provider: 'agentkit-studio-ksyun-deepseek-v4-flash', model: 'deepseek-v4-flash' });
  assert.equal(registered.length, 1);
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

test('the bridge preset forwards bound DSH tool names to the runtime plugin', async () => {
  const registered = [];
  const revision = agent({ metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 1, local: true }, spec: { runtime: { type: 'harness' }, bindings: { tools: [{ resourceId: 'component_status' }] } } });
  const admission = new DshPresetAdmission({
    registry: { async register(definition) { registered.push(definition); return async () => {}; } },
    getAgent: async () => revision,
  });
  await admission.ensure('demo/agent');
  assert.deepEqual(registered[0].plugins[0].config.toolBindings, ['component_status']);
});

test('the bridge preset forwards AgentEngine builtin Tool contracts for native registration', async () => {
  const registered = [];
  const revision = agent({ metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 1, local: true }, spec: { runtime: { type: 'harness' }, bindings: { tools: [{ resourceId: 'component_status' }] } } });
  const admission = new DshPresetAdmission({
    registry: { async register(definition) { registered.push(definition); return async () => {}; } },
    getAgent: async () => revision,
    getToolContracts: async () => [{ resourceId: 'component_status', name: 'component_status', executor: 'builtin', parameters: { type: 'object', properties: {} } }],
  });
  await admission.ensure('demo/agent');
  assert.deepEqual(registered[0].plugins[0].config.toolContracts, [{ resourceId: 'component_status', name: 'component_status', executor: 'builtin', parameters: { type: 'object', properties: {} } }]);
});

test('whole-turn Native activation is explicit and applies only to local Harness revisions', async () => {
  for (const runtime of ['harness', 'dsh-native', 'codex']) {
    const registered = [], revision = agent({ metadata: { id: 'demo', revision: 1, local: true }, spec: { runtime: { type: runtime }, bindings: {} } });
    const admission = new DshPresetAdmission({ nativeEngineContract: 'agentkit.native-dsh-turn/v1',
      registry: { async register(definition) { registered.push(definition); return async () => {}; } },
      getAgent: async () => revision });
    await admission.ensure('demo');
    const config = registered[0].plugins.find(plugin => plugin.id === 'studio-runtime')?.config;
    assert.equal(config?.nativeEngineContract, runtime === 'harness' ? 'agentkit.native-dsh-turn/v1' : undefined);
  }
  assert.throws(() => new DshPresetAdmission({ nativeEngineContract: 'unknown' }), /Unsupported Native Harness/);
});

test('recovery keeps the preset registered when bound resources are temporarily unavailable', async () => {
  const registered = [];
  const revision = agent({
    metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 2, local: true },
    spec: { runtime: { type: 'harness' }, bindings: { mcpServers: [{ resourceId: 'mcp:old' }], skills: ['skill:old'] } },
  });
  const admission = new DshPresetAdmission({
    registry: { async register(definition) { registered.push(definition); return () => {}; } },
    getAgent: async () => revision,
    getToolContracts: async () => { throw new Error('old MCP resource is unavailable'); },
    getSkillDefinitions: async () => { throw new Error('old Skill Space is unavailable'); },
  });
  await admission.ensure('demo/agent', { allowUnavailableResources: true });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].plugins[0].name, '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin');
  assert.equal(registered[0].plugins[0].config.agentId, 'demo/agent');
  const config = registered[0].plugins[0].config;
  assert.equal(config.resourcesUnavailable, true);
  let request;
  applyDshRuntimePlugin({ tools: {}, on: (_event, callback) => { request = callback; } }, config);
  await assert.rejects(() => request({ agent: { id: 'restored' } }, () => assert.fail('must not run without bound resources')),
    { code: 'STUDIO_PRESET_RESOURCES_UNAVAILABLE' });
  // A strict admission on the SAME instance must not reuse the placeholder.
  await assert.rejects(() => admission.ensure('demo/agent'), /old MCP resource is unavailable/);
  admission.getToolContracts = async () => [];
  admission.getSkillDefinitions = async () => [];
  await admission.ensure('demo/agent');
  assert.equal(registered.length, 2);
  assert.equal(registered[1].plugins[0].config.resourcesUnavailable, undefined);
});

test('the DSH runtime plugin exposes only bound registry tools to Studio', async () => {
  let listener;
  let forwarded;
  let executed;
  const scopeAgent = { id: 'scope-agent', ctx: {} };
  const dispose = setDshRuntimeAdapter({
    async *stream(options) { forwarded = options; yield { type: 'finish', reason: { kind: 'stop' } }; },
  });
  applyDshRuntimePlugin({
    tools: {
      schemas: agent => agent === scopeAgent
        ? [{ name: 'component_status', description: '状态', parameters: { type: 'object', properties: {} } }, { name: 'other', description: '其他', parameters: {} }]
        : [],
      execute: async call => { executed = call; return { isError: false, content: [{ type: 'text', text: 'healthy' }] }; },
    },
    on: (_event, callback) => { listener = callback; return () => {}; },
  }, { agentId: 'demo/agent', runtime: 'harness', local: true, toolBindings: ['component_status'] });
  await listener({ agent: scopeAgent }, async () => ({ model: 'deepseek-v4-flash' }));
  const iterator = routeDshRuntime({ sessionId: scopeAgent.id, model: 'deepseek-v4-flash', agent: scopeAgent, messages: [{ role: 'user', content: '状态' }] }, () => { throw new Error('bound request bypassed Studio'); });
  await iterator.next();
  const listed = forwarded.studioToolAdapter.listTools([], scopeAgent);
  assert.deepEqual(listed.map(tool => tool.name), ['component_status']);
  assert.deepEqual(await forwarded.studioToolAdapter.callTool('component_status', {}, { callId: 'call-1', agent: scopeAgent }), [{ type: 'text', text: 'healthy' }]);
  assert.equal(executed.name, 'component_status');
  assert.equal(executed.callId, 'call-1');
  assert.equal(executed.agent, scopeAgent);
  dispose();
  unbindDshAgentRoutes('demo/agent');
});

test('the DSH runtime plugin restores bound builtin tools when a preset has no contract snapshot', () => {
  const registered = [];
  applyDshRuntimePlugin({
    tools: {
      register: tool => { registered.push(tool); return () => {}; },
      schemas: () => registered.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      execute: async () => ({}),
    },
    on: () => () => {},
  }, { agentId: 'demo/agent', runtime: 'harness', local: true, toolBindings: ['component_status'] });
  assert.deepEqual(registered.map(tool => tool.name), ['component_status']);
});

test('the DSH runtime plugin registers MCP contracts in the native ToolRegistry', async () => {
  const registered = [];
  const executed = [];
  const disposeExecutor = setDshResourceToolExecutor(async input => {
    executed.push(input);
    return [{ type: 'text', text: 'ok' }];
  });
  try {
    applyDshRuntimePlugin({
      tools: {
        register: tool => { registered.push(tool); return () => {}; },
        schemas: () => registered.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        execute: async () => ({}),
      },
      on: () => () => {},
    }, {
      agentId: 'demo/agent', runtime: 'harness', local: true,
      toolContracts: [{
        resourceId: 'mcp-search', mcpResourceId: 'mcp-search', name: 'metaso_web_search',
        description: '网页搜索', parameters: { type: 'object', properties: { query: { type: 'string' } } }, executor: 'mcp', enabled: true,
      }],
    });
    assert.deepEqual(registered.map(tool => tool.name), ['metaso_web_search']);
    const result = await registered[0].execute({ query: 'agentkit' }, { callId: 'call-1', signal: new AbortController().signal });
    assert.deepEqual(result, { result: '[{"type":"text","text":"ok"}]' });
    assert.deepEqual(executed.map(item => ({ agentId: item.agentId, resourceId: item.resourceId, name: item.name, arguments: item.arguments, callId: item.callId })), [{
      agentId: 'demo/agent', resourceId: 'mcp-search', name: 'metaso_web_search', arguments: { query: 'agentkit' }, callId: 'call-1',
    }]);
  } finally {
    disposeExecutor();
  }
});

test('the bridge rewrites the scoped Agent request and routes the root loop by session', async () => {
  const listeners = new Map();
  applyDshRuntimePlugin({
    tools: { schemas: () => [], execute: async () => ({}) },
    on: (event, callback) => { listeners.set(event, callback); return () => {}; },
  }, { agentId: 'demo/agent', runtime: 'harness', local: true });
  const request = await listeners.get('agent/request')({ agent: { id: 'session-1' } }, async () => ({
    provider: 'agentkit-studio-default', model: 'glm-5.3-flash',
  }));
  assert.equal(request.provider, 'agentkit-studio-default');
  assert.equal(request.model, 'glm-5.3-flash');

  const event = item => `data: ${JSON.stringify({ conversationItem: item })}\n\n`;
  const adapter = createDshRuntimeAdapter({
    localHandler: async () => async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(event({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: 'session-routed' } }));
      response.write(`data: ${JSON.stringify({ runtimeEvent: { event_type: 'run.completed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: request.provider,
    model: request.model,
    sessionId: 'session-1',
    messages: [{ role: 'user', content: 'hello' }],
  })) chunks.push(chunk);
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'session-routed'), true);
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
  // Keep old revision presets alive: existing native Sessions may still
  // reference them after a newer revision is admitted.
  assert.deepEqual(unregistered, []);
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

test('the native bridge projects local MCP calls into expandable reasoning', async () => {
  const event = item => `data: ${JSON.stringify({ conversationItem: item })}\n\n`;
  const adapter = createDshRuntimeAdapter({
    localHandler: async () => async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(event({ kind: 'tool_call', lifecycle: 'running', payload: { callId: 'call-1', name: 'metaso_web_search' } }));
      response.write(event({ kind: 'tool_result', lifecycle: 'completed', payload: { callId: 'call-1', text: '命中一条结果' } }));
      response.write(event({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: '搜索完成' } }));
      response.write(`data: ${JSON.stringify({ runtimeEvent: { event_type: 'run.completed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'local:demo/agent', messages: [{ role: 'user', content: '搜索' }] })) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '工具 metaso_web_search 正在调用。' },
    { type: 'reasoning-delta', index: 0, text: '工具 metaso_web_search 已完成。' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '工具 metaso_web_search 正在调用。工具 metaso_web_search 已完成。' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '搜索完成' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '搜索完成' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('the native bridge emits a DSH tool-call block and tool-calls finish reason', async () => {
  const event = item => `data: ${JSON.stringify({ conversationItem: item })}\n\n`;
  const adapter = createDshRuntimeAdapter({
    localHandler: async () => async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(event({ kind: 'tool_call', lifecycle: 'completed', payload: { protocol: 'dsh', callId: 'call-1', name: 'metaso_web_search', arguments: '{"query":"agentkit"}' } }));
      response.write(event({ kind: 'progress', lifecycle: 'completed', payload: { status: 'tool_calls' } }));
      response.end('data: [DONE]\n\n');
    },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'local:demo/agent',
    messages: [{ role: 'user', content: '搜索' }],
    tools: [{ name: 'metaso_web_search', description: '网页搜索', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'metaso_web_search', argumentsDelta: '{"query":"agentkit"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'metaso_web_search', arguments: '{"query":"agentkit"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]);
});

test('the native bridge forwards DSH ToolSchema and nativeTools to the local handler', async () => {
  let payload;
  const event = item => `data: ${JSON.stringify({ conversationItem: item })}\n\n`;
  const adapter = createDshRuntimeAdapter({
    localHandler: async () => async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(event({ kind: 'assistant_text', lifecycle: 'running', payload: { operation: 'append', text: 'done' } }));
      response.write(`data: ${JSON.stringify({ runtimeEvent: { event_type: 'run.completed' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    },
  });
  for await (const _chunk of adapter.stream({
    model: 'local:demo/agent',
    sessionId: 'session-native-tools',
    studioNativeTools: true,
    messages: [{ role: 'system', content: 'Official DSH tool-mode and present instructions.' }, { role: 'user', content: '搜索' }],
    tools: [{ name: 'metaso_web_search', description: '网页搜索', parameters: { type: 'object', properties: {} } }],
  })) {}
  assert.equal(payload.nativeTools, true);
  assert.equal(payload.systemPrompt, 'Official DSH tool-mode and present instructions.');
  assert.deepEqual(payload.tools, [{ name: 'metaso_web_search', description: '网页搜索', parameters: { type: 'object', properties: {} } }]);
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
    studioCodexModel: 'selected-codex-model',
    messages: [{ role: 'user', content: '你好' }],
    studioRuntime: 'codex',
  })) chunks.push(chunk);
  assert.equal(calls[0].input, '你好');
  assert.equal(calls[0].model, 'selected-codex-model');
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

test('a Codex Agent passes the selected gateway model to the actual Codex runtime', async () => {
  let selected;
  const adapter = createDshRuntimeAdapter({
    resolveCodexModel: async selection => {
      assert.deepEqual(selection, { provider: 'agentkit-studio-default', model: 'deepseek-v4.1-flash' });
      return { model: selection.model, modelProvider: { baseUrl: 'https://gateway.example/v1', apiKey: 'test-key' } };
    },
    codexRuntime: { async *stream(options) { selected = options; yield { type: 'text', text: 'done' }; } },
  });
  const dispose = setDshRuntimeAdapter(adapter);
  try {
    for await (const chunk of streamDshRuntime({ model: 'deepseek-v4.1-flash', provider: 'agentkit-studio-default', messages: [{ role: 'user', content: 'hi' }] }, { agentId: 'codex-agent', runtime: 'codex', local: true })) { void chunk; }
  } finally { dispose(); }
  assert.equal(selected.model, 'deepseek-v4.1-flash');
  assert.equal(selected.modelProvider.baseUrl, 'https://gateway.example/v1');
});

test('the native bridge projects Codex dynamic-tool status into expandable reasoning', async () => {
  const adapter = createDshRuntimeAdapter({
    codexRuntime: {
      async *stream() {
        yield { type: 'tool', phase: 'started', name: 'metaso_web_search' };
        yield { type: 'tool', phase: 'completed', name: 'metaso_web_search' };
        yield { type: 'text', text: '搜索完成' };
      },
    },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'local:codex-agent',
    messages: [{ role: 'user', content: '搜索一下' }],
    studioRuntime: 'codex',
  })) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '工具 metaso_web_search 正在调用。' },
    { type: 'reasoning-delta', index: 0, text: '工具 metaso_web_search 已完成。' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '工具 metaso_web_search 正在调用。工具 metaso_web_search 已完成。' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '搜索完成' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '搜索完成' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('the Codex bridge records a completed local trace', async () => {
  const traces = [];
  const adapter = createDshRuntimeAdapter({
    observability: { syncTrace: async record => traces.push(record) },
    codexRuntime: {
      async *stream() {
        yield { type: 'reasoning', text: '分析' };
        yield { type: 'tool', phase: 'started', name: 'search' };
        yield { type: 'tool', phase: 'completed', name: 'search' };
        yield { type: 'text', text: '完成' };
      },
    },
  });
  for await (const _chunk of adapter.stream({ model: 'local:codex-agent', sessionId: 'session-codex', messages: [{ role: 'user', content: '搜索' }], studioRuntime: 'codex' })) {}
  assert.equal(traces.length, 1);
  assert.equal(traces[0].status, 'completed');
  assert.equal(traces[0].sessionId, 'session-codex');
  assert.equal(traces[0].events.at(-1).event_type, 'run.completed');
  assert.deepEqual(traces[0].events.filter(event => event.event_type === 'tool.started').map(event => event.payload.name), ['search']);
});

test('the Codex bridge records a canceled local trace before rethrowing', async () => {
  const traces = [];
  const adapter = createDshRuntimeAdapter({
    observability: { syncTrace: async record => traces.push(record) },
    codexRuntime: {
      async *stream() {
        yield { type: 'reasoning', text: '分析' };
        throw Object.assign(new Error('已取消'), { code: 'CODEX_CANCELED' });
      },
    },
  });
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({ model: 'local:codex-agent', sessionId: 'session-codex-cancel', messages: [{ role: 'user', content: '停止' }], studioRuntime: 'codex' })) {}
  }, error => error.code === 'CODEX_CANCELED');
  assert.equal(traces[0].status, 'canceled');
  assert.equal(traces[0].events.at(-1).event_type, 'run.canceled');
});

test('the cloud bridge projects Responses tool lifecycle into expandable reasoning', async () => {
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ type: 'response.output_item.added', item: { type: 'function_call', id: 'call-1', name: 'search' } })));
      controller.enqueue(new TextEncoder().encode(frame({ type: 'response.output_item.done', item: { type: 'function_call', id: 'call-1', name: 'search', status: 'completed' } })));
      controller.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: '云端结果' })));
      controller.enqueue(new TextEncoder().encode(frame({ type: 'response.completed' })));
      controller.close();
    },
  });
  const adapter = createDshRuntimeAdapter({ cloudClient: { streamAction: async () => ({ body }) } });
  const chunks = [];
  for await (const chunk of adapter.stream({ model: 'cloud:agent-1', messages: [{ role: 'user', content: '搜索' }] })) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '工具 search 正在调用。' },
    { type: 'reasoning-delta', index: 0, text: '工具 search 已完成。' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '工具 search 正在调用。工具 search 已完成。' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '云端结果' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '云端结果' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('the cloud bridge materializes bound platform resources before RunAgent', async () => {
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: '基于知识库回答' })));
      controller.enqueue(new TextEncoder().encode(frame({ type: 'response.completed' })));
      controller.close();
    },
  });
  let request;
  const adapter = createDshRuntimeAdapter({
    resourceAdapter: {
      searchKnowledge: async () => [{ content: '知识库片段：AgentEngine 使用 RunAgent。' }],
      searchMemory: async () => [],
      loadSkill: async () => ({ name: '绑定 Skill', content: '仅用于测试。' }),
      listMcpTools: async () => [],
    },
    cloudClient: {
      getAgent: async () => ({
        id: 'agent-1',
        spec: { bindings: { plugins: [{ config: { binding: { resource: { kind: 'knowledge-base', id: 'kb-1' } } } }] } },
      }),
      streamAction: async (_name, payload) => { request = payload; return { body }; },
    },
  });
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'cloud:agent-1',
    messages: [{ role: 'user', content: '知识库里怎么说？' }],
  })) chunks.push(chunk);
  assert.equal(request.Messages[0].role, 'system');
  assert.match(request.Messages[0].content, /知识库片段：AgentEngine 使用 RunAgent/);
  assert.deepEqual(request.Messages[1], { role: 'user', content: '知识库里怎么说？' });
  assert.equal(chunks.at(-1).type, 'finish');
});

test('the cloud bridge rejects an upstream failure event', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.failed', error: { message: 'upstream unavailable' } })}\n\n`));
      controller.close();
    },
  });
  const adapter = createDshRuntimeAdapter({ cloudClient: { streamAction: async () => ({ body }) } });
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({ model: 'cloud:agent-1', messages: [{ role: 'user', content: '运行' }] })) {}
  }, error => error.code === 'CLOUD_RUN_FAILED' && error.message === 'upstream unavailable');
});

test('the cloud bridge rejects a truncated SSE stream without completion', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"半截"}\n\n'));
      controller.close();
    },
  });
  const adapter = createDshRuntimeAdapter({ cloudClient: { streamAction: async () => ({ body }) } });
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({ model: 'cloud:agent-1', messages: [{ role: 'user', content: '运行' }] })) {}
  }, error => error.code === 'CLOUD_STREAM_INCOMPLETE');
});

test('the cloud bridge propagates an aborted stream as cancellation', async () => {
  const controller = new AbortController();
  let readerCancelled = false;
  const body = new ReadableStream({
    start() {},
    cancel() { readerCancelled = true; },
  });
  const adapter = createDshRuntimeAdapter({ cloudClient: { streamAction: async () => ({ body }) } });
  const iterator = adapter.stream({
    model: 'cloud:agent-1',
    signal: controller.signal,
    messages: [{ role: 'user', content: '运行' }],
  });
  const pending = iterator.next();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CLOUD_RUN_CANCELLED');
  assert.equal(readerCancelled, true);
});

test('the cloud bridge sends CancelRun after an aborted upstream stream', async () => {
  const controller = new AbortController();
  let cancelled;
  const body = new ReadableStream({
    start() {},
    cancel() {},
  });
  const adapter = createDshRuntimeAdapter({
    cloudClient: {
      streamAction: async () => ({ body }),
      action: async (...args) => { cancelled = args; return { data: { Status: 'CANCELLED' } }; },
    },
  });
  const iterator = adapter.stream({
    model: 'cloud:agent-1',
    sessionId: 'cloud-session-1',
    runId: 'invocation-1',
    signal: controller.signal,
    messages: [{ role: 'user', content: '运行' }],
  });
  const pending = iterator.next();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.code === 'CLOUD_RUN_CANCELLED');
  assert.deepEqual(cancelled, ['CancelRun', { AgentId: 'agent-1', SessionId: 'cloud-session-1', InvocationId: 'invocation-1' }]);
});

test('concurrent resource admission registers a frozen preset once; failure permits retry', async () => {
  let release, probes = 0, registrations = 0, fail = true;
  const gate = new Promise(resolve => { release = resolve; });
  const record = agent({ metadata: { id: 'demo/agent', revision: 1, local: true }, buildId: 'build_0123456789abcdef0123', spec: { runtime: { type: 'harness' }, bindings: {} } });
  const admission = new DshPresetAdmission({ getAgent: async () => record,
    getToolContracts: async () => { probes++; await gate; if (fail) throw new Error('probe unavailable'); return []; },
    registry: { register: async () => { registrations++; return () => {}; } },
  });
  const attempts = [admission.ensure('demo/agent'), admission.ensure('demo/agent')];
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual((await Promise.allSettled(attempts)).map(value => value.status), ['rejected', 'rejected']);
  assert.equal(probes, 1);
  fail = false;
  const result = await Promise.all([admission.ensure('demo/agent'), admission.ensure('demo/agent')]);
  assert.equal(registrations, 1);
  assert.equal(probes, 2);
  assert.deepEqual(result.map(value => value.reused), [false, true]);
  await admission.dispose();
});

test('Codex request size and reported usage survive failure in the local trace and native usage stream', async () => {
  const traces = [], chunks = [];
  const adapter = createDshRuntimeAdapter({
    observability: { syncTrace: async record => traces.push(record) },
    codexRuntime: { async *stream() {
      yield { type: 'request-metrics', metrics: { requestId: 'r1', requestChars: 560000, toolsChars: 495000, toolCount: 353 } };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, reasoningTokens: 10 } };
      throw Object.assign(new Error('429'), { code: 'CODEX_MODEL_RATE_LIMITED' });
    } },
  });
  await assert.rejects(async () => { for await (const chunk of adapter.stream({ model: 'local:codex-agent', sessionId: 'usage-session', messages: [{ role: 'user', content: '你好' }], studioRuntime: 'codex' })) chunks.push(chunk); });
  assert.equal(traces[0].events.find(e => e.event_type === 'model.request')?.payload.toolCount, 353);
  assert.equal(traces[0].events.find(e => e.event_type === 'model.usage')?.payload.usage.inputTokens, 100);
  assert.deepEqual(chunks.find(c => c.type === 'usage')?.usage, { inputTokens: 70, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, cacheWriteTokens: 0, reasoningTokens: 10 });
});
