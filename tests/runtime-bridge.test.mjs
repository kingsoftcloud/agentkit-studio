import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createRuntimeBridge, mountRuntimeBridge, ownAsyncResource, resolveRuntimeBridge } from '../src/host/runtime-bridge.mjs';
import { apply as applyPreset } from '../src/providers/dsh-runtime-plugin.mjs';
import { createLocalResourceAdapters } from '../src/local-resource-adapters.mjs';
import { spawnSync } from 'node:child_process';

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

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
