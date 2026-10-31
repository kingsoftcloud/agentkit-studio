/** Host-owned runtime registrations. Cordis scopes, never Agent ids, own cleanup. */
import { createStudioNativeHookRegistry } from '../providers/native-hooks.mjs';
import { createStudioNativeContextSourceRegistry } from '../providers/native-context-sources.mjs';
const mounted = new Set();
let standalone;

function unavailable(code = 'STUDIO_RUNTIME_BRIDGE_CLOSED') {
  return Object.assign(new Error('Studio runtime bridge is unavailable'), { code });
}

function abortable(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || unavailable());
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || unavailable());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createRuntimeBridge() {
  const nativeHooks = createStudioNativeHookRegistry();
  const nativeContextSources = createStudioNativeContextSourceRegistry();
  const lifetime = new AbortController();
  const routes = new Map();
  const pending = new Set();
  const owners = new WeakSet();
  let generation = 0;
  let adapter;
  let executor;
  let nativeTurnExecutor;
  let nativeToolsFactory;
  let builtinToolsFactory;
  const assertOpen = () => { if (lifetime.signal.aborted) throw unavailable(); };

  function register(slot, value) {
    assertOpen();
    const record = { value, controller: new AbortController() };
    if (slot === 'adapter') adapter = record;
    else if (slot === 'native-turn') nativeTurnExecutor = record;
    else if (slot === 'native-tools') nativeToolsFactory = record;
    else if (slot === 'builtin-tools') builtinToolsFactory = record;
    else executor = record;
    return () => {
      record.controller.abort(unavailable('STUDIO_RUNTIME_REGISTRATION_RETIRED'));
      if (slot === 'adapter' && adapter === record) adapter = undefined;
      if (slot === 'executor' && executor === record) executor = undefined;
      if (slot === 'native-turn' && nativeTurnExecutor === record) nativeTurnExecutor = undefined;
      if (slot === 'native-tools' && nativeToolsFactory === record) nativeToolsFactory = undefined;
      if (slot === 'builtin-tools' && builtinToolsFactory === record) builtinToolsFactory = undefined;
    };
  }

  function request(input, registration) {
    assertOpen();
    const signals = [lifetime.signal, input.signal, registration?.controller.signal].filter(Boolean);
    const signal = AbortSignal.any(signals);
    const record = { signal };
    pending.add(record);
    return { signal, finish: () => pending.delete(record) };
  }

  const bridge = {
    nativeHooks,
    nativeContextSources,
    get signal() { return lifetime.signal; },
    setAdapter(value) { return register('adapter', value); },
    setResourceToolExecutor(value) {
      if (typeof value !== 'function') throw new TypeError('Runtime tool executor must be a function');
      return register('executor', value);
    },
    setNativeTurnExecutor(value) {
      if (typeof value !== 'function') throw new TypeError('Native turn executor must be a function');
      return register('native-turn', value);
    },
    setNativeToolsFactory(value) {
      if (typeof value !== 'function') throw new TypeError('Native tools factory must be a function');
      return register('native-tools', value);
    },
    createNativeTools(input) {
      assertOpen();
      if (!nativeToolsFactory) throw unavailable('STUDIO_NATIVE_TOOLS_FACTORY_UNAVAILABLE');
      return nativeToolsFactory.value(input);
    },
    setBuiltinToolsFactory(value) {
      if (typeof value !== 'function') throw new TypeError('Builtin tools factory must be a function');
      return register('builtin-tools', value);
    },
    createBuiltinTools(input) {
      assertOpen();
      const registration = builtinToolsFactory;
      if (!registration) return null;
      return registration.value({ ...input,
        signal: AbortSignal.any([lifetime.signal, registration.controller.signal]),
        isClosed: () => lifetime.signal.aborted || registration.controller.signal.aborted });
    },
    async executeNativeTurn(input) {
      assertOpen();
      const registration = nativeTurnExecutor;
      if (!registration) throw unavailable('STUDIO_NATIVE_TURN_EXECUTOR_UNAVAILABLE');
      const task = request(input, registration);
      try {
        task.signal.throwIfAborted();
        // The Native worker owns cancellation and durable receipts. DSH must
        // not begin another turn until that worker has stopped driving effects.
        const result = await registration.value({ ...input, signal: task.signal });
        // A canceled Native worker returns only after committing its ending.
        // Preserve that acknowledgment so DSH can close the external turn.
        // Throwing it away leaves a canceled Run with an open Session owner.
        // Host/registration retirement still fences every late completion.
        const settledCancellation = input.signal?.aborted && !lifetime.signal.aborted
          && !registration.controller.signal.aborted && result?.reason?.kind === 'aborted';
        if (!settledCancellation) task.signal.throwIfAborted();
        return result;
      } finally { task.finish(); }
    },
    createRouteScope() {
      assertOpen();
      const owner = Object.freeze({ generation: ++generation });
      owners.add(owner);
      return owner;
    },
    bindRoute(sessionId, binding, owner) {
      assertOpen();
      const id = String(sessionId || '').trim();
      if (!id) return () => {};
      if (owner && !owners.has(owner)) throw unavailable('STUDIO_RUNTIME_ROUTE_OWNER_INVALID');
      const revision = owner?.generation ?? ++generation;
      if (routes.get(id)?.generation > revision) return () => {};
      const route = { binding: { ...binding }, generation: revision };
      routes.set(id, route);
      return () => { if (routes.get(id) === route) routes.delete(id); };
    },
    getRoute(sessionId) { return routes.get(String(sessionId || '').trim())?.binding; },
    unbindAgentRoutes(agentId) {
      for (const [id, route] of routes) if (route.binding.agentId === String(agentId || '').trim()) routes.delete(id);
    },
    async executeResourceTool(input = {}) {
      assertOpen();
      const registration = executor;
      if (!registration) throw unavailable('MCP_TOOL_EXECUTOR_UNAVAILABLE');
      const task = request(input, registration);
      try {
        task.signal.throwIfAborted();
        return await abortable(registration.value({ ...input, signal: task.signal }), task.signal);
      } finally { task.finish(); }
    },
    async *trackStream(input, invoke, registration) {
      const task = request(input, registration);
      let iterator;
      try {
        task.signal.throwIfAborted();
        iterator = invoke({ ...input, signal: task.signal })[Symbol.asyncIterator]();
        while (true) {
          const next = await abortable(iterator.next(), task.signal);
          task.signal.throwIfAborted();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        task.finish();
        // A provider must observe the signal. An unresponsive iterator cannot
        // keep Host teardown waiting forever; consume its eventual cleanup error.
        if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
      }
    },
    stream(input, mapOptions = value => value) {
      assertOpen();
      const registration = adapter;
      if (!registration) throw unavailable('STUDIO_RUNTIME_ADAPTER_UNAVAILABLE');
      return bridge.trackStream(input, options => registration.value.stream(mapOptions(options)), registration);
    },
    diagnostics() {
      return { closed: lifetime.signal.aborted, adapters: Number(Boolean(adapter)), executors: Number(Boolean(executor)), routes: routes.size, requests: pending.size };
    },
    close() {
      lifetime.abort(unavailable());
      adapter = undefined;
      executor = undefined;
      nativeTurnExecutor = undefined;
      nativeToolsFactory = undefined;
      builtinToolsFactory = undefined;
      routes.clear();
      nativeContextSources.close();
      return nativeHooks.close();
    },
  };
  return bridge;
}

/** Supply the service to the Host's descendants and retire only this instance. */
export function mountRuntimeBridge(ctx) {
  const bridge = createRuntimeBridge();
  ctx.provide('studioRuntimeBridge', bridge);
  ctx.effect(() => {
    mounted.add(bridge);
    return () => { mounted.delete(bridge); return bridge.close(); };
  }, 'agentkit-studio: runtime bridge lifetime');
  return bridge;
}

/** Existing standalone exports remain usable; a context never falls back. */
export function resolveRuntimeBridge(owner) {
  if (owner) {
    const bridge = typeof owner.get === 'function' ? owner.get('studioRuntimeBridge') : owner;
    if (!bridge || typeof bridge.bindRoute !== 'function') throw unavailable('STUDIO_RUNTIME_BRIDGE_UNAVAILABLE');
    return bridge;
  }
  if (mounted.size > 1) throw unavailable('STUDIO_RUNTIME_BRIDGE_AMBIGUOUS');
  if (mounted.size === 1) return mounted.values().next().value;
  return standalone ||= createRuntimeBridge();
}

/** Register cleanup before awaiting initialization; close a late result too. */
export function ownAsyncResource(ctx, promise, label) {
  let closed = false;
  let resource;
  ctx.effect(() => () => { closed = true; return resource?.close?.(); }, label);
  const pending = Promise.resolve(promise).then(async value => {
    resource = value;
    if (closed) { await resource?.close?.(); throw unavailable(); }
    return resource;
  });
  // Host domains initialize concurrently. Cordis may retire this scope while
  // another import is awaited, before bootstrap reaches this promise. Observe
  // rejection immediately without changing the promise returned to its owner:
  // failed initialization and retired resources must still reject on await.
  void pending.catch(() => {});
  return pending;
}
