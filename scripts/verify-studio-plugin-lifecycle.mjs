/** Load the complete Studio package repeatedly in one real, isolated DSH profile. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHook } from 'node:async_hooks';

if (!process.env.AGENTKIT_DSH_ROOT || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Specify isolated DSH source and homes');
const root = resolve(process.env.AGENTKIT_DSH_ROOT);
const profile = process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor';
const installed = join(resolve(process.env.DSH_HOME), 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio');
const installedSource = await realpath(installed);
const require = createRequire(join(root, 'apps/cli/package.json'));
const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
const { runProfile } = await import(pathToFileURL(join(root, 'apps/cli/lib/profile-boot.js')).href);
const Studio = (await import(pathToFileURL(join(installed, 'src/index.mjs')).href)).default;
const bridgeApi = await import(pathToFileURL(join(installed, 'src/host/runtime-bridge.mjs')).href);
const scratch = await mkdtemp(join(tmpdir(), 'studio-full-lifecycle-'));
const overlay = join(scratch, 'disable-studio.yml');
await writeFile(overlay, '- id: agentkit-studio\n  disabled: true\n');
const resources = new Map();
let observedResources = 0;
const asyncHook = createHook({
  init(id, type) {
    if (['Timeout', 'TCPWRAP', 'TCPCONNECTWRAP', 'PIPEWRAP'].includes(type) && new Error().stack?.includes(`${installedSource}/src/`)) {
      resources.set(id, type); observedResources++;
    }
  },
  destroy(id) { resources.delete(id); },
});
const report = { evidence: 'real-built-dsh-full-installed-studio-plugin', fullStudioPlugin: true, cycles: [], passed: false };
const stdout = process.stdout.write.bind(process.stdout);
// The launcher URL carries an ephemeral token. Retain no native launch output.
process.stdout.write = (_chunk, ...args) => { args.find(value => typeof value === 'function')?.(); return true; };
let running;
const counts = ctx => ({
  listeners: Object.fromEntries(Object.entries(ctx.events._hooks).filter(([, value]) => value.length).map(([key, value]) => [key, value.length])),
  exactRoutes: ctx.webServer.exact.size,
  prefixRoutes: ctx.webServer.prefixes.size,
  studioResources: [...resources.values()].sort(),
});
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 50)); };
try {
  running = await runProfile({ profile, environment: loadLayeredEnv('dsh', root), patchFiles: [overlay], args: ['--no-open', '--port', '0', '--host', '127.0.0.1'] });
  const ctx = running.ctx;
  await settle();
  const baseline = counts(ctx);
  report.baseline = baseline;
  asyncHook.enable();
  for (let index = 0; index < 20; index++) {
    const fiber = await ctx.plugin(Studio);
    assert.equal(fiber.state, 2, `full Studio cycle ${index} must activate`);
    const bridge = bridgeApi.resolveRuntimeBridge(ctx);
    assert.equal(bridge.diagnostics().closed, false);
    assert.equal(bridge.diagnostics().adapters, 1);
    assert.equal(bridge.diagnostics().executors, 1);
    assert.ok(ctx.webServer.prefixes.has('/agentkit'), 'complete Studio HTTP control-plane must be mounted');
    await fiber.dispose(); await fiber.dispose();
    await settle();
    assert.deepEqual(bridge.diagnostics(), { closed: true, adapters: 0, executors: 0, routes: 0, requests: 0 });
    const actual = counts(ctx);
    assert.deepEqual(actual, baseline, `full Studio cycle ${index} leaked owned listeners, routes or timers`);
    report.cycles.push({ cycle: index + 1, passed: true, resourcesReturnedToBaseline: true });
  }
  report.passed = true;
  report.observedOwnedAsyncResources = observedResources;
} catch (error) {
  report.failure = { code: String(error.code || 'ASSERTION_FAILED'), message: String(error.message).split(/\n/)[0].slice(0, 240) };
  process.exitCode = 1;
} finally {
  asyncHook.disable();
  await running?.shutdown.shutdown(process.exitCode || 0);
  process.stdout.write = stdout;
}
const output = resolve(process.argv[2] || '.artifacts/refactor/stage-1/studio-plugin-lifecycle.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
