/** Verify native and explicitly configured product builds through the shipped Web profile. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveProductInputs } from './product-config.mjs';
import { fingerprintPatchedSource } from './patched-source-fingerprint.mjs';

const { values } = parseArgs({ options: Object.fromEntries(['source', 'mode', 'report'].map(name => [name, { type: 'string' }])) });
if (!values.source || !['native', 'product'].includes(values.mode) || !values.report) throw new Error('usage: verify-dsh-product-presentation.mjs --source <built DSH> --mode <native|product> --report <json>');
const source = resolve(values.source), output = resolve(values.report);
const build = JSON.parse(await readFile(join(source, '.dsh-build/client-build-environment.json'), 'utf8'));
const inputs = resolveProductInputs();
const expected = values.mode === 'product' ? JSON.parse(inputs.environment.DSH_CLIENT_LOCALE_OVERRIDES).conversation.en['hero.headline'] : 'Into the Unknown';
for (const name of ['DSH_CLIENT_LOCALE_OVERRIDES', 'DSH_CLIENT_BRAND_MARK_URL']) {
  assert.equal(build.environment[name], values.mode === 'native' ? undefined : inputs.environment[name], 'The actual built client must match the requested product mode');
}
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
const sourceIdentity = await fingerprintPatchedSource(source);
const home = await mkdtemp(join(tmpdir(), 'studio-product-web-'));
const report = { evidence: 'real-built-dsh-shipped-web-profile-without-studio-plugin', mode: values.mode, passed: false,
  source: sourceIdentity, clientArtifacts: build.artifacts, checks: [] };
let child, browser, page, stopped, phase = 'host-start';
try {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD|CERTUM|APPLE|CSC_)/i.test(name)));
  Object.assign(environment, { DSH_HOME: join(home, 'dsh'), AGENTKIT_HOME: join(home, 'agentkit') });
  child = spawn(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--profile', 'product-verification', '--from-default-profile', 'web',
    '--patch', join(source, 'apps/web/tests/pin-browse-picker.overlay.yml'), '--host', '127.0.0.1', '--port', '0', '--no-open'],
  { cwd: source, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  stopped = new Promise(accept => child.once('close', accept));
  const ready = new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Web profile did not become ready')), 60000);
    let text = '';
    child.stdout.on('data', chunk => {
      text += chunk;
      const match = text.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
      if (match) { clearTimeout(timer); text = ''; accept(match[1]); }
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('Web profile could not start')); });
    child.once('close', () => { clearTimeout(timer); reject(new Error('Web profile stopped before ready')); });
  });
  const errors = [];
  const url = await ready;
  const executablePath = process.env.STUDIO_VERIFY_CHROME || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage({ locale: 'en-US' });
  page.on('pageerror', error => errors.push(error.name));
  await page.goto(url);
  phase = 'first-render';
  await page.getByText(expected, { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  phase = 'native-preview-notice';
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true });
  await continueButton.waitFor({ state: 'visible', timeout: 20000 });
  await continueButton.click();
  phase = 'native-first-run-credential-guide';
  const configureLater = page.getByRole('button', { name: 'Configure later', exact: true });
  await configureLater.waitFor({ state: 'visible', timeout: 20000 });
  await configureLater.click();
  await configureLater.waitFor({ state: 'hidden' });
  phase = 'unobscured-product-presentation';
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 });
  await page.getByText(expected, { exact: true }).click({ trial: true });
  report.checks.push({ name: 'built-first-render-copy-without-product-plugin', passed: true });
  const hitbox = page.locator('[class*="fishHitbox"]');
  if (values.mode === 'native') {
    assert.equal(await hitbox.locator('svg path').count() > 0, true);
    assert.equal(await hitbox.locator('img').count(), 0);
    await page.getByText('Preview', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('[class*="previewBadge"]').count(), 1);
  } else {
    assert.equal(await hitbox.locator('img').getAttribute('src'), inputs.environment.DSH_CLIENT_BRAND_MARK_URL);
    assert.equal(await hitbox.locator('svg').count(), 0);
    assert.equal(await page.getByText('Preview', { exact: true }).count(), 0);
    assert.equal(await page.locator('[class*="previewBadge"]').count(), 0);
  }
  report.checks.push({ name: 'configured-or-native-first-render-mark', passed: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(await fingerprintPatchedSource(source), report.source, 'The real launch must preserve source identity');
  report.checks.push({ name: 'no-renderer-errors-or-source-mutation', passed: true });
  await mkdir(dirname(output), { recursive: true });
  await page.screenshot({ path: output.replace(/\.json$/, '.png'), fullPage: true });
  report.passed = true;
} catch (error) {
  report.failure = { phase, code: error.code || 'PRODUCT_PRESENTATION_FAILED', message: String(error.message).split('\n')[0].replace(/\?token=[A-Za-z0-9_-]+/g, '?token=[redacted]').slice(0, 220) };
  await mkdir(dirname(output), { recursive: true });
  await page?.screenshot({ path: output.replace(/\.json$/, '-failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (child && stopped) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(timer);
  }
  await rm(home, { recursive: true, force: true });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
