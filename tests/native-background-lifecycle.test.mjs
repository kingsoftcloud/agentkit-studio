import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { bindNativeBackgroundRuntime } from '../src/host/native-background-lifecycle.mjs';
import { FROZEN_RUNTIME_READY } from '../src/host/frozen-runtime-lifecycle.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settled = () => new Promise(resolve => setImmediate(resolve));
function scopes(options) {
  let activate, dependencies;
  bindNativeBackgroundRuntime({ inject(names, callback) { dependencies = names; activate = callback; } }, options);
  return { dependencies, enter() {
    let retire;
    const ctx = { fiber: { uid: Symbol('scope') }, effect(callback) { retire = callback(); } };
    const starting = activate(ctx);
    return { starting, retire: () => { ctx.fiber.uid = null; return retire(); } };
  } };
}

test('real Cordis waits for portable frozen readiness and starts without a user prompt', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let started = 0, closed = 0, signal;
  for (const service of ['sessions', 'sessionProjections', 'llm', 'agentPresets', 'sessionController', 'agents', 'permissionPresets', 'approval']) ctx.provide(service, {});
  bindNativeBackgroundRuntime(ctx, { readyService: FROZEN_RUNTIME_READY, getHost: async () => ({
    async startBackgroundWatcher(input) {
      started++; signal = input.signal;
      return { close() { closed++; } };
    },
  }) });
  await ctx.fiber.await(); await settled();
  assert.equal(started, 0, 'portable resources must be initialized before background admission');
  ctx.provide(FROZEN_RUNTIME_READY, { ready: true });
  await ctx.fiber.await(); await settled();
  assert.equal(started, 1);
  assert.equal(signal.aborted, false);
  await ctx.fiber.dispose();
  assert.equal(signal.aborted, true); assert.equal(closed, 1);
});

test('retired dependency generation cannot start a watcher after a late Host resolution', async () => {
  const host = deferred(), entered = deferred();
  let starts = 0;
  const binding = scopes({ getHost: () => { entered.resolve(); return host.promise; } });
  assert.ok(binding.dependencies.includes('permissionPresets'));
  assert.ok(!binding.dependencies.includes('commands'));
  const scope = binding.enter(); await entered.promise;
  const retiring = scope.retire();
  host.resolve({ startBackgroundWatcher() { starts++; assert.fail('retired dependency generation started'); } });
  await scope.starting; await retiring;
  assert.equal(starts, 0);
});

test('a replacement waits for old watcher shutdown before acquiring its registry', async () => {
  const drain = deferred();
  let starts = 0, firstSignal;
  const binding = scopes({ getHost: async () => ({ async startBackgroundWatcher({ signal }) {
    const current = ++starts;
    if (current === 1) firstSignal = signal;
    return { close: () => current === 1 ? drain.promise : undefined };
  } }) });
  const old = binding.enter(); await old.starting;
  const retiring = old.retire(), fresh = binding.enter();
  await settled();
  assert.equal(firstSignal.aborted, true); assert.equal(starts, 1);
  drain.resolve(); await retiring; await fresh.starting;
  assert.equal(starts, 2);
  await fresh.retire();
});

test('late startup is closed and cannot strand subsequent dependency generations', async () => {
  const admission = deferred(), entered = deferred();
  let starts = 0, closes = 0;
  const owner = { close() { if (!closes) closes++; } };
  const binding = scopes({ getHost: async () => ({ startBackgroundWatcher() {
    if (++starts === 1) { entered.resolve(); return admission.promise; }
    return { close() {} };
  } }) });
  const old = binding.enter(); await entered.promise;
  const retiring = old.retire(), fresh = binding.enter();
  admission.resolve(owner);
  await old.starting; await retiring; await fresh.starting;
  assert.equal(closes, 1); assert.equal(starts, 2);
  await fresh.retire();
});

test('startup integrity failure remains visible and releases the replacement gate', async () => {
  let calls = 0;
  const observed = [], failure = Object.assign(new Error('bad watch database'), { code: 'watch_store_corrupt' });
  const binding = scopes({ onError: error => observed.push(error), getHost: async () => ({
    async startBackgroundWatcher() {
      if (++calls === 1) throw failure;
      return { close() {} };
    },
  }) });
  const failed = binding.enter();
  await assert.rejects(failed.starting, error => error === failure);
  assert.deepEqual(observed, [failure]);
  const retry = binding.enter(); await retry.starting;
  assert.equal(calls, 2);
  await failed.retire(); await retry.retire();
});
