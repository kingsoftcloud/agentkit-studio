/** Exercise the official Web surface and actual installed Studio, without storing tokens. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { verifyStudioNativeSidebar } from './verify-studio-native-sidebar-ui.mjs';
import { verifyStudioClientState } from './verify-studio-client-state-ui.mjs';
import { verifyStudioClientPages } from './verify-studio-client-pages-ui.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
if (!process.env.AGENTKIT_DSH_ROOT || !process.env.DSH_HOME || !process.env.AGENTKIT_HOME) throw new Error('Specify isolated DSH source and homes');
const source = resolve(process.env.AGENTKIT_DSH_ROOT);
const profile = process.env.STUDIO_VERIFY_PROFILE || 'studio-refactor';
const installed = join(process.env.DSH_HOME, 'profiles', profile, 'node_modules/@kingsoftcloud/agentkit-studio');
assert.ok((await readFile(join(installed, 'dist/client.js'))).equals(await readFile(new URL('../dist/client.js', import.meta.url))), 'installed browser bundle must match worktree');
const seed = JSON.parse(await readFile('.artifacts/refactor/stage-2/sidebar-seed.json', 'utf8'));
assert.equal(seed.passed, true);
const output = resolve(process.argv[2] || '.artifacts/refactor/stage-2/native-sidebar-web.json');
const child = spawn(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--profile', profile, '--host', '127.0.0.1', '--no-open', '--port', '0'], { cwd: source, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const stopped = new Promise(resolve => child.once('exit', resolve));
let buffer = '', browser, page;
const rendererErrors = [];
const launch = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Web Host startup timeout')), 60000);
  child.stdout.on('data', chunk => {
    buffer += String(chunk);
    const match = buffer.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); buffer = ''; }
  });
  child.stderr.resume();
  child.once('exit', () => { clearTimeout(timer); reject(new Error('Web Host exited before ready')); });
});
await mkdir(dirname(output), { recursive: true });
try {
  browser = await chromium.launch({ executablePath: process.env.STUDIO_VERIFY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  page = await browser.newPage();
  page.on('pageerror', error => rendererErrors.push(String(error.name || 'RendererError')));
  await page.goto(await launch);
  const checks = await verifyStudioNativeSidebar(page, seed);
  const stateChecks = process.env.STUDIO_VERIFY_CLIENT_STATE === '1' ? await verifyStudioClientState(page) : undefined;
  const pageChecks = process.env.STUDIO_VERIFY_CLIENT_PAGES === '1' ? await verifyStudioClientPages(page) : undefined;
  assert.equal(rendererErrors.length, 0, 'the real renderer must complete without uncaught errors');
  await page.screenshot({ path: output.replace(/\.json$/, '.png'), fullPage: true });
  const report = { evidence: 'real-dsh-web-installed-studio-native-sidebar', checks, rendererErrors: rendererErrors.length, ...(stateChecks ? { stateChecks } : {}), ...(pageChecks ? { pageChecks } : {}), passed: true };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: output.replace(/\.json$/, '-failure.png'), fullPage: true }).catch(() => {});
  const report = { evidence: 'real-dsh-web-installed-studio-native-sidebar', passed: false, message: String(error.message).split(/\n/)[0].slice(0, 200), sidebarProgress: error.sidebarProgress, clickTrace: error.clickTrace };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); process.exitCode = 1;
} finally {
  await browser?.close(); buffer = '';
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer);
}
