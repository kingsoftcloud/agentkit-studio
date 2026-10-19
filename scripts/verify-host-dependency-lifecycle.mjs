/** Real Cordis dependency scopes with controlled HTTP runtimes, without model calls. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindFrozenRuntime, FROZEN_RUNTIME_READY } from '../src/host/frozen-runtime-lifecycle.mjs';
import { assertHostDependencyLifecycleReport } from './verification/host-dependency-lifecycle-report.mjs';

if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Specify the built DSH checkout');
const require = createRequire(join(resolve(process.env.AGENTKIT_DSH_ROOT), 'apps/cli/package.json'));
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
const target = resolve(process.argv[2] || '.artifacts/refactor/stage-5/host-dependency-lifecycle.json');
const report = { evidence: 'real-cordis-dependency-scopes-controlled-http-runtime', passed: false, checks: [],
  limits: ['The HTTP runtime and native service values are controlled lifecycle fixtures; full DSH startup is verified separately.'] };
const checks = name => report.checks.push({ name, passed: true });
const fibers = [], servers = new Set();
let stage = 'late-services', checksComplete = false;
async function provide(ctx, values) {
  const fiber = await ctx.plugin({ name: 'controlled-host-services', apply: owner => {
    for (const [key, value] of Object.entries(values)) owner.provide(key, value);
  } });
  fibers.push(fiber); return fiber;
}
function observeReadiness(ctx) {
  const state = { activations: 0, withdrawals: 0, active: false };
  const fiber = ctx.plugin({ name: 'controlled-runtime-ready-dependent', inject: [FROZEN_RUNTIME_READY], apply: scope => {
    assert.deepEqual(scope.get(FROZEN_RUNTIME_READY), { ready: true });
    assert.equal(Object.isFrozen(scope.get(FROZEN_RUNTIME_READY)), true, 'readiness is an immutable receipt');
    state.activations++; state.active = true;
    scope.effect(() => () => { state.withdrawals++; state.active = false; }, 'controlled readiness consumer');
  } });
  fibers.push(fiber);
  return { fiber, state };
}
const responseText = async url => (await fetch(url, { signal: AbortSignal.timeout(3000) })).text();
async function listen(value, closed) {
  const server = createServer((_request, response) => response.end(value));
  servers.add(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    assert.equal(servers.delete(server), true, 'a listener closes exactly once');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closed();
  } };
}
const watchdog = setTimeout(() => { console.error('Dependency lifecycle verification timed out'); process.exit(1); }, 20000);
try {
  const ctx = new Context();
  const ordinaryReadiness = observeReadiness(ctx);
  await provide(ctx, { agentPresets: {}, agents: {}, commands: {}, approval: {} });
  let binding, current, starts = 0, closes = 0, unavailable = 0;
  const owner = await ctx.plugin({ name: 'controlled-studio-owner', apply: async scope => {
    binding = bindFrozenRuntime(scope, {
      start: async runtimeCtx => {
        assert.equal(typeof runtimeCtx.get('permissionPresets')?.set, 'function');
        const controller = runtimeCtx.get('sessionController');
        if (!controller.ready) throw Object.assign(new Error('controlled missing capability'), { code: 'STUDIO_HOST_INCOMPATIBLE' });
        starts++; current = await listen(controller.label, () => { closes++; }); return current;
      },
      onUnavailable: () => { unavailable++; },
    });
    await binding;
  } });
  fibers.push(owner);
  assert.equal(starts, 0);
  const absentCapability = await provide(ctx, { sessionController: { ready: false } });
  await binding;
  assert.equal(unavailable, 0); assert.equal(starts, 0, 'commands cannot substitute for a missing permission setter');
  const permission = await provide(ctx, { permissionPresets: { set() {} } });
  await binding;
  assert.equal(unavailable, 1); assert.equal(starts, 0);
  checks('late-permission-preset-service-enables-runtime-inspection');
  await absentCapability.dispose();
  const first = await provide(ctx, { sessionController: { ready: true, label: 'first' } });
  await binding;
  assert.equal(starts, 1); assert.equal(await responseText(current.url), 'first');
  checks('late-compatible-service-starts-without-reloading-studio-owner');
  stage = 'service-replacement';
  await first.dispose(); await binding;
  assert.equal(closes, 1); assert.equal(servers.size, 0);
  await provide(ctx, { sessionController: { ready: true, label: 'replacement' } });
  await binding;
  assert.equal(starts, 2); assert.equal(await responseText(current.url), 'replacement');
  checks('service-removal-closes-listener-and-replacement-restarts-it');
  await permission.dispose(); await binding;
  assert.equal(closes, 2); assert.equal(servers.size, 0);
  await provide(ctx, { permissionPresets: { set() {} } });
  await binding;
  assert.equal(starts, 3); assert.equal(await responseText(current.url), 'replacement');
  checks('permission-preset-removal-closes-listener-and-replacement-restarts-it');
  await owner.dispose(); assert.equal(closes, 3); assert.equal(servers.size, 0);
  checks('studio-owner-disposal-closes-current-runtime');
  await ordinaryReadiness.fiber;
  assert.deepEqual(ordinaryReadiness.state, { activations: 0, withdrawals: 0, active: false });
  checks('default-runtime-binding-does-not-publish-portable-readiness');

  stage = 'readiness-gated-start';
  const ready = new Context(), readyEntered = Promise.withResolvers(), readyRelease = Promise.withResolvers();
  const dependent = observeReadiness(ready);
  await provide(ready, { agentPresets: {}, agents: {}, permissionPresets: { set() {} }, approval: {} });
  const native = await provide(ready, { sessionController: {} });
  let readyBinding, readyRuntime, readyStarts = 0, readyCloses = 0;
  const readyOwner = await ready.plugin({ name: 'readiness-studio-owner', apply: scope => {
    readyBinding = bindFrozenRuntime(scope, { readyService: FROZEN_RUNTIME_READY,
      start: async () => {
        readyStarts++; readyEntered.resolve(); await readyRelease.promise;
        readyRuntime = await listen('ready', () => { readyCloses++; }); return readyRuntime;
      }, onUnavailable: () => assert.fail('All readiness fixture capabilities are present') });
  } });
  fibers.push(readyOwner);
  await readyEntered.promise; await dependent.fiber;
  assert.equal(readyStarts, 1);
  assert.deepEqual(dependent.state, { activations: 0, withdrawals: 0, active: false });
  checks('readiness-dependent-waits-until-runtime-start-completes');
  readyRelease.resolve(); await readyBinding; await dependent.fiber;
  assert.deepEqual(dependent.state, { activations: 1, withdrawals: 0, active: true });
  assert.equal(await responseText(readyRuntime.url), 'ready');
  checks('successful-runtime-start-activates-readiness-dependent');
  stage = 'readiness-native-removal';
  await native.dispose(); await readyBinding; await dependent.fiber;
  assert.deepEqual(dependent.state, { activations: 1, withdrawals: 1, active: false });
  assert.equal(readyCloses, 1); assert.equal(servers.size, 0);
  await provide(ready, { sessionController: {} }); await readyBinding; await dependent.fiber;
  assert.equal(readyStarts, 2);
  assert.deepEqual(dependent.state, { activations: 2, withdrawals: 1, active: true });
  assert.equal(await responseText(readyRuntime.url), 'ready');
  await readyOwner.dispose(); await dependent.fiber;
  assert.deepEqual(dependent.state, { activations: 2, withdrawals: 2, active: false });
  assert.equal(readyCloses, 2); assert.equal(servers.size, 0);
  checks('native-dependency-removal-withdraws-runtime-readiness');

  for (const readyService of [undefined, FROZEN_RUNTIME_READY]) {
    stage = readyService ? 'pending-ready-start-disposal' : 'pending-start-disposal';
    const delayed = new Context(), entered = Promise.withResolvers(), release = Promise.withResolvers();
    const delayedReadiness = observeReadiness(delayed);
    await provide(delayed, { agentPresets: {}, agents: {}, permissionPresets: { set() {} }, approval: {}, sessionController: {} });
    let pendingBinding, lateCloses = 0;
    const pendingOwner = await delayed.plugin({ name: 'delayed-studio-owner', apply: scope => {
      pendingBinding = bindFrozenRuntime(scope, { ...(readyService ? { readyService } : {}), start: async () => {
        entered.resolve(); await release.promise;
        return listen('late', () => { lateCloses++; });
      }, onUnavailable: () => assert.fail('No incompatible service in this case') });
    } });
    fibers.push(pendingOwner);
    await entered.promise;
    const disposing = pendingOwner.dispose(); release.resolve();
    await disposing; await pendingBinding;
    assert.equal(lateCloses, 1); assert.equal(servers.size, 0);
    await delayedReadiness.fiber;
    assert.deepEqual(delayedReadiness.state, { activations: 0, withdrawals: 0, active: false });
    checks(readyService ? 'startup-completing-after-disposal-never-publishes-readiness' : 'startup-completing-after-disposal-closes-its-listener');
  }
  checksComplete = true;
} catch (error) {
  report.failure = { stage, name: error.name, code: error.code || 'VERIFY_FAILED', message: String(error.message).slice(0, 500) };
  process.exitCode = 1;
} finally {
  try {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } catch (error) {
    report.failure ??= { stage: 'cleanup', name: error.name, code: error.code || 'VERIFY_CLEANUP_FAILED' };
    process.exitCode = 1;
  }
  clearTimeout(watchdog);
  report.passed = checksComplete && !report.failure;
  if (report.passed) {
    try { assertHostDependencyLifecycleReport(report); }
    catch (error) { report.passed = false; report.failure = { stage: 'report-contract', name: error.name, code: error.code }; process.exitCode = 1; }
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
