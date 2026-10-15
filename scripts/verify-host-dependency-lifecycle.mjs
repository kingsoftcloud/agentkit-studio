/** Real Cordis dependency scopes with controlled HTTP runtimes, without model calls. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { bindFrozenRuntime } from '../src/host/frozen-runtime-lifecycle.mjs';

if (!process.env.AGENTKIT_DSH_ROOT) throw new Error('Specify the built DSH checkout');
const require = createRequire(join(resolve(process.env.AGENTKIT_DSH_ROOT), 'apps/cli/package.json'));
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
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
  await provide(ctx, { agentPresets: {}, agents: {}, commands: {}, approval: {} });
  let binding, current, starts = 0, closes = 0, unavailable = 0;
  const owner = await ctx.plugin({ name: 'controlled-studio-owner', apply: async scope => {
    binding = bindFrozenRuntime(scope, {
      start: async runtimeCtx => {
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
  assert.equal(unavailable, 1); assert.equal(starts, 0);
  await absentCapability.dispose();
  const first = await provide(ctx, { sessionController: { ready: true, label: 'first' } });
  await binding;
  assert.equal(starts, 1); assert.equal(await (await fetch(current.url)).text(), 'first');
  checks('late-compatible-service-starts-without-reloading-studio-owner');
  stage = 'service-replacement';
  await first.dispose(); await binding;
  assert.equal(closes, 1); assert.equal(servers.size, 0);
  await provide(ctx, { sessionController: { ready: true, label: 'replacement' } });
  await binding;
  assert.equal(starts, 2); assert.equal(await (await fetch(current.url)).text(), 'replacement');
  checks('service-removal-closes-listener-and-replacement-restarts-it');
  await owner.dispose(); assert.equal(closes, 2); assert.equal(servers.size, 0);
  checks('studio-owner-disposal-closes-current-runtime');
  stage = 'pending-start-disposal';
  const delayed = new Context(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await provide(delayed, { agentPresets: {}, agents: {}, commands: {}, approval: {}, sessionController: {} });
  let pendingBinding, lateCloses = 0;
  const pendingOwner = await delayed.plugin({ name: 'delayed-studio-owner', apply: scope => {
    pendingBinding = bindFrozenRuntime(scope, { start: async () => {
      entered.resolve(); await release.promise;
      return listen('late', () => { lateCloses++; });
    }, onUnavailable: () => assert.fail('No incompatible service in this case') });
  } });
  fibers.push(pendingOwner);
  await entered.promise;
  const disposing = pendingOwner.dispose(); release.resolve();
  await disposing; await pendingBinding;
  assert.equal(lateCloses, 1); assert.equal(servers.size, 0);
  checks('startup-completing-after-disposal-closes-its-listener');
  checksComplete = true;
} catch (error) {
  report.failure = { stage, name: error.name, code: error.code || 'VERIFY_FAILED' };
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
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
