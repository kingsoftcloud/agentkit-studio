/** Native Electron development Host smoke check, using isolated test profiles. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyStudioNativeSidebar } from './verify-studio-native-sidebar-ui.mjs';
import { verifyStudioClientState } from './verify-studio-client-state-ui.mjs';
import { verifyStudioClientPages } from './verify-studio-client-pages-ui.mjs';
import { verifyStudioRouteFailures } from './verify-studio-route-failures-ui.mjs';
import { assertDesktopDevResources, closeVerificationClient } from './desktop-dev-resources.mjs';
const require = createRequire(import.meta.url);
const { _electron } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
if (!process.env.AGENTKIT_DSH_ROOT || !process.env.STUDIO_VERIFY_ELECTRON || !process.env.STUDIO_VERIFY_PRIMARY_RUNTIME || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Specify isolated source, homes, Electron executable and prepared primary runtime');
const source = resolve(process.env.AGENTKIT_DSH_ROOT);
await import('./build-client.mjs');
await assertDesktopDevResources({ source, primaryRuntime: process.env.STUDIO_VERIFY_PRIMARY_RUNTIME });
const installed = process.env.STUDIO_VERIFY_PLUGIN_ROOT
  ? resolve(process.env.STUDIO_VERIFY_PLUGIN_ROOT)
  : join(process.env.DSH_HOME, 'profiles', process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor', 'node_modules/@kingsoftcloud/agentkit-studio');
const shared = join(source, 'apps/desktop/.desktop-build/development/project/node_modules/@kingsoftcloud/agentkit-studio');
assert.equal(await realpath(shared), await realpath(installed), 'development shell must link the verified installed Studio');
const clientBundle = await readFile(join(installed, 'dist/client.js'));
assert.ok(clientBundle.equals(await readFile(new URL('../dist/client.js', import.meta.url))), 'native shell browser bundle must match worktree');
const clientSha256 = createHash('sha256').update(clientBundle).digest('hex');
const output = resolve(process.argv[2] || '.artifacts/refactor/stage-1/studio-desktop-dev.json');
await mkdir(dirname(output), { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'studio-refactor-electron-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|SECRET|TOKEN|PASSWORD|CERTUM|APPLE|CSC_)/i.test(key)));
Object.assign(env, { DSH_DESKTOP_PRIMARY_RUNTIME_DIR: process.env.STUDIO_VERIFY_PRIMARY_RUNTIME,
  DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_DESKTOP_PRODUCT_NAME: 'AgentKit Studio' });
const app = await _electron.launch({ executablePath: process.env.STUDIO_VERIFY_ELECTRON,
  args: [`--user-data-dir=${join(scratch, 'user-data')}`, join(source, 'apps/desktop')], cwd: source, env, timeout: 60000 });
const errors = [];
const sessionWarnings = [];
const warningJobs = [];
let sidebarChecks, stateChecks, pageChecks, routeFailureChecks;
try {
  let page;
  const deadline = Date.now() + 60000;
  while (!page && Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (!candidate.isClosed() && await candidate.locator('.studio-agent-trigger').isVisible().catch(() => false)) { page = candidate; break; }
    }
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(page, 'real Desktop main window must show the Studio Agent selector');
  page.on('pageerror', error => errors.push(String(error.name || 'RendererError')));
  page.on('console', message => {
    if (message.type() !== 'warning' || !/session.*failed/.test(message.text())) return;
    const job = Promise.all(message.args().map(arg => arg.evaluate(value => ({
      name: value?.name,
      code: value?.rpcError?.code,
      detailKeys: value?.rpcError?.details ? Object.keys(value.rpcError.details) : undefined,
    })).catch(() => ({})))).then(values => sessionWarnings.push(values));
    warningJobs.push(job);
  });
  const responses = await page.evaluate(async () => {
    const results = [];
    for (const method of ['models/credential-status', 'settings/get']) {
      const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, payload: {}, rpcId: method }) });
      const message = await response.json();
      results.push({ method, status: response.status, ok: message.result?.ok === true, code: message.result?.error?.code });
    }
    return results;
  });
  assert.ok(responses.every(result => result.status === 200 && result.ok), 'real Desktop renderer RPC must reach its own Host');
  assert.equal(errors.length, 0);
  const runtime = await app.evaluate(({ app }) => ({ electron: process.versions.electron, node: process.versions.node, appVersion: app.getVersion(), isPackaged: app.isPackaged }));
  assert.equal(runtime.isPackaged, false);
  sidebarChecks = process.env.STUDIO_VERIFY_NATIVE_SIDEBAR === '1'
    ? await verifyStudioNativeSidebar(page, JSON.parse(await readFile('.artifacts/refactor/stage-2/sidebar-seed.json', 'utf8')))
    : undefined;
  stateChecks = process.env.STUDIO_VERIFY_CLIENT_STATE === '1' ? await verifyStudioClientState(page) : undefined;
  pageChecks = process.env.STUDIO_VERIFY_CLIENT_PAGES === '1' ? await verifyStudioClientPages(page) : undefined;
  routeFailureChecks = process.env.STUDIO_VERIFY_ROUTE_FAILURES === '1' ? await verifyStudioRouteFailures(page) : undefined;
  assert.equal(errors.length, 0, 'the complete native UI flow must have no uncaught renderer errors');
  await page.screenshot({ path: output.replace(/\.json$/, '.png'), fullPage: true });
  const report = { evidence: process.env.STUDIO_VERIFY_PLUGIN_ROOT ? 'real-electron-development-shell-with-source-linked-studio' : 'real-electron-development-shell-with-built-dsh-and-installed-studio', fullStudioPlugin: true, developmentOnly: true,
    runtime, clientSha256, nativeAgentSelectorVisible: true, rendererRpc: responses, rendererErrors: errors.length, ...(sidebarChecks ? { sidebarChecks } : {}), ...(stateChecks ? { stateChecks } : {}), ...(pageChecks ? { pageChecks } : {}), ...(routeFailureChecks ? { routeFailureChecks } : {}), passed: true };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  await Promise.all(warningJobs);
  const report = { evidence: 'real-electron-development-shell-with-built-dsh-and-installed-studio', passed: false,
    message: String(error.message).split(/\n/)[0].slice(0, 200), rendererErrors: errors, sessionWarnings, sidebarChecks, stateChecks, pageChecks, routeFailureChecks, pageProgress: error.pageProgress, sidebarProgress: error.sidebarProgress, clickTrace: error.clickTrace };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  for (const [index, page] of app.windows().entries()) await page.screenshot({ path: output.replace(/\.json$/, `-failure-${index}.png`), fullPage: true, timeout: 3000 }).catch(() => {});
  console.log(JSON.stringify(report));
  process.exitCode = 1;
} finally { await closeVerificationClient(app); }
