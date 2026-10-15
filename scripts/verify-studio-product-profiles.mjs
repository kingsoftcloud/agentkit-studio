/** Verify product profile migration through the assembled Desktop Host and its IPC lifecycle. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fingerprintPatchedSource } from './patched-source-fingerprint.mjs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveProductInputs } from './product-config.mjs';
import { withAssembledDesktopHost } from './assembled-desktop-host.mjs';

const studio = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: Object.fromEntries(['source', 'runtime', 'node', 'report'].map(name => [name, { type: 'string' }])) });
for (const name of ['source', 'runtime', 'node', 'report']) assert.ok(values[name], `Specify --${name}`);
const runtime = resolve(values.runtime), source = resolve(values.source), output = resolve(values.report);
const { createPluginProfile, readRuntimeProfileBundles } = await import(pathToFileURL(join(source, 'apps/desktop/lib/types/project-manager.js')).href);
const packagedManifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
const products = resolveProductInputs().environment.DSH_DESKTOP_PLUGIN_BUNDLES.split(',');
const defaults = readRuntimeProfileBundles(runtime), base = defaults.filter(name => !products.includes(name));
for (const product of products) assert.ok(packagedManifest.dsh?.profile?.bundles.includes(product), 'Product defaults must come from the actual assembled runtime');
const hostEntry = join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
const runtimeRequire = createRequire(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'));
const runtimeBoot = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href);
assert.ok(existsSync(hostEntry)); assert.ok(existsSync(values.node));
const require = createRequire(join(studio, 'package.json'));
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
const sourceIdentity = await fingerprintPatchedSource(source);
const runtimeDescriptor = await readFile(join(runtime, 'desktop-runtime.json'));
const installedStudio = join(runtime, 'node_modules/@kingsoftcloud/agentkit-studio');
const packagedFiles = {};
for (const name of ['package.json', 'src/index.mjs', 'dist/client.js']) {
  packagedFiles[name] = createHash('sha256').update(await readFile(join(installedStudio, name))).digest('hex');
}
const home = await mkdtemp(join(tmpdir(), 'studio-profile-proof-'));
const result = { evidence: 'real-desktop-profile-bootstrap-and-assembled-desktop-host', passed: false, source: sourceIdentity,
  runtimeDescriptorSha256: createHash('sha256').update(runtimeDescriptor).digest('hex'), packagedStudioFiles: packagedFiles, cases: [],
  limits: ['Calls the compiled Desktop profile initializer, then launches the assembled Desktop Host with its production runtime anchor and IPC lifecycle. Native Electron shell automatic startup and installed update remain separate acceptance.'] };
let browser;
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function save(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function bootstrap(profile, bundles) {
  const prior = process.env.DSH_DESKTOP_PLUGIN_BUNDLES;
  process.env.DSH_DESKTOP_PLUGIN_BUNDLES = '@fixture/launch-environment-must-not-enable';
  try { assert.deepEqual(readRuntimeProfileBundles(runtime), defaults); createPluginProfile(profile, bundles); }
  finally { if (prior === undefined) delete process.env.DSH_DESKTOP_PLUGIN_BUNDLES; else process.env.DSH_DESKTOP_PLUGIN_BUNDLES = prior; }
}
async function witness(profile) {
  const module = join(profile, 'node_modules/profile-witness');
  await mkdir(module, { recursive: true });
  await save(join(module, 'package.json'), { name: 'profile-witness', version: '0.0.0', type: 'module', exports: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } });
  await writeFile(join(module, 'cordis.patch.yml'), '- insert:\n    - id: profile-witness\n      name: profile-witness\n');
  await writeFile(join(module, 'index.mjs'), `import {writeFileSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
export const name='profile-witness';
export function apply(ctx){ctx.effect(()=>{const file=fileURLToPath(new URL('./active',import.meta.url));writeFileSync(file,'active');return()=>unlinkSync(file)})}
`);
  const manifest = await json(join(profile, 'package.json'));
  manifest.dependencies['profile-witness'] = '0.0.0';
  manifest.dsh.profile.bundles.push('profile-witness');
  await save(join(profile, 'package.json'), manifest);
  return join(module, 'active');
}
async function launch(caseRoot, active, marker) {
  const profile = join(caseRoot, 'dsh/profiles/desktop-agentkit-studio');
  const diagnostics = join(dirname(output), 'profile-diagnostics', `${basename(caseRoot)}-${Date.now()}.log`);
  (result.diagnosticFiles ??= []).push(diagnostics);
  const check = await withAssembledDesktopHost({ runtime, node: values.node, profile, diagnostics, environment: {
    DSH_HOME: join(caseRoot, 'dsh'), AGENTKIT_HOME: join(caseRoot, 'agentkit'), DSH_CLIENT_VERSION: packagedManifest.version,
  } }, async ({ url }) => {
    const context = await browser.newContext({ locale: 'en-US' });
    try {
      const page = await context.newPage(), rendererErrors = [];
      page.on('pageerror', error => rendererErrors.push(error.name));
      await page.goto(url);
      await page.locator('[class*="frame"]').first().waitFor({ state: 'visible', timeout: 60000 });
      const status = await page.evaluate(async () => {
        const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'settings/get', payload: {}, rpcId: 'profile-proof' }) });
        const type = response.headers.get('content-type');
        if (response.status !== 200) return { status: response.status, type };
        let message;
        try { message = await response.json(); } catch { return { status: response.status, type, json: false }; }
        return { status: response.status, type, json: true, ok: message.result?.ok === true };
      });
      (result.probes ??= []).push({ kind: basename(caseRoot), expectedActive: active, ...status });
      assert.equal(status.status, active ? 200 : 405, 'Active Studio must handle POST; the inactive native fallback rejects it');
      if (active) { assert.equal(status.ok, true); await page.locator('.studio-agent-trigger').waitFor({ state: 'attached', timeout: 60000 }); }
      else assert.equal(await page.locator('.studio-agent-trigger').count(), 0);
      if (marker) assert.equal(existsSync(marker), true, 'The existing user bundle must run in the real Host');
      assert.deepEqual(rendererErrors, [], 'The assembled profile must render without page errors');
      return { hostStatus: status.status, studioClientMounted: active, existingBundleActive: Boolean(marker), rendererErrors: rendererErrors.length };
    } finally { await context.close(); }
  });
  if (marker) assert.equal(existsSync(marker), false, 'The existing bundle must dispose its owned resource');
  return check;
}
try {
  const executablePath = process.env.STUDIO_VERIFY_CHROME || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
  for (const kind of ['native-bundles', 'new-product', 'existing-profile', 'user-disabled']) {
    const caseRoot = join(home, kind), profile = join(caseRoot, 'dsh/profiles/desktop-agentkit-studio');
    await bootstrap(profile, kind === 'new-product' || kind === 'user-disabled' ? defaults : base);
    let marker;
    if (kind === 'existing-profile' || kind === 'user-disabled') marker = await witness(profile);
    const retained = join(profile, 'retained-user-state.json'); await writeFile(retained, '{"fixture":"retained"}\n');
    const patch = join(profile, 'cordis.patch.yml');
    const patchBefore = await readFile(join(source, 'apps/web/tests/pin-browse-picker.overlay.yml'), 'utf8');
    await writeFile(patch, patchBefore);
    if (kind === 'existing-profile') await bootstrap(profile, defaults);
    if (kind === 'user-disabled') {
      const manifest = await json(join(profile, 'package.json'));
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => !products.includes(name));
      await save(join(profile, 'package.json'), manifest);
    }
    const checks = [];
    for (let restart = 0; restart < 2; restart++) {
      await bootstrap(profile, kind === 'native-bundles' ? base : defaults);
      const manifest = await json(join(profile, 'package.json'));
      const active = !['native-bundles', 'user-disabled'].includes(kind);
      const loaded = runtimeBoot.loadProfileDirectory('dsh', profile, join(runtime, 'package.json'));
      (result.profileViews ??= []).push({ kind, restart, bundles: manifest.dsh.profile.bundles,
        loadedBundles: loaded.layers.map(layer => layer.packageName), skipped: loaded.skippedBundles });
      for (const name of products) assert.equal(manifest.dsh.profile.bundles.includes(name), active);
      assert.equal(await readFile(patch, 'utf8'), patchBefore);
      assert.equal(await readFile(retained, 'utf8'), '{"fixture":"retained"}\n');
      checks.push({ restart: restart + 1, ...await launch(caseRoot, active, marker) });
      assert.equal(await readFile(patch, 'utf8'), patchBefore);
      assert.equal(await readFile(retained, 'utf8'), '{"fixture":"retained"}\n');
      if (marker) assert.equal((await json(join(profile, 'package.json'))).dependencies['profile-witness'], '0.0.0');
    }
    result.cases.push({ kind, checks, passed: true });
  }
  assert.deepEqual(await fingerprintPatchedSource(source), sourceIdentity, 'Profile verification must preserve the DSH source');
  result.passed = true;
} catch (error) { result.failure = { code: error.code || 'PROFILE_ACCEPTANCE_FAILED', message: String(error.message).split('\n')[0].replace(/\?token=[A-Za-z0-9_-]+/g, '?token=[redacted]').slice(0, 220) }; process.exitCode = 1; }
finally { await browser?.close(); await rm(home, { recursive: true, force: true, maxRetries: 3 }); await mkdir(dirname(output), { recursive: true }); await save(output, result); }
console.log(JSON.stringify(result));
