import test from 'node:test';
import assert from 'node:assert/strict';
import { DSH_NODE_BUILTIN_NAMES, unavailableNodeBuiltin } from '../src/providers/dsh-node-builtin-catalog.mjs';
import { Context } from '@deepseek-ai/cordis';
import { createRuntimeBridge, mountRuntimeBridge, ownAsyncResource, resolveRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { spawnSync } from 'node:child_process';

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} every unavailable builtin rejects without consulting a Python executor`, async () => {
  const bridge = createRuntimeBridge(), registered = [];
  const ctx = { get: id => id === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { registered.push(tool); return () => {}; } },
    on: () => () => {}, effect: install => install() };
  const config = { agentId: 'node-only', runtime, local: true,
    toolBindings: [...DSH_NODE_BUILTIN_NAMES, 'unknown_builtin', 'workspace', 'skills', 'core'] };
  for (const key of ['pythonRoot', 'pythonExecutable', 'spawnImpl', 'workspaceRoot'])
    Object.defineProperty(config, key, { get: () => assert.fail(`legacy executor configuration accessed: ${key}`) });
  applyPreset(ctx, config);
  assert.equal(registered.length, DSH_NODE_BUILTIN_NAMES.length + 4);
  for (const tool of registered) {
    const code = unavailableNodeBuiltin(tool.name).code;
    await assert.rejects(tool.execute({}, {}), { code, details: { name: tool.name, contract: 'agentkit.dsh-node-builtin-catalog/v1' } });
    assert.match(code, /NODE_PORT_UNAVAILABLE|^BUILTIN_TOOL_UNSUPPORTED$/);
  }
  bridge.close();
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} unrestricted meta-dispatchers are rejected before Node factory activation`, () => {
  const bridge = createRuntimeBridge();
  bridge.setBuiltinToolsFactory(() => assert.fail('meta dispatcher must not activate a port'));
  const ctx = { get: id => id === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: () => assert.fail('meta dispatcher cannot be registered') }, on: () => () => {} };
  for (const name of ['tool_search', 'tool_dispatcher', 'agentengine_tool_dispatcher', ' tool_dispatcher '])
    for (const binding of [{ toolBindings: [name] }, { toolContracts: [{ name, executor: 'builtin', enabled: true }] }])
      assert.throws(() => applyPreset(ctx, { agentId: 'node-only', runtime, local: true, ...binding }),
        { code: 'BUILTIN_META_TOOL_FORBIDDEN' });
  bridge.close();
});

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

test('Native cancellation waits for its durable ending and returns it so DSH can close the turn', async () => {
  const bridge = createRuntimeBridge(), started = deferred(), drained = deferred(), caller = new AbortController();
  const ending = { reason: { kind: 'aborted', reason: { kind: 'user' } } };
  let settled = false;
  bridge.setNativeTurnExecutor(async ({ signal }) => {
    started.resolve(); await drained.promise; assert.equal(signal.aborted, true); return ending;
  });
  const pending = bridge.executeNativeTurn({ signal: caller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started.promise; caller.abort({ kind: 'user' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(bridge.diagnostics().requests, 1);
  drained.resolve(); assert.deepEqual(await pending, ending);
  assert.equal(bridge.diagnostics().requests, 0); bridge.close();
});

for (const retirement of ['host', 'registration']) test(`Native ${retirement} retirement cannot return a late canceled ending`, async () => {
  const bridge = createRuntimeBridge(), started = deferred(), drained = deferred(), caller = new AbortController();
  const retire = bridge.setNativeTurnExecutor(async () => {
    started.resolve(); await drained.promise; return { reason: { kind: 'aborted', reason: { kind: 'user' } } };
  });
  const pending = bridge.executeNativeTurn({ signal: caller.signal });
  await started.promise; caller.abort({ kind: 'user' });
  if (retirement === 'host') bridge.close(); else retire();
  // Caller cancellation and owner retirement can supply the rejection cause;
  // neither is permission to return the late worker's canceled ending.
  const retiredCode = retirement === 'host' ? 'STUDIO_RUNTIME_BRIDGE_CLOSED' : 'STUDIO_RUNTIME_REGISTRATION_RETIRED';
  drained.resolve(); await assert.rejects(pending, error => error === caller.signal.reason || error?.code === retiredCode);
  assert.equal(bridge.diagnostics().requests, 0); bridge.close();
});

test('Native cancellation rejects a late successful result instead of accepting unacknowledged cancellation', async () => {
  const bridge = createRuntimeBridge(), started = deferred(), drained = deferred(), caller = new AbortController();
  bridge.setNativeTurnExecutor(async () => { started.resolve(); await drained.promise; return { reason: { kind: 'completed' } }; });
  const pending = bridge.executeNativeTurn({ signal: caller.signal });
  await started.promise; caller.abort(Error('User canceled'));
  drained.resolve(); await assert.rejects(pending, /User canceled/); bridge.close();
});

test('Native turn retirement waits for the worker to drain and rejects late completion', async () => {
  const bridge = createRuntimeBridge(), started = deferred(), drained = deferred();
  let workerSignal, settled = false;
  bridge.setNativeTurnExecutor(async ({ signal }) => {
    workerSignal = signal; started.resolve(); await drained.promise;
    return { reason: { kind: 'completed' } };
  });
  const pending = bridge.executeNativeTurn({ signal: new AbortController().signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await started.promise; bridge.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workerSignal.aborted, true); assert.equal(settled, false);
  assert.equal(bridge.diagnostics().requests, 1);
  drained.resolve(); await assert.rejects(pending, { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' });
  assert.equal(bridge.diagnostics().requests, 0);
});

test('retiring old Native registrations cannot remove their replacements', async () => {
  const bridge = createRuntimeBridge();
  const oldTurn = bridge.setNativeTurnExecutor(async () => 'old');
  const oldTools = bridge.setNativeToolsFactory(() => 'old-tools');
  bridge.setNativeTurnExecutor(async () => 'new'); bridge.setNativeToolsFactory(() => 'new-tools');
  oldTurn(); oldTools();
  assert.equal(await bridge.executeNativeTurn({}), 'new');
  assert.equal(bridge.createNativeTools({}), 'new-tools');
  bridge.close();
});

test('Node builtin factories retain their own retirement and Host lifetime', () => {
  const bridge = createRuntimeBridge();
  assert.equal(bridge.createBuiltinTools({}), null);
  const retireOld = bridge.setBuiltinToolsFactory(input => ({ ...input, source: 'old' }));
  const old = bridge.createBuiltinTools({ isClosed: () => false });
  const retireNext = bridge.setBuiltinToolsFactory(input => ({ ...input, source: 'next' }));
  const next = bridge.createBuiltinTools({});
  retireOld();
  assert.equal(old.isClosed(), true); assert.equal(next.isClosed(), false);
  assert.equal(bridge.createBuiltinTools({}).source, 'next');
  retireNext(); assert.equal(next.isClosed(), true); assert.equal(bridge.createBuiltinTools({}), null);
  bridge.setBuiltinToolsFactory(input => input);
  const last = bridge.createBuiltinTools({}); bridge.close();
  assert.equal(last.isClosed(), true);
  assert.throws(() => bridge.createBuiltinTools({}), { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' });
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} builtin registry forwards real execution to the Node Host without Python`, async () => {
  const bridge = createRuntimeBridge(), registered = [], disposers = [], seen = [];
  const definition = { name: 'write_workspace_file', parameters: { type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } };
  let response = { status: 'ok', content: { ok: true, path: 'node.txt' } }, closed = 0;
  bridge.setBuiltinToolsFactory(({ config, ctx, isClosed }) => {
    assert.equal(config.agentId, 'node-agent'); assert.equal(typeof ctx.tools.register, 'function');
    return { definitions: [definition], supports: name => name === definition.name,
      execute: async (name, args, exec) => { assert.equal(isClosed(), false); seen.push({ name, args, exec }); return response; },
      close: () => { closed++; } };
  });
  const ctx = { get: id => id === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { registered.push(tool); return () => {}; }, schemas: () => [] },
    on: () => () => {}, effect: install => { disposers.push(install()); } };
  applyPreset(ctx, { agentId: 'node-agent', runtime, local: true, toolBindings: ['write_workspace_file'],
    spawnImpl: () => assert.fail('Node workspace must not fall back to Python') });
  assert.equal(registered.length, 1); assert.deepEqual(registered[0].parameters, definition.parameters);
  const args = { path: 'node.txt', content: 'Actual registry execution context' },
    exec = { name: definition.name, callId: 'node-call', signal: new AbortController().signal, agent: { session: { id: 'real-session' } } };
  assert.deepEqual(JSON.parse((await registered[0].execute(args, exec)).result), response.content);
  assert.equal(seen[0].exec, exec); assert.equal(seen[0].args, args);
  response = { status: 'error', content: { error_type: 'file_not_read' } };
  assert.deepEqual(JSON.parse((await registered[0].execute(args, exec)).result), { error_type: 'file_not_read', ok: false });
  response = { status: 'uncertain', content: { error_type: 'state_persist_failed', executed: true, paths: ['node.txt'] } };
  const unknown = JSON.parse((await registered[0].execute(args, exec)).result);
  assert.equal(unknown.status, 'uncertain'); assert.equal(unknown.executed, true); assert.equal(unknown.ok, false);
  disposers.reverse().forEach(dispose => dispose?.()); assert.equal(closed, 1); bridge.close();
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} maps legacy snippets without shadowing PTC and cannot fall back to Python`, async () => {
  const bridge = createRuntimeBridge(), registered = [], disposers = [], listeners = new Map();
  const ctx = { get: id => id === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { assert.notEqual(tool.name, 'run_code'); registered.push(tool); return () => {}; },
      schemas: () => [...registered, { name: 'run_code', parameters: { type: 'object' } }],
      execute: exec => { assert.equal(exec.name, 'sandbox_run_code'); return registered[0].execute(exec.arguments, exec); } },
    on: (name, listener) => { listeners.set(name, listener); return () => {}; }, effect: install => disposers.push(install()) };
  applyPreset(ctx, { agentId: 'code-agent', runtime, local: true, toolBindings: ['run_code'],
    spawnImpl: () => assert.fail('missing Node snippet port cannot enter Python') });
  assert.deepEqual(registered.map(tool => tool.name), ['sandbox_run_code']);
  const args = { code: 'printf forbidden', language: 'bash' }, exec = { name: 'sandbox_run_code', arguments: args, callId: 'code',
    agent: { session: { id: 'session' } }, signal: new AbortController().signal };
  await assert.rejects(registered[0].execute(args, exec), { code: 'SANDBOX_CODE_NODE_PORT_UNAVAILABLE' });
  exec.agent.id = 'code-session';
  await listeners.get('agent/request')({ agent: exec.agent }, async () => ({}));
  const adapter = bridge.getRoute('code-session').toolAdapter;
  assert.deepEqual(adapter.listTools([], exec.agent).map(tool => tool.name), ['sandbox_run_code']);
  await assert.rejects(adapter.callTool('run_code', args, { agent: exec.agent, callId: 'legacy-call', signal: exec.signal }),
    { code: 'SANDBOX_CODE_NODE_PORT_UNAVAILABLE' });
  disposers.reverse().forEach(dispose => dispose?.()); bridge.close();
});

test('a Harness preset claims the whole turn and rejects model-step fallback', async () => {
  const bridge = createRuntimeBridge(), listeners = new Map(), disposers = [];
  const nativeTools = {};
  bridge.setNativeToolsFactory(() => nativeTools);
  bridge.setNativeTurnExecutor(async payload => {
    assert.equal(payload.binding.nativeTools, nativeTools);
    assert.equal(payload.binding.agentRevision, 7);
    return { reason: { kind: 'completed' } };
  });
  const ctx = { get: () => bridge, tools: { schemas: () => [] },
    effect: install => disposers.push(install()), on: (name, listener) => listeners.set(name, listener) };
  applyPreset(ctx, { agentId: 'native', agentRevision: 7, runtime: 'harness', local: true, nativeEngineContract: 'agentkit.native-dsh-turn/v1' });
  assert.deepEqual(await listeners.get('agent/execute-turn')({}), { reason: { kind: 'completed' } });
  await assert.rejects(listeners.get('agent/request')({}, async () => assert.fail('Cannot delegate the Native loop')),
    { code: 'STUDIO_NATIVE_WHOLE_TURN_REQUIRED' });
  disposers.reverse().forEach(dispose => dispose?.()); bridge.close();
});

test('older registration and route cleanup cannot withdraw their replacements', async () => {
  const bridge = createRuntimeBridge();
  const old = bridge.setAdapter({ async *stream() { yield 'old'; } });
  const next = bridge.setAdapter({ async *stream() { yield 'new'; } });
  const oldScope = bridge.createRouteScope(), newScope = bridge.createRouteScope();
  const oldRoute = bridge.bindRoute('same', { agentId: 'old' }, oldScope);
  const newRoute = bridge.bindRoute('same', { agentId: 'new' }, newScope);
  bridge.bindRoute('same', { agentId: 'late-old' }, oldScope)();
  old(); oldRoute(); old();
  assert.equal(bridge.getRoute('same').agentId, 'new');
  assert.deepEqual(await Array.fromAsync(bridge.stream({})), ['new']);
  next(); newRoute(); bridge.close(); bridge.close();
  assert.deepEqual(bridge.diagnostics(), { closed: true, adapters: 0, executors: 0, routes: 0, requests: 0 });
});

test('Host teardown aborts a blocked stream and tool exactly once', async () => {
  const bridge = createRuntimeBridge();
  const ready = deferred();
  let streamSignal, toolSignal;
  bridge.setAdapter({ async *stream({ signal }) {
    streamSignal = signal; ready.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    yield 'must not escape retirement';
  } });
  bridge.setResourceToolExecutor(({ signal }) => {
    toolSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve('late'), { once: true }));
  });
  const iterator = bridge.stream({});
  const stream = iterator.next();
  const tool = bridge.executeResourceTool({});
  const rejected = [assert.rejects(stream, { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' }), assert.rejects(tool, { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' })];
  await ready.promise;
  bridge.close();
  await Promise.all(rejected);
  assert.equal(streamSignal.aborted, true);
  assert.equal(toolSignal.aborted, true);
  assert.equal(bridge.diagnostics().requests, 0);
  assert.throws(() => bridge.setAdapter({}), { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' });
});

test('two Cordis Hosts reject an ambiguous compatibility call and remain isolated', async () => {
  const left = new Context(), right = new Context();
  const a = mountRuntimeBridge(left), b = mountRuntimeBridge(right);
  try {
    a.bindRoute('same', { agentId: 'left' }); b.bindRoute('same', { agentId: 'right' });
    assert.equal(resolveRuntimeBridge(left).getRoute('same').agentId, 'left');
    assert.equal(resolveRuntimeBridge(right).getRoute('same').agentId, 'right');
    assert.throws(() => resolveRuntimeBridge(), { code: 'STUDIO_RUNTIME_BRIDGE_AMBIGUOUS' });
    assert.throws(() => resolveRuntimeBridge({ get: () => undefined }), { code: 'STUDIO_RUNTIME_BRIDGE_UNAVAILABLE' });
    await left.fiber.dispose();
    assert.equal(b.getRoute('same').agentId, 'right');
  } finally { await left.fiber.dispose(); await right.fiber.dispose(); }
});

test('late initialization closes its result after the owning fiber retired', async () => {
  const ctx = new Context();
  const gate = deferred();
  let pending, closed = 0;
  const fiber = await ctx.plugin({ apply(child) { pending = ownAsyncResource(child, gate.promise, 'late resource'); } });
  const rejected = assert.rejects(pending, { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' });
  await fiber.dispose();
  gate.resolve({ close() { closed++; } });
  await rejected;
  assert.equal(closed, 1);
  await ctx.fiber.dispose();
});

test('concurrent Host initialization observes a retired resource before bootstrap awaits it', () => {
  const moduleUrl = new URL('../src/host/runtime-bridge.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { ownAsyncResource } from ${JSON.stringify(moduleUrl)};
    let retire, resolve, closed = 0;
    const gate = new Promise(done => { resolve = done; });
    const pending = ownAsyncResource({ effect(callback) { retire = callback(); } }, gate, 'delayed bootstrap');
    retire(); resolve({ close() { closed++; } });
    await new Promise(done => setTimeout(done, 20));
    await assert.rejects(pending, { code: 'STUDIO_RUNTIME_BRIDGE_CLOSED' });
    assert.equal(closed, 1);
    const failed = ownAsyncResource({ effect() {} }, Promise.reject(Object.assign(new Error('fixture'), { code: 'INITIALIZATION_FAILED' })), 'failed bootstrap');
    await new Promise(done => setTimeout(done, 20));
    await assert.rejects(failed, { code: 'INITIALIZATION_FAILED' });
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});

test('resource adapter retirement aborts MCP initialization and prevents reconnection', async () => {
  const ready = deferred();
  let initializationSignal, connections = 0;
  const adapters = createLocalResourceAdapters({ resourceStore: { get: async () => ({ endpointUrl: 'http://mcp.test' }) }, fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body || '{}').method !== 'initialize') return new Response(null, { status: 202 });
    connections++; initializationSignal = init.signal; ready.resolve();
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const pending = adapters.listMcpTools('mcp-local-proof');
  const rejects = assert.rejects(pending);
  await ready.promise;
  await adapters.close(); await adapters.close();
  await rejects;
  assert.equal(initializationSignal.aborted, true);
  await assert.rejects(adapters.listMcpTools('mcp-local-proof'), { code: 'RESOURCE_ADAPTER_CLOSED' });
  assert.equal(connections, 1);
});

test('preset cleanup is owned by its exact Cordis scope, not the Agent id', async () => {
  const ctx = new Context();
  const bridge = mountRuntimeBridge(ctx);
  ctx.provide('tools', { schemas: () => [] }); ctx.provide('skills', {});
  const mount = async () => {
    let request;
    const fiber = await ctx.plugin({ inject: ['tools', 'skills', 'studioRuntimeBridge'], apply(child) {
      const observed = new Proxy(child, { get(target, key) {
        if (key === 'on') return (name, callback) => { if (name === 'agent/request') request = callback; return target.on(name, callback); };
        return Reflect.get(target, key);
      } });
      applyPreset(observed, { agentId: 'same-agent', runtime: 'harness', local: true });
    } });
    // Deliver to the selected scope. DSH installs its Agent carrier filter;
    // this unit test does not broadcast an Agent event across sibling scopes.
    await request({ agent: { id: 'same-session' } }, async () => ({ model: 'fixture' }));
    return fiber;
  };
  try {
    const old = await mount(), fresh = await mount();
    const route = bridge.getRoute('same-session');
    await old.dispose();
    assert.equal(bridge.getRoute('same-session'), route);
    await fresh.dispose();
    assert.equal(bridge.getRoute('same-session'), undefined);
  } finally { await ctx.fiber.dispose(); }
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} unavailable migrated A2A port never enters Python`, async () => {
  const bridge = createRuntimeBridge(), registered = [];
  const ctx = { get: name => name === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { registered.push(tool); return () => {}; } }, on: () => () => {}, effect: install => install() };
  applyPreset(ctx, { agentId: 'a2a-agent', runtime, local: true, toolBindings: ['list_a2a_agents', 'get_a2a_agent_card', 'call_a2a_agent'],
    spawnImpl: () => assert.fail('migrated A2A port cannot spawn Python') });
  for (const tool of registered) await assert.rejects(tool.execute({}, {}), { code: 'A2A_NODE_PORT_UNAVAILABLE' });
  assert.equal(registered.length, 3); bridge.close();
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} unavailable migrated browser port never enters Python`, async () => {
  const bridge = createRuntimeBridge(), registered = [];
  const ctx = { get: name => name === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { registered.push(tool); return () => {}; } }, on: () => () => {}, effect: install => install() };
  applyPreset(ctx, { agentId: 'browser-agent', runtime, local: true, toolBindings: ['browser_inspect_workspace'],
    spawnImpl: () => assert.fail('migrated Browser cannot spawn Python') });
  assert.equal(registered.length, 1);
  await assert.rejects(registered[0].execute({}, {}), { code: 'BROWSER_NODE_PORT_UNAVAILABLE' }); bridge.close();
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} unavailable Skill management port never enters Python`, async () => {
  const bridge = createRuntimeBridge(), registered = [];
  const ctx = { get: name => name === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { registered.push(tool); return () => {}; } }, on: () => () => {}, effect: install => install() };
  applyPreset(ctx, { agentId: 'skill-manager', runtime, local: true, toolBindings: ['skill_discover_github', 'skill_install', 'skill_bind_agent'],
    spawnImpl: () => assert.fail('Skill management cannot spawn Python') });
  assert.equal(registered.length, 3);
  for (const tool of registered) await assert.rejects(tool.execute({}, {}), { code: 'SKILL_MANAGEMENT_NODE_PORT_UNAVAILABLE' });
  bridge.close();
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} unavailable knowledge port never enters Python`, async () => {
  const bridge = createRuntimeBridge(), registered = [];
  const ctx = { get: name => name === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { registered.push(tool); return () => {}; } }, on: () => () => {}, effect: install => install() };
  applyPreset(ctx, { agentId: 'knowledge-agent', runtime, local: true, toolBindings: ['search_knowledge_base'],
    spawnImpl: () => assert.fail('Knowledge lookup cannot spawn Python') });
  assert.equal(registered.length, 1);
  await assert.rejects(registered[0].execute({}, {}), { code: 'KNOWLEDGE_NODE_PORT_UNAVAILABLE' }); bridge.close();
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} unavailable legacy Memory ports never enter Python`, async () => {
  const bridge = createRuntimeBridge(), registered = [];
  const ctx = { get: name => name === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { registered.push(tool); return () => {}; } }, on: () => () => {}, effect: install => install() };
  applyPreset(ctx, { agentId: 'memory-agent', runtime, local: true, toolBindings: ['load_memory', 'save_memory'],
    spawnImpl: () => assert.fail('Memory cannot spawn Python') });
  assert.equal(registered.length, 2);
  for (const tool of registered) await assert.rejects(tool.execute({}, {}), { code: 'MEMORY_NODE_PORT_UNAVAILABLE' }); bridge.close();
});

for (const runtime of ['dsh-native', 'codex']) test(`${runtime} explicit managed binding admits three A2A formals and rejects executor collisions`, () => {
  const bridge = createRuntimeBridge(), tools = [];
  const ctx = { get: name => name === 'studioRuntimeBridge' ? bridge : undefined,
    tools: { register: tool => { tools.push(tool); return () => {}; } }, on: () => () => {}, effect: install => install() };
  const config = { agentId: 'managed-agent', runtime, local: true, a2aBindings: [{ binding_id: 'binding' }] };
  applyPreset(ctx, config);
  assert.deepEqual(tools.map(tool => tool.name), ['list_a2a_agents', 'get_a2a_agent_card', 'call_a2a_agent']);
  assert.throws(() => applyPreset(ctx, { ...config, toolContracts: [{ name: 'call_a2a_agent', executor: 'mcp' }] }), { code: 'A2A_TOOL_NAME_COLLISION' });
  bridge.close();
});
