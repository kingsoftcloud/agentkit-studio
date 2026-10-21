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
import { ASSISTANT_UPLOAD_RPC_PATH } from '../src/contracts/assistant-attachments.mjs';
const require = createRequire(import.meta.url);
const { chromium, _electron } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));

export async function verifyPersonalAssistantUi({ source, installed, api, relay, attachmentFixture, profiles, screenshot, port }) {
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
  let setupFailureFixture = true;
  const setupFailureMessage = '云端入口的 TLS 证书校验失败；请检查证书链';
  const errors = [], promptAttempts = [], relayFailures = [], nativeLifecycle = [];
  let losePromptAck = false;
  const composer = () => page.getByRole('region', { name: '云端原生输入', exact: true });
  const input = () => composer().locator('[data-composer-input][role="textbox"]');
  const until = async (test, label) => {
    const limit = Date.now() + 15000;
    while (Date.now() < limit) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Browser assertion timed out: ' + label);
  };
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
      // Both Studio and native DSH assertions below use Chinese UI copy.
      // A fresh Linux browser otherwise selects English from navigator.languages.
      context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, ...(state ? { storageState: state } : {}) });
      page = await context.newPage();
    }
    page.on('pageerror', error => errors.push(error.message));
    await page.route(url => url.pathname.startsWith('/agentkit/') || url.pathname === ASSISTANT_UPLOAD_RPC_PATH, async route => {
      const body = route.request().postDataJSON();
      if (!body?.method?.startsWith('assistant/')) return route.continue();
      try {
        const result = setupFailureFixture && body.method === 'assistant/catalog' ? { ok: true, value: { items: [] } }
          : setupFailureFixture && body.method === 'assistant/setup-status' ? { ok: true, value: { state: 'STARTING', ready: false,
            message: setupFailureMessage, failure: { code: 'DEPLOYMENT_TLS_FAILED', message: setupFailureMessage } } }
          : await relay(body.method, body.payload);
        if (body.payload?.operation) nativeLifecycle.push({ operation: body.payload.operation, carrierId: body.payload.input?.carrierId, accepted: result.ok === true });
        const request = body.payload?.operation === 'native-call' && body.payload.input?.endpoint === 'session/prompt'
          ? body.payload.input.payload?.args?.request : null;
        if (request) {
          promptAttempts.push(JSON.parse(JSON.stringify(request)));
          if (losePromptAck && result.ok === true && result.value?.ok === true && result.value.value?.accepted === true) {
            losePromptAck = false;
            await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId,
              result: { ok: false, error: { code: 'TEST_ACK_LOST', message: '验收：云端已受理，首次回执丢失' } } } });
            return;
          }
        }
        await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId, result } });
      } catch (error) { relayFailures.push({ method: body.method, operation: body.payload?.operation, code: error.code || error.name }); await route.fulfill({ json: { type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'TEST_RELAY_FAILED', message: '验收连接失败' } } } }); }
    });
    if (url) await page.goto(url); else await page.reload();
    await page.getByText('个人助理', { exact: true }).first().click({ timeout: 30000 });
    if (setupFailureFixture) return;
    await waitForConversation();
  };
  const waitForConversation = async () => {
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('agentkit.assistant.agent')) === 'cloud-fixture');
    assert.equal(await page.getByRole('tablist', { name: '助理功能' }).count(), 0, 'conversation opens without configuration tabs');
    assert.equal(await page.getByLabel('云端助理', { exact: true }).isVisible(), false, 'connection selector belongs in secondary settings');
    // The maintained Host can deliver the session catalog and its UI modules
    // in separate turns. Wait on the actual native editor with a bounded
    // acceptance timeout instead of assuming the localStorage agent marker
    // means the graph has already mounted.
    await composer().waitFor({ timeout: 60000 });
    await input().waitFor({ timeout: 60000, state: 'visible' });
    assert.equal(await input().count(), 1, 'exactly one native DSH editor must be mounted');
    assert.equal(await input().getAttribute('contenteditable'), 'true');
    assert.equal(await page.getByLabel('发给助理', { exact: true }).count(), 0);
    const attachment = composer().getByRole('button', { name: '添加附件', exact: true });
    await attachment.waitFor();
    assert.equal(await attachment.count(), 1, 'one attachment entry belongs inside the native composer');
    assert.equal(await composer().locator('[data-composer-card] [data-assistant-native-attachment]').count(), 1);
    assert.equal(await composer().locator('input[type="file"]').count(), 1, 'only the native picker is mounted');
    for (const copy of ['原生输入已绑定云端会话', '云端原生连接已建立', '离开也没关系，回来可以接着聊。']) {
      assert.equal(await page.getByText(copy, { exact: false }).count(), 0, 'conversation must not show persistent implementation or reassurance copy');
    }
  };
  try {
    await open();
    const setupView = page.locator('[data-studio-assistant-setup]');
    await setupView.getByRole('heading', { name: '助理连接暂不可用', exact: true }).waitFor();
    assert.equal(await setupView.getByText(setupFailureMessage, { exact: true }).count(), 1, 'one failure must not render as both progress and alert');
    assert.equal(await setupView.getByRole('alert').count(), 1);
    assert.equal(await setupView.locator('[data-studio-assistant-spinner]').count(), 0, 'failed setup must stop spinning');
    await setupView.getByRole('button', { name: '查看运行中心', exact: true }).waitFor();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-setup-error.png'), fullPage: true });
    setupFailureFixture = false;
    await page.reload();
    await page.getByText('个人助理', { exact: true }).first().click({ timeout: 30000 });
    await waitForConversation();
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-welcome.png'), fullPage: true });
    await input().fill('保留这份草稿');
    await input().press('Escape');
    assert.equal(await input().textContent(), '保留这份草稿', 'native Escape dismissal preserves text');
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
    const diagnostics = page.locator('[data-assistant-connection-diagnostics]');
    assert.equal(await diagnostics.getAttribute('open'), null, 'connection diagnostics start collapsed');
    await diagnostics.locator('summary').click();
    await diagnostics.getByText('原生输入', { exact: true }).waitFor();
    await diagnostics.getByText('工作区读写', { exact: true }).waitFor();
    await diagnostics.locator('summary').click();
    await page.getByLabel('助理名字', { exact: true }).fill('小星');
    await page.getByLabel('如何称呼你', { exact: true }).fill('小夏');
    await page.getByRole('button', { name: '保存名字和称呼', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '名字和称呼已保存' }).waitFor();
    await page.getByRole('button', { name: '关闭并删除', exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭并删除', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '关闭并删除个人助理', exact: true });
    await deletion.getByText('共享知识库和记忆库实例会保留。', { exact: false }).waitFor();
    await deletion.getByRole('button', { name: '取消', exact: true }).click();
    await deletion.waitFor({ state: 'hidden' });
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-settings.png'), fullPage: true });
    const managerTask = await api('schedule-create', { spec: { title: '界面验收提醒', prompt: '原生任务详情验收', every_seconds: 3600 } });
    await page.locator('[data-studio-assistant-settings]').getByRole('button', { name: '计划任务', exact: true }).click();
    const taskManager = page.locator('[data-assistant-native-schedule]');
    await taskManager.getByRole('heading', { name: '自动化任务', exact: true }).waitFor();
    assert.equal(await page.getByLabel('延迟秒数', { exact: true }).count(), 0, 'Settings reuses native rule editing rather than a seconds-only form');
    await taskManager.getByRole('button', { name: '界面验收提醒', exact: true }).click();
    await taskManager.getByLabel('自动化任务名称', { exact: true }).fill('已修改的验收提醒');
    await taskManager.getByRole('button', { name: '保存修改', exact: true }).click();
    await until(async () => (await api('schedule-get', { id: managerTask.id })).item?.title === '已修改的验收提醒', 'native detail edit persists through complete-record comparison');
    await taskManager.getByRole('tab', { name: '任务运行记录', exact: true }).click();
    await until(async () => nativeLifecycle.some(call => call.operation === 'schedule-history' && call.accepted), 'native delivery history uses scoped cloud request');
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-schedule.png'), fullPage: true });
    await taskManager.getByRole('button', { name: '关闭详情', exact: true }).click();
    await api('schedule-delete', { id: managerTask.id });
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: '小星', exact: true }).waitFor();
    await page.getByRole('button', { name: '助理连接信息', exact: true }).click();
    await page.getByRole('dialog', { name: '助理连接信息', exact: true }).getByText('小星', { exact: true }).waitFor();
    await page.getByRole('button', { name: '助理连接信息', exact: true }).click();
    assert.equal(await input().textContent(), '保留这份草稿');
    const opensBeforeSwitch = nativeLifecycle.filter(call => call.operation === 'native-open' && call.accepted).length;
    const closesBeforeSwitch = nativeLifecycle.filter(call => call.operation === 'native-close' && call.accepted).length;
    await page.getByRole('button', { name: '助理连接信息', exact: true }).click();
    await page.getByRole('dialog', { name: '助理连接信息', exact: true }).getByRole('button', { name: '在系统设置中管理助理', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '个人助理', exact: true }).click();
    await page.getByLabel('云端助理', { exact: true }).selectOption('');
    await until(async () => nativeLifecycle.filter(call => call.operation === 'native-close' && call.accepted).length === closesBeforeSwitch + 1, 'deselecting the assistant closes its native carrier');
    assert.equal(await composer().count(), 0, 'old native composer is released when its assistant is deselected');
    await page.getByLabel('云端助理', { exact: true }).selectOption('cloud-fixture');
    await composer().waitFor({ timeout: 60000 });
    await input().waitFor({ timeout: 60000, state: 'visible' });
    await until(async () => nativeLifecycle.filter(call => call.operation === 'native-open' && call.accepted).length === opensBeforeSwitch + 1, 'reselecting the assistant opens a fresh native carrier');
    assert.equal((await input().textContent()).trim(), '', 'memory-only native drafts are released with their graph');
    assert.equal(await composer().locator('input[type="file"]').count(), 1);
    assert.equal(nativeLifecycle.some(call => /cancel-turn|^cancel$/.test(call.operation)), false, 'view lifecycle never cancels cloud work');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await waitForConversation();
    await input().fill('browser text send uses native command dismissal');
    await composer().getByRole('button', { name: '发送消息', exact: true }).click();
    await until(async () => promptAttempts.length === 1 && (await input().textContent()).trim() === '', 'plain text Send dismisses native command UI and commits');
    assert.deepEqual(promptAttempts[0].content, [{ type: 'text', text: 'browser text send uses native command dismissal' }]);
    await until(async () => (await api('snapshot')).status === 'completed', 'plain text task completes before attachment case');
    promptAttempts.length = 0;
    await input().fill('browser task survives Studio Host exit');
    const uploadResponse = page.waitForResponse(response => response.request().postDataJSON()?.payload?.operation === 'attachment-upload');
    // A lost upload or chooser must surface as this step's own assertion with
    // its real cause; an unhandled waiter rejection would kill the process
    // before the failure screenshot is captured.
    uploadResponse.catch(() => {});
    const picking = page.waitForEvent('filechooser');
    picking.catch(() => {});
    await composer().getByRole('button', { name: '添加附件', exact: true }).click();
    const chooser = await picking;
    await chooser.setFiles({ name: attachmentFixture.name, mimeType: 'text/plain', buffer: attachmentFixture.bytes });
    const uploadedResponse = await uploadResponse;
    assert.equal(new URL(uploadedResponse.url()).pathname, ASSISTANT_UPLOAD_RPC_PATH, 'attachments must use the dedicated authenticated upload ingress');
    const uploaded = await uploadedResponse.json();
    assert.deepEqual(relayFailures, [], 'production Host relay must accept the native upload');
    assert.equal(uploaded.result.ok, true, 'native attachment upload must succeed'); assert.equal(uploaded.result.value.attachment.name, attachmentFixture.name);
    assert.equal(uploaded.result.value.attachment.bytes, attachmentFixture.bytes.length);
    await until(() => composer().getByRole('button', { name: '发送消息', exact: true }).isEnabled(), 'native attachment receipt is ready');
    losePromptAck = true;
    await input().press('Enter');
    const confirm = composer().getByRole('button', { name: '确认提交', exact: true });
    await confirm.waitFor();
    await until(async () => !losePromptAck && await confirm.isEnabled(), 'first durable ACK is lost and explicit confirmation becomes available');
    assert.equal(promptAttempts.length, 1);
    assert.equal(promptAttempts[0].content.filter(part => part.type === 'file').length, 1);
    assert.equal(promptAttempts[0].content.find(part => part.type === 'file').receiptId, uploaded.result.value.receiptId, 'native submission must contain the exact uploaded cloud file receipt');
    await confirm.click(); await confirm.waitFor({ state: 'hidden' });
    await until(async () => (await input().textContent()).trim() === '', 'native ACK clears the accepted draft');
    assert.equal(promptAttempts.length, 2); assert.deepEqual(promptAttempts[1], promptAttempts[0], 'confirmation must retry the exact native request');
    const state = await context.storageState();
    await closeVerificationClient(browser); browser = null; await stop();
    let complete = false;
    for (let i = 0; i < 100; i++) { const snapshot = await api('snapshot'); if (snapshot.status === 'completed' && snapshot.messages.some(item => item.text === 'browser task survives Studio Host exit')) { complete = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(complete, true);
    const saved = await api('snapshot');
    assert.equal(saved.events.filter(event => event.type === 'user/message' && event.data.source?.rpcId === promptAttempts[0].requestId).length, 1, 'lost ACK retry must not duplicate durable input');
    await open(state);
    await page.getByRole('heading', { name: '小星', exact: true }).waitFor();
    await page.getByLabel('助理会话', { exact: true }).getByText('browser task survives Studio Host exit', { exact: true }).waitFor({ timeout: 15000 });
    assert.ok(await page.getByLabel('助理会话', { exact: true }).getByText('ASSISTANT_DONE', { exact: true }).count());
    await page.getByRole('heading', { name: 'Markdown 验收', exact: true }).last().waitFor();
    await page.getByRole('cell', { name: '已渲染', exact: true }).last().waitFor();
    await page.locator('pre code').filter({ hasText: 'console.log("studio");' }).last().waitFor();
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__studioMarkdownUnsafe === true), false);
    assert.equal(await page.getByText('原生会话展示暂不可用，正在显示已保存的文字记录。', { exact: true }).count(), 0);
    for (const tool of ['glob', 'read']) await page.getByRole('button', { name: `${tool} · 已完成`, exact: true }).waitFor();
    await page.getByRole('button', { name: 'read · 已完成', exact: true }).click();
    await page.getByLabel('工具：read', { exact: true }).getByText(attachmentFixture.bytes.toString('utf8').trim(), { exact: false }).waitFor();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: `下载文件：${attachmentFixture.name}`, exact: true }).click();
    const downloaded = await downloading, stream = await downloaded.createReadStream(), chunks = [];
    assert.ok(stream); for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), attachmentFixture.bytes, 'cloud download must preserve original native attachment bytes');
    await page.screenshot({ path: screenshot, fullPage: true });
    const { verifyStudioCatalogUi } = await import('./verify-studio-catalog-ui.mjs');
    const catalog = await verifyStudioCatalogUi(page);
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-catalog.png'), fullPage: true });
    assert.deepEqual(errors, []);
    return { passed: true, catalog, savedAssistantAndOwnerNames: true, renamedTitleAndDeviceCard: true, identitySurvivesClientRestart: true, nativeSystemSettings: true, deletionConfirmationCancelled: true, localComputerCard: true, connectionRecovers: true, nativeComposer: true, nativeReceiptUpload: true, nativeToolRead: true, nativeDownloadBytes: true, exactNativeAckRetry: true, nativeMarkdown: true, unsafeMarkdownBlocked: true, conversationFirst: true, conciseConversation: true, collapsedConnectionDiagnostics: true, oneNativeAttachmentPicker: true, autoSelectedSingleAssistant: true, draftSurvivesSettings: true, nativeTextSend: true, escapePreservesDraft: true, agentSwitchReleasesNativeGraph: true, enterSends: true,
      localHostRestarted: true, clientRestarted: true, nativeElectron: process.env.STUDIO_VERIFY_NATIVE === '1', cloudRuntime: 'real-dsh', model: 'controlled', ownershipCatalog: 'controlled', rendererErrors: 0 };
  } catch (error) { await page?.screenshot({ path: screenshot.replace(/\.png$/, '-failure.png'), fullPage: true, timeout: 3000 }).catch(() => {}); throw error; }
  finally { try { await closeVerificationClient(browser); } finally { await stop(); } }
}
