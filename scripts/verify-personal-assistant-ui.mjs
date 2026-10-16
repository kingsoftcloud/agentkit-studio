/** Real Web Host and browser; a controlled ownership catalog relays to a real DSH runtime. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir, writeFile, cp, mkdtemp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendFileSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { assertDesktopDevResources, closeVerificationClient } from './desktop-dev-resources.mjs';
const require = createRequire(import.meta.url);
const { chromium, _electron } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));

export async function verifyPersonalAssistantUi({ source, installed, api, profiles, screenshot, port }) {
  const home = await mkdtemp(join(tmpdir(), 'assistant-web-'));
  const profile = join(home, 'dsh/profiles/assistant-ui');
  await mkdir(join(profile, 'node_modules/@kingsoftcloud'), { recursive: true });
  // Keep the complete installed dependency graph inside this Profile. DSH's
  // fallback resolver deliberately excludes a package owned by another Profile.
  const installedModules = dirname(dirname(installed));
  await cp(installedModules, join(profile, 'node_modules'), { recursive: true, dereference: false, mode: constants.COPYFILE_FICLONE });
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
      child.stderr.on('data', chunk => { appendFileSync(screenshot.replace(/\.png$/, '-host.log'), String(chunk).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]'), { mode: 0o600 }); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Web Host exited (${code}); see local Host diagnostic`)); });
    });
    return launch;
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const stopped = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer); child = null;
  };
  const open = async state => {
    let url;
    if (process.env.STUDIO_VERIFY_NATIVE === '1') {
      await assertDesktopDevResources({ source, primaryRuntime: process.env.STUDIO_VERIFY_PRIMARY_RUNTIME });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(KEY|SECRET|TOKEN|PASSWORD)/i.test(key)));
      Object.assign(env, { DSH_HOME: join(home, 'dsh'), AGENTKIT_HOME: join(home, 'agentkit'),
        DSH_DESKTOP_PRIMARY_RUNTIME_DIR: process.env.STUDIO_VERIFY_PRIMARY_RUNTIME, DSH_TELEMETRY_DISABLED: '1',
        DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_DESKTOP_PRODUCT_NAME: 'AgentKit Studio' });
      browser = await _electron.launch({ executablePath: process.env.STUDIO_VERIFY_ELECTRON,
        args: [`--user-data-dir=${join(home, 'electron-user-data')}`, join(source, 'apps/desktop')], cwd: source, env, timeout: 60000 });
      context = browser.context();
      const until = Date.now() + 30000;
      page = undefined;
      while (!page && Date.now() < until) {
        for (const candidate of browser.windows()) if (!candidate.isClosed() && await candidate.getByText('个人助理', { exact: true }).first().isVisible().catch(() => false)) { page = candidate; break; }
        if (!page) await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(page, 'native main window must load Studio');
    } else {
      url = await start();
      browser = await chromium.launch({ executablePath: process.env.STUDIO_VERIFY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
      context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...(state ? { storageState: state } : {}) });
      page = await context.newPage();
    }
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/agentkit/**', async route => {
      const body = route.request().postDataJSON();
      if (!body?.method?.startsWith('assistant/')) return route.continue();
      try {
        const value = body.method === 'assistant/catalog' ? { items: [{ metadata: { id: 'cloud-fixture', name: '云端助理验收' }, deployment: { id: 'fixture-deployment', versionId: 'fixture-version' }, spec: { runtime: { type: 'dsh-native' } } }] }
          : await api(body.payload.operation, body.payload.input);
        await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } } });
      } catch { await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'TEST_RELAY_FAILED', message: '验收连接失败' } } } }); }
    });
    if (url) await page.goto(url); else await page.reload();
    await page.getByText('个人助理', { exact: true }).first().click({ timeout: 30000 });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('agentkit.assistant.agent')) === 'cloud-fixture');
    assert.equal(await page.getByRole('tablist', { name: '助理功能' }).count(), 0, 'conversation opens without configuration tabs');
    assert.equal(await page.getByLabel('云端助理', { exact: true }).isVisible(), false, 'connection selector belongs in secondary settings');
    await page.getByLabel('发给助理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
  };
  try {
    await open();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-welcome.png'), fullPage: true });
    await page.getByLabel('发给助理', { exact: true }).fill('保留这份草稿');
    assert.equal(await page.getByRole('button', { name: '助理设置', exact: true }).count(), 0);
    await page.getByRole('button', { name: '助理连接信息', exact: true }).click();
    const connectionCard = page.getByRole('dialog', { name: '助理连接信息', exact: true });
    await connectionCard.getByRole('status').filter({ hasText: '本机已连接' }).waitFor();
    await connectionCard.getByText('云端助理尚未接入本机执行。', { exact: false }).waitFor();
    const offline = async route => {
      if (route.request().postDataJSON()?.method !== 'host/computer') return route.fallback();
      const body = route.request().postDataJSON();
      await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'HOST_UNAVAILABLE', message: 'controlled disconnect' } } } });
    };
    await page.route('**/agentkit/**', offline);
    await page.evaluate(() => window.dispatchEvent(new Event('agentkit-studio:connection-reset')));
    await page.getByRole('button', { name: '助理连接信息', exact: true }).filter({hasText:'本机连接已断开'}).waitFor();
    await page.unroute('**/agentkit/**', offline);
    await page.evaluate(() => window.dispatchEvent(new Event('agentkit-studio:connection-reset')));
    await connectionCard.getByRole('status').filter({ hasText: '本机已连接' }).waitFor();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-connection.png'), fullPage: true });
    await connectionCard.getByRole('button', { name: '在系统设置中管理助理', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('button', { name: '个人助理', exact: true }).click();
    await page.locator('[data-studio-assistant-settings]').waitFor();
    await page.getByLabel('云端助理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭并删除', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭并删除', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '关闭并删除个人助理', exact: true });
    await deletion.getByText('共享知识库和记忆库实例会保留。', { exact: false }).waitFor();
    await deletion.getByRole('button', { name: '取消', exact: true }).click();
    await deletion.waitFor({ state: 'hidden' });
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-settings.png'), fullPage: true });
    await page.locator('[data-studio-assistant-settings]').getByRole('button', { name: '计划任务', exact: true }).click();
    await page.getByLabel('任务名称', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('发给助理', { exact: true }).inputValue(), '保留这份草稿');
    await page.getByLabel('发给助理', { exact: true }).fill('browser task survives Studio Host exit');
    await page.getByLabel('发给助理', { exact: true }).press('Enter');
    await page.getByRole('status').filter({ hasText: '已收到。' }).waitFor({ timeout: 15000 });
    const state = await context.storageState();
    await closeVerificationClient(browser); browser = null; await stop();
    let complete = false;
    for (let i = 0; i < 100; i++) { const snapshot = await api('snapshot'); if (snapshot.status === 'completed' && snapshot.messages.some(item => item.text === 'browser task survives Studio Host exit')) { complete = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(complete, true);
    await open(state);
    await page.getByLabel('助理会话', { exact: true }).getByText('browser task survives Studio Host exit', { exact: true }).waitFor({ timeout: 15000 });
    assert.ok(await page.getByLabel('助理会话', { exact: true }).getByText('ASSISTANT_DONE', { exact: true }).count());
    await page.getByRole('heading', { name: 'Markdown 验收', exact: true }).waitFor();
    await page.getByRole('cell', { name: '已渲染', exact: true }).waitFor();
    await page.locator('pre code').filter({ hasText: 'console.log("studio");' }).waitFor();
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__studioMarkdownUnsafe === true), false);
    await page.screenshot({ path: screenshot, fullPage: true });
    const { verifyStudioCatalogUi } = await import('./verify-studio-catalog-ui.mjs');
    const catalog = await verifyStudioCatalogUi(page);
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-catalog.png'), fullPage: true });
    assert.deepEqual(errors, []);
    return { passed: true, catalog, nativeSystemSettings: true, deletionConfirmationCancelled: true, localComputerCard: true, connectionRecovers: true, nativeMarkdown: true, unsafeMarkdownBlocked: true, conversationFirst: true, autoSelectedSingleAssistant: true, draftSurvivesSettings: true, enterSends: true,
      localHostRestarted: true, clientRestarted: true, nativeElectron: process.env.STUDIO_VERIFY_NATIVE === '1', cloudRuntime: 'real-dsh', model: 'controlled', ownershipCatalog: 'controlled', rendererErrors: 0 };
  } catch (error) { await page?.screenshot({ path: screenshot.replace(/\.png$/, '-failure.png'), fullPage: true, timeout: 3000 }).catch(() => {}); throw error; }
  finally { try { await closeVerificationClient(browser); } finally { await stop(); } }
}
