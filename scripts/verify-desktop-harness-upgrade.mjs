/** Upgrade the signed plugin through the installed desktop UI, then continue the same conversation. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const [appPath, baseline, upgrade, output, windowsProfile] = process.argv.slice(2);
const versionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
assert.ok(appPath && output && versionPattern.test(baseline) && versionPattern.test(upgrade) && baseline !== upgrade,
  'Pass a packaged app, signed baseline and upgrade versions, and an evidence directory');
assert.ok(process.platform !== 'win32' || process.env.GITHUB_ACTIONS === 'true' || windowsProfile === '--disposable-windows-profile',
  'Windows qualification uses the default profile of a disposable Windows environment');
const executablePath = resolve(appPath.endsWith('.app') ? join(appPath, 'Contents/MacOS/AgentKit Studio') : appPath);
const state = await mkdtemp(join(tmpdir(), 'studio-harness-ui-'));
await mkdir(join(state, 'harness-qualification-workspace'));
const workspace = await realpath(join(state, 'harness-qualification-workspace'));
await mkdir(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CERTUM|PSMODULEPATH)/i.test(name) && !/^(?:DSH|AGENTKIT)_/u.test(name)));
Object.assign(env, { DSH_TELEMETRY_DISABLED: '1', AGENTKIT_TELEMETRY_DISABLED: '1', DSH_DESKTOP_OPEN_DEVTOOLS: '0' });
if (process.platform !== 'win32') Object.assign(env, { DSH_HOME: join(state, 'dsh'), AGENTKIT_HOME: join(state, 'agentkit') });

const firstModel = 'qualification-first', secondModel = 'qualification-second', credentialName = 'STUDIO_QUALIFICATION_FIXTURE';
const turns = [{ input: 'HARNESS_QUALIFICATION_FIRST', answer: 'HARNESS_FIXTURE_ACK_FIRST' },
  { input: 'HARNESS_QUALIFICATION_SWITCH', answer: 'HARNESS_FIXTURE_ACK_SWITCH' },
  { input: 'HARNESS_QUALIFICATION_RESTART', answer: 'HARNESS_FIXTURE_ACK_RESTART' },
  { input: 'HARNESS_QUALIFICATION_ROLLBACK', answer: 'HARNESS_FIXTURE_ACK_ROLLBACK' }];
const proof = { platform: process.platform, baseline, upgrade, checkpoints: [], modelRequests: [], processes: [], renderers: [] };
let releaseRollback;
const holdRollback = new Promise(resolve => { releaseRollback = resolve; });
const save = () => writeFile(join(output, 'evidence.json'), JSON.stringify(proof, null, 2) + '\n');
async function record(name) {
  proof.checkpoints.push(name);
  console.log(name);
  await save();
}
const model = createServer(async (request, response) => {
  if (request.url === '/v1/models') return response.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ object: 'list', data: [firstModel, secondModel].map(id => ({ id, object: 'model' })) }));
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return response.writeHead(400).end(); }
  const messages = JSON.stringify(body.messages ?? []);
  const turn = turns.findLast(entry => messages.includes(entry.input));
  const throughHarness = (body.tools ?? []).some(tool => tool.function?.name === 'read_workspace_file');
  proof.modelRequests.push({ input: turn?.input ?? null, model: body.model, throughHarness,
    hasFirstTurn: messages.includes(turns[0].input) });
  if (throughHarness && turn === turns[3]) await holdRollback;
  const content = turn?.answer ?? 'FIXTURE_READY';
  if (!body.stream) return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: 'fixture', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }));
  const frame = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk',
    model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(frame({ role: 'assistant', content }, null) + frame({}, 'stop') + 'data: [DONE]\n\n');
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));

const timeout = 120000;
const pluginControlTimeout = 30000;
const rendererRoute = '/api/agentkit.star-harness.client.mjs';
let app, page, identity;
async function boot() {
  app = await electron.launch({ executablePath, args: ['--user-data-dir=' + join(state, 'electron')], env, timeout });
  identity = await app.evaluate(({ app }) => ({ pid: process.pid, version: app.getVersion(), packaged: app.isPackaged,
    electron: process.versions.electron }));
  assert.equal(identity.packaged, true);
  page = await app.firstWindow({ timeout });
  await expect(page.locator('body')).toContainText('AgentKit Studio', { timeout });
}

async function quit() {
  if (!app) return;
  const { pid } = identity;
  const ids = new Set([pid, app.process()?.pid].filter(Boolean));
  let timer;
  const status = await Promise.race([app.close().then(() => 'closed', error => error.name),
    new Promise(resolve => { timer = setTimeout(() => resolve('timed out'), 40000); })]);
  clearTimeout(timer);
  const forced = [];
  for (const candidate of ids) {
    try { process.kill(candidate, 0); process.kill(candidate, 'SIGKILL'); forced.push(candidate); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  app = undefined;
  proof.processes.push({ ...identity, status, forced });
  await save();
  assert.equal(status, 'closed', 'The desktop process did not quit normally');
  assert.deepEqual(forced, [], 'Desktop processes were still alive after quitting');
}

async function rpc(method, payload = {}) {
  const result = await page.evaluate(async ({ method, payload }) => {
    for (const path of ['/agentkit', '/api/agentkit']) {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload, rpcId: method }) });
      if (!response.ok) continue;
      try { return (await response.json()).result; } catch { /* Try the authenticated fallback route. */ }
    }
  }, { method, payload });
  assert.equal(result?.ok, true, result?.error?.code ?? method);
  return result.value;
}

async function setModel(modelName) {
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  const profile = { id: 'default', displayName: 'Qualification fixture', provider: 'custom', modelName, baseUrl,
    credentialName, enabled: true, default: true, protocol: 'openai-chat' };
  await rpc('settings/update', { modelProvider: profile.provider, modelBaseUrl: baseUrl, modelName,
    modelProfiles: [profile], modelProfileKeys: { [credentialName]: 'local-fixture' } });
  await rpc('models/sync-credential');
  assert.equal((await rpc('settings/get')).modelProfiles?.[0]?.modelName, modelName);
  await page.reload();
  await expect(page.getByRole('button', { name: /^(智能体|Agents)$/ }).first()).toBeVisible({ timeout });
}

async function pluginPage() {
  const panel = page.getByRole('region', { name: 'StarOrigin Harness 管理' });
  if (!await panel.isVisible()) {
    await page.getByRole('button', { name: /^(插件|Plugins)$/ }).first().click({ timeout: 30000 });
    await page.getByText('StarOrigin Harness', { exact: true }).first().click({ timeout: 30000 });
  }
  await expect(panel).toBeVisible({ timeout: 30000 });
  return panel;
}

async function expandVersionList(panel) {
  const summary = panel.locator('[data-plugin-versions] button[aria-expanded]');
  if (await summary.getAttribute('aria-expanded', { timeout: pluginControlTimeout }) === 'false') await summary.click();
}

async function install(version, action) {
  let panel = await pluginPage();
  const label = action + '到 ' + version;
  const nativeList = panel.locator('[data-plugin-versions]');
  const native = await panel.getAttribute('data-plugin-detail') !== null;
  const control = (native ? nativeList : panel).getByRole('button', { name: label, exact: true });
  if (action === '升级') {
    await expect(panel.getByRole('button', { name: /^(检查更新|重新检查|Check again)$/ })).toBeEnabled({ timeout: pluginControlTimeout });
  }
  if (native) await expandVersionList(panel);
  await expect(control).toBeVisible({ timeout: pluginControlTimeout });
  await control.click({ timeout: pluginControlTimeout });
  if (action === '升级') {
    proof.selectedFromCatalog ??= {};
    proof.selectedFromCatalog[version] = true;
  }
  await expect.poll(async () => {
    try { return (await rpc('star-harness/status')).version; }
    catch (error) {
      if (!/Execution context was destroyed|Cannot find context|navigat/i.test(error.message)) throw error;
    }
  }, { timeout: 215000, intervals: [500, 1000, 1500] }).toBe(version);
  if (!await panel.isVisible()) panel = await pluginPage();
  if (native) await expandVersionList(panel);
  await expect(panel.locator('[aria-current="true"]')).toHaveText('v' + version, { timeout: 45000 });
  await page.screenshot({ path: join(output, 'plugin-' + version + (action.startsWith('回退') ? '-restored' : '') + '.png'), timeout: 60000 });
}

async function setHarnessEnabled(enabled) {
  await pluginPage();
  const toggle = page.getByRole('switch', { name: '启用 StarOrigin Harness' }).first();
  await expect(toggle).toHaveAttribute('aria-checked', String(!enabled));
  await Promise.all([page.waitForEvent('load', { timeout: 45000 }), toggle.click()]);
  await expect(page.getByRole('button', { name: /^(智能体|Agents)$/ }).first()).toBeVisible({ timeout });
  const status = await rpc('star-harness/status');
  assert.equal(status.enabled, enabled);
  return status;
}

async function createConversation() {
  await rpc('star-harness/bind', { workspace, profileId: 'default' });
  await rpc('star-harness/unbind', { workspace });
  const status = await setHarnessEnabled(true);
  assert.equal(status.canCreate, true);
  const title = status.workspaceChoices.find(entry => entry.path === workspace)?.title || basename(workspace);
  const picker = page.getByRole('button', { name: /^(选择工作区|Choose workspace)$/ });
  await expect(picker).toBeVisible({ timeout: 30000 });
  if ((await picker.innerText()).trim() !== title) {
    const conversation = page.locator('[data-conversation-session]');
    const selectedSession = await conversation.evaluateAll(rows => rows[0]?.getAttribute('data-conversation-session'));
    await picker.click();
    await page.getByRole('menuitem').filter({ hasText: title }).click({ timeout: 30000 });
    // The workspace label reflects a pending pick before DSH changes the
    // retained main Session, which is what Studio uses to admit an Agent.
    await expect.poll(async () => (await conversation.evaluateAll(rows => rows.map(row => row.getAttribute('data-conversation-session'))))
      .some(id => id && id !== selectedSession), { timeout: 30000 }).toBe(true);
  }
  await expect(picker).toHaveText(title, { timeout: 30000 });
  await page.getByRole('button', { name: /^(智能体|Agents)$/ }).first().click();
  const local = page.getByRole('button', { name: '我的智能体', exact: true });
  if (await local.isVisible()) await local.click();
  await page.getByRole('button', { name: '更多创建方式', exact: true }).click({ timeout: 30000 });
  await page.getByRole('menuitem', { name: '手动配置', exact: true }).click({ timeout: 30000 });
  await page.getByLabel('Agent ID', { exact: true }).fill('harness-qualification-agent');
  await page.getByLabel('名称', { exact: true }).fill('Harness qualification Agent');
  await page.locator('[role=radio][data-runtime=harness]').click({ timeout: 30000 });
  await page.getByPlaceholder('描述 Agent 的身份、边界和回答方式', { exact: true }).fill('Reply directly to the user.');
  const next = page.getByRole('button', { name: '下一步', exact: true });
  await next.click();
  const model = page.getByLabel('默认模型', { exact: true });
  if (await model.isVisible()) {
    const option = model.locator('option[value]:not([value=""])').first();
    await option.waitFor({ state: 'attached', timeout: 30000 });
    await model.selectOption(await option.getAttribute('value'));
  }
  await next.click();
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  const card = page.locator('[data-studio-agent-card]').filter({ hasText: 'Harness qualification Agent' });
  await card.hover({ timeout: 30000 });
  await card.getByRole('button', { name: '对话', exact: true }).click();
  const choice = page.getByRole('combobox', { name: 'StarOrigin Harness 工作区' });
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(choice.or(composer)).toBeVisible({ timeout: 40000 });
  if (await choice.isVisible()) {
    if (await choice.evaluate(element => element.tagName) === 'SELECT') await choice.selectOption(workspace);
    else {
      await choice.click();
      await page.getByRole('option').filter({ hasText: workspace }).first().click();
    }
    await page.getByRole('button', { name: '开始对话', exact: true }).click();
  }
  await expect(composer).toBeVisible({ timeout: 40000 });
}

async function submit(turn) {
  const composer = page.locator('[contenteditable="true"]').first();
  await composer.fill(turn.input);
  await composer.press('Enter');
}

async function checkAnswer(turn, modelName) {
  await expect(page.getByText(turn.answer, { exact: true }).last()).toBeVisible({ timeout: 90000 });
  assert.ok(proof.modelRequests.some(entry => entry.input === turn.input && entry.model === modelName
    && entry.throughHarness && entry.hasFirstTurn), 'The selected Harness model did not receive the expected conversation');
}

async function send(turn, modelName) {
  await submit(turn);
  await checkAnswer(turn, modelName);
}

async function checkRenderer(version) {
  await expect(page.getByTestId('studio-task-timeline')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => {
    const status = await rpc('star-harness/status');
    const runtime = status.workspaces.find(entry => entry.workspace === workspace);
    return { version: runtime?.version, running: runtime?.running };
  }, { timeout: 15000, message: 'The signed worker must be running for the selected workspace' })
    .toEqual({ version, running: true });
  const renderer = await page.evaluate(async route => {
    const response = await fetch(route + '?descriptor=1');
    if (!response.ok) throw Error('The active renderer descriptor is unavailable');
    const descriptor = await response.json();
    const href = route + '?sha256=' + descriptor.sha256;
    const asset = await fetch(href);
    if (!asset.ok) throw Error('The active renderer asset is unavailable');
    const digest = await crypto.subtle.digest('SHA-256', await asset.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const module = await import(href);
    return { descriptor, sha256, contract: module.contract, version: module.version };
  }, rendererRoute);
  assert.equal(renderer.version, version);
  assert.equal(renderer.contract, 'agentkit.studio-harness-ui/v1');
  assert.equal(renderer.sha256, renderer.descriptor.sha256);
  proof.renderers.push({ ...renderer, runningWorkspaceVersion: version });
}

async function reopenFirstConversation() {
  const original = page.locator('[data-row-key=' + JSON.stringify(proof.sessionRowKey) + ']');
  await original.click({ timeout: 30000 });
  await expect(page.locator('[data-conversation-session]').first()).toHaveAttribute('data-conversation-session',
    proof.sessionRowKey.slice('session:'.length), { timeout: 30000 });
  await expect(page.getByText(turns[0].answer, { exact: true }).last()).toBeVisible({ timeout: 30000 });
}

try {
  await boot();
  await setModel(firstModel);
  await quit();
  await boot();
  assert.notEqual(identity.pid, proof.processes.at(-1).pid);
  const opened = performance.now();
  const panel = await pluginPage();
  // The plugin page renders its sections from the `star-harness/status` RPC,
  // which reaches the signed release registry on a cold start. Playwright's
  // 5s default `expect` timeout is below that worst case on a loaded Windows
  // runner, and the components section is absent until the RPC resolves, so
  // every assertion here uses the same control timeout as the rest of the file.
  if (await panel.getAttribute('data-plugin-detail') !== null) {
    await expect(panel.getByRole('heading', { name: 'StarOrigin Harness', exact: true })).toBeVisible({ timeout: pluginControlTimeout });
    const image = panel.getByRole('img', { name: /金山云自研 Agent 运行框架/ });
    await expect(image).toBeVisible({ timeout: pluginControlTimeout });
    await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBeGreaterThan(0);
    // The detail page belongs to the Host's plugin manager, so its section
    // headings come from that UI's i18n (`partsLabel` is 包含的组件 in Chinese
    // and Components in English). Assert the section's stable data attribute
    // instead, so a runner that boots an English UI is not a false regression.
    await expect(panel.locator('[data-plugin-rows]')).toBeVisible({ timeout: pluginControlTimeout });
  } else {
    await expect(panel.getByRole('heading', { name: '关于 StarOrigin Harness' })).toBeVisible({ timeout: pluginControlTimeout });
    await expect(panel.getByText(/执行多步任务|AgentKit 里的多步任务/).first()).toBeVisible({ timeout: pluginControlTimeout });
    await expect(panel.getByRole('heading', { name: '包含的组件' })).toBeVisible({ timeout: pluginControlTimeout });
  }
  await page.screenshot({ path: join(output, 'plugin-overview.png'), timeout: 60000 });
  await expect(panel.getByRole('button', { name: /^(检查更新|重新检查|Check again)$/ })).toBeEnabled({ timeout: pluginControlTimeout });
  proof.firstPluginControlsMs = Math.round(performance.now() - opened);
  assert.equal(await page.evaluate(async route => {
    const response = await fetch(route + '?descriptor=1');
    return response.status === 404 ? null : response.json();
  }, rendererRoute), null);
  await record('Studio opened settings and plugin management before Harness UI installation');
  // The older fixture predates the recommended version shown on a fresh profile.
  const seeded = await rpc('star-harness/install', { version: baseline });
  assert.equal(seeded.version, baseline);
  await page.reload();
  const baselinePanel = await pluginPage();
  if (await baselinePanel.getAttribute('data-plugin-detail') !== null) await expandVersionList(baselinePanel);
  await expect(baselinePanel.locator('[aria-current="true"]')).toHaveText('v' + baseline, { timeout });
  await page.screenshot({ path: join(output, 'plugin-' + baseline + '.png'), timeout: 60000 });
  await record('The disposable profile started from the pinned signed baseline');
  await createConversation();
  await send(turns[0], firstModel);
  const original = page.getByRole('treeitem').filter({ hasText: new RegExp(turns[0].input + '|' + turns[0].answer, 'i') }).last();
  proof.sessionRowKey = await original.getAttribute('data-row-key');
  assert.match(proof.sessionRowKey, /^session:/);
  await checkRenderer(baseline);
  await record('The original conversation ran through the baseline engine and renderer');

  await setModel(secondModel);
  await reopenFirstConversation();
  await send(turns[1], secondModel);
  await record('The original process applied the new model to the existing conversation');
  await install(upgrade, '升级');
  await record('The plugin page installed the upgrade');
  await quit();
  await boot();
  assert.notEqual(identity.pid, proof.processes.at(-1).pid);
  const restartedPanel = await pluginPage();
  if (await restartedPanel.getAttribute('data-plugin-detail') !== null) await expandVersionList(restartedPanel);
  await expect(restartedPanel.locator('[aria-current="true"]')).toHaveText('v' + upgrade, { timeout });
  await reopenFirstConversation();
  await send(turns[2], secondModel);
  await checkRenderer(upgrade);
  await page.screenshot({ path: join(output, 'conversation-resumed.png'), timeout: 60000 });
  await record('The new process resumed the original conversation with the upgraded signed engine and renderer');

  await install(baseline, '回退');
  await reopenFirstConversation();
  await submit(turns[3]);
  await expect.poll(() => proof.modelRequests.some(entry => entry.input === turns[3].input && entry.throughHarness),
    { timeout: 90000 }).toBe(true);
  await pluginPage();
  const toggle = page.getByRole('switch', { name: '启用 StarOrigin Harness' }).first();
  await expect(toggle).toBeDisabled();
  releaseRollback();
  await expect(toggle).toBeEnabled({ timeout: 30000 });
  proof.unlockedAfterRun = true;
  await reopenFirstConversation();
  await checkAnswer(turns[3], secondModel);
  await checkRenderer(baseline);
  await record('The plugin page restored the prior signed release and the conversation continued');
  const disabled = await setHarnessEnabled(false);
  assert.equal(disabled.canCreate, false);
  assert.equal(disabled.workspaces.find(entry => entry.workspace === workspace)?.running, false);
  await expect(page.getByRole('button', { name: /^(智能体|Agents)$/ }).first()).toBeVisible();
  await record('Disabling Harness retired its workspace worker and Studio remained available');
} catch (error) {
  proof.error = error.message;
  await save();
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  // Keep the failure diagnosable from the job log alone. The evidence bundle
  // is part of a ~500 MB artifact, so nobody should have to download it just
  // to read one screenshot or one locator.
  try {
    const region = page?.getByRole('region', { name: /StarOrigin Harness/ });
    console.error(JSON.stringify({
      failedAt: String(error.message).split('\n')[0],
      pluginDetail: await region?.getAttribute('data-plugin-detail').catch(() => null),
      pluginRows: await region?.locator('[data-plugin-rows]').count().catch(() => -1),
      pluginText: (await region?.innerText({ timeout: 5000 }).catch(() => '')).slice(0, 600),
    }, null, 2));
  } catch { /* diagnostics must never mask the original failure */ }
  throw error;
} finally {
  releaseRollback();
  try { await quit(); }
  finally { await new Promise(resolve => { model.closeAllConnections(); model.close(resolve); }); }
}
