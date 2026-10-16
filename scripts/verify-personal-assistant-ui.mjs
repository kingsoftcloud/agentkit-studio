/** Real Web Host and browser; a controlled ownership catalog relays to a real DSH runtime. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir, writeFile, symlink, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));

export async function verifyPersonalAssistantUi({ source, installed, api, profiles, screenshot, port }) {
  const home = await mkdtemp(join(tmpdir(), 'assistant-web-'));
  const profile = join(home, 'dsh/profiles/assistant-ui');
  await mkdir(join(profile, 'node_modules/@kingsoftcloud'), { recursive: true });
  await symlink(installed, join(profile, 'node_modules/@kingsoftcloud/agentkit-studio'));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'assistant-ui', private: true,
    dependencies: { '@kingsoftcloud/agentkit-studio': '0.0.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio'] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await mkdir(join(home, 'agentkit'));
  await writeFile(join(home, 'agentkit/config.yaml'), JSON.stringify({ modelProfiles: profiles,
    modelProfileKeys: { STUDIO_FROZEN_FIXTURE_KEY: 'synthetic-frozen-fixture' } }));
  let child, browser, context, page;
  const errors = [];
  const start = async () => {
    child = spawn(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--profile', 'assistant-ui', '--host', '127.0.0.1', '--no-open', '--port', String(port)], {
      cwd: source, env: { ...process.env, DSH_HOME: join(home, 'dsh'), AGENTKIT_HOME: join(home, 'agentkit') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const launch = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Web startup timeout')), 30000);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-10000); const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.stderr.resume(); child.once('exit', () => { clearTimeout(timer); reject(new Error('Web Host exited')); });
    });
    return launch;
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer); child = null;
  };
  const open = async state => {
    const url = await start();
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...(state ? { storageState: state } : {}) });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/agentkit/**', async route => {
      const body = route.request().postDataJSON();
      if (!body?.method?.startsWith('assistant/')) return route.continue();
      try {
        const value = body.method === 'assistant/catalog' ? { items: [{ metadata: { id: 'cloud-fixture', name: '云端助理验收' }, spec: { runtime: { type: 'dsh-native' } } }] }
          : await api(body.payload.operation, body.payload.input);
        await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } } });
      } catch { await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'TEST_RELAY_FAILED', message: '验收连接失败' } } } }); }
    });
    await page.goto(url);
    await page.getByText('个人助理', { exact: true }).first().click({ timeout: 30000 });
    await page.getByLabel('云端助理', { exact: true }).selectOption('cloud-fixture');
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  };
  try {
    await open();
    await page.getByLabel('发给助理', { exact: true }).fill('browser task survives Studio Host exit');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '云端已接收并保存' }).waitFor({ timeout: 15000 });
    const state = await context.storageState();
    await browser.close(); browser = null; await stop();
    let complete = false;
    for (let i = 0; i < 100; i++) { const snapshot = await api('snapshot'); if (snapshot.status === 'completed' && snapshot.messages.some(item => item.text === 'browser task survives Studio Host exit')) { complete = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(complete, true);
    await open(state);
    await page.getByLabel('助理会话', { exact: true }).getByText('browser task survives Studio Host exit', { exact: true }).waitFor({ timeout: 15000 });
    assert.ok(await page.getByLabel('助理会话', { exact: true }).getByText('ASSISTANT_DONE', { exact: true }).count());
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(errors, []);
    return { passed: true, desktopHostRestarted: true, browserRestarted: true, cloudRuntime: 'real-dsh', model: 'controlled', ownershipCatalog: 'controlled', rendererErrors: 0 };
  } finally { await browser?.close(); await stop(); }
}
