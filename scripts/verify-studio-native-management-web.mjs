/** Full mounted Studio Agent management acceptance, controlled local model, actual Chrome.
 * Usage: node scripts/verify-studio-native-management-web.mjs --source <built DSH>
 *   --archive <fresh Studio.tgz> [--output <directory>]
 * Reuses the maintained DSH dependency graph, not a fresh package installation.
 * No browser API stubs, synthetic product records, cloud or Python runtime.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.source && values.archive, 'Specify --source and a fresh --archive');
const repository = fileURLToPath(new URL('..', import.meta.url)), source = resolve(values.source);
const root = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'studio-management-web-'));
await mkdir(root, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
const requests = [], modelFailures = [], rendererErrors = [];
const heldRequests = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
const heldReleases = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
let browser, page, child, stopped, phase = 'prepare';
const report = { evidence: 'full-mounted-studio-management-controlled-model', passed: false, checks: [] };
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'pinned', object: 'model', owned_by: 'local-fixture' }] })); return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    const approvalTurn = system.includes('APPROVAL_WEB_PROOF');
    const hiddenReasoningTurn = system.includes('HIDDEN_REASONING_WEB_PROOF');
    const marker = system.includes('MANAGEMENT_REVISION_THREE') ? 'MANAGEMENT_REVISION_THREE' : 'MANAGEMENT_REVISION_ONE';
    assert.ok(approvalTurn || hiddenReasoningTurn || system.includes(marker));
    requests.push({ marker: approvalTurn ? 'APPROVAL_WEB_PROOF' : hiddenReasoningTurn ? 'HIDDEN_REASONING_WEB_PROOF' : marker,
      inputTokens: 11, outputTokens: 7 });
    assert.ok(requests.length <= 9, 'Unexpected repeated model request');
    if (requests.length === 6) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('private-provider-error-body'); return;
    }
    if (approvalTurn) {
      assert.ok((body.tools || []).some(tool => (tool.function?.name || tool.name) === 'write_workspace_file'));
      const priorResults = body.messages.filter(message => message.role === 'tool').length;
      assert.ok(priorResults <= 1, 'Workspace write must not repeat');
      const delta = priorResults === 0
        ? { tool_calls: [{ index: 0, id: 'approval-web-call', type: 'function', function: {
          name: 'write_workspace_file', arguments: JSON.stringify({ path: 'approval-web.txt', content: 'approved once' }) } }] }
        : { reasoning_content: 'APPROVAL_PUBLIC_REASONING', content: 'APPROVAL_WEB_DONE' };
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end('data: ' + JSON.stringify({ id: 'approval-' + requests.length,
        choices: [{ index: 0, delta, finish_reason: priorResults === 0 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 } }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    if (hiddenReasoningTurn) {
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.end('data: ' + JSON.stringify({ id: 'hidden-reasoning-' + requests.length,
        choices: [{ index: 0, delta: { reasoning_content: 'HIDDEN_REASONING_PRIVATE', content: 'HIDDEN_REASONING_DONE' },
          finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    const heldIndex = requests.length - 3;
    if (heldIndex >= 0 && heldIndex < heldRequests.length) {
      heldRequests[heldIndex].resolve(); await heldReleases[heldIndex].promise;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end('data: ' + JSON.stringify({ id: 'management-' + requests.length,
      choices: [{ index: 0, delta: { content: marker + (requests.length === 3 ? '_RECONNECTED'
        : requests.length === 4 ? '_NETWORK_RECONNECTED'
          : requests.length === 5 ? '_SHOULD_NOT_APPEAR' : '_DONE') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7 } }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { modelFailures.push(error.message); res.writeHead(500); res.end('Local management fixture failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const home = join(root, 'home'), profile = 'management-proof', profileRoot = join(home, 'profiles', profile);
const installed = join(root, 'host/package'), graph = join(root, 'host/node_modules');
async function rpc(method, payload = {}) {
  return page.evaluate(async ({ method, payload }) => {
    const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload, rpcId: 'management-web-proof' }) });
    const result = (await response.json()).result;
    if (!result?.ok) throw Error(result?.error?.code || 'RPC_FAILED');
    return result.value;
  }, { method, payload });
}
try {
  await mkdir(join(root, 'host')); execFileSync('tar', ['-xzf', resolve(values.archive), '-C', join(root, 'host')]);
  report.archiveSha256 = createHash('sha256').update(await readFile(resolve(values.archive))).digest('hex');
  report.sourceSha256 = {};
  for (const file of ['dist/client.js', 'src/runtime-contract.mjs', 'src/authoring-defaults.mjs', 'src/agent-store.mjs', 'src/authoring-tools.mjs',
    'src/host/routes/agents.mjs', 'src/client/pages/agent-form.mjs', 'src/client/pages/agent-edit.mjs', 'src/client/pages/delivery.mjs']) {
    const packed = await readFile(join(installed, file)); assert.ok(packed.equals(await readFile(join(repository, file))), `Packed source differs: ${file}`);
    report.sourceSha256[file] = createHash('sha256').update(packed).digest('hex');
  }
  await mkdir(join(graph, '@deepseek-ai'), { recursive: true });
  for (const entry of await readdir(join(repository, 'node_modules'))) if (!entry.startsWith('.') && entry !== '@deepseek-ai')
    await symlink(join(repository, 'node_modules', entry), join(graph, entry));
  const dshPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const entry of await readdir(dshPackages)) await symlink(join(dshPackages, entry), join(graph, '@deepseek-ai', entry));
  const modules = join(profileRoot, 'node_modules');
  await mkdir(join(modules, '@kingsoftcloud'), { recursive: true });
  await symlink(join(graph, '@deepseek-ai'), join(modules, '@deepseek-ai'));
  await symlink(installed, join(modules, '@kingsoftcloud/agentkit-studio'));
  await writeFile(join(profileRoot, 'package.json'), JSON.stringify({ name: 'local-management-proof', private: true, type: 'module',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio'] } },
    dependencies: { '@deepseek-ai/dsh-base': '0.2.1-rc.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.2', '@kingsoftcloud/agentkit-studio': '0.0.2' } }));
  await writeFile(join(root, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
    modelName: 'pinned', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, default: true, credentialName: 'LOCAL_PROOF' },
  { id: 'fixture-hidden', provider: 'openai-compatible', modelName: 'pinned', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    credentialName: 'LOCAL_PROOF', parameters: { provider_thinking_display: false } }],
    modelProfileKeys: { LOCAL_PROOF: 'local-fixture-key' } }), { mode: 0o600 });
  const patch = join(root, 'proof.patch.yml');
  await writeFile(patch, ['- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
    '- id: workspace-controller', '  config:', `    documentsDirectory: ${JSON.stringify(join(root, 'Documents'))}`,
    '- insert:', '    - id: memory-web-proof', `      name: ${JSON.stringify(pathToFileURL(join(installed, 'tests/fixtures/studio-native-memory-web.mjs')).href)}`,
    '      config:', `        directory: ${JSON.stringify(root)}`, ''].join('\n'));
  const nodeBin = join(root, 'node-only-bin'); await mkdir(nodeBin); await symlink(process.execPath, join(nodeBin, 'node'));
  await mkdir(join(root, 'workspace'));
  phase = 'launch';
  child = spawn(process.execPath, [join(source, 'apps/cli/lib/bin.js'), '--profile', profile, '--patch', patch,
    '--host', '127.0.0.1', '--no-open', '--port', '0'], { cwd: root, env: { ...process.env, DSH_HOME: home,
      AGENTKIT_HOME: root, AGENTKIT_STUDIO_WORKSPACE: join(root, 'workspace'), PATH: nodeBin,
      AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk',
      DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(root, 'agents') }, stdio: ['ignore', 'pipe', 'pipe'] });
  stopped = new Promise(resolve => child.once('exit', resolve));
  let startup = '';
  child.stderr.resume();
  const launch = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Web startup timeout')), 60000);
    child.stdout.on('data', chunk => {
      startup = (startup + chunk).slice(-12000);
      const match = startup.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); startup = ''; }
    });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Web Host exited before startup')); });
  });
  browser = await chromium.launch({ executablePath: process.env.STUDIO_VERIFY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(20000); page.on('pageerror', error => rendererErrors.push(error.name));
  const url = await launch;
  await page.goto(url);
  await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 60000 });
  const prompt = target => target.getByPlaceholder('描述 Agent 的身份、边界和回答方式', { exact: true });
  const rowFor = target => target.getByRole('row').filter({ hasText: 'Management Web proof' });
  async function agents(target) {
    await target.getByText('智能体', { exact: true }).first().click();
    await target.getByRole('button', { name: '我的智能体', exact: true }).click();
    await rowFor(target).waitFor({ state: 'visible' });
  }
  async function review(target) { for (let i = 0; i < 3; i++) await target.getByRole('button', { name: '下一步', exact: true }).click(); }
  async function delivery(target) {
    await target.getByText('运行中心', { exact: true }).first().click();
    await target.getByRole('button', { name: '构建与部署', exact: true }).click();
    const select = target.getByLabel('目标 Agent', { exact: true });
    await select.locator('option[value="' + agentId + '"]').waitFor({ state: 'attached' });
    await select.selectOption(agentId);
  }
  assert.equal(await page.getByRole('alert').filter({ hasText: '无法创建默认工作区' }).count(), 0);
  phase = 'default-native-create';
  await page.getByText('智能体', { exact: true }).first().click();
  await page.getByRole('button', { name: '我的智能体', exact: true }).click();
  await page.getByRole('button', { name: '手动配置', exact: true }).click();
  assert.equal(await page.getByLabel('运行时').inputValue(), 'harness');
  assert.deepEqual((await page.getByLabel('运行时').locator('option').evaluateAll(items => items.map(item => item.value))).sort(), ['codex', 'dsh-native', 'harness']);
  await page.getByLabel('Agent ID', { exact: true }).fill('management-web-proof');
  await page.getByLabel('名称', { exact: true }).fill('Management Web proof');
  await prompt(page).fill('MANAGEMENT_REVISION_ONE: return your configured revision marker.');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const model = page.getByLabel('默认模型');
  await model.locator('option[value="fixture"]').waitFor({ state: 'attached' }); await model.selectOption('fixture');
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await rowFor(page).waitFor({ state: 'visible' });
  await page.getByLabel('搜索 Agent', { exact: true }).fill('Management Web proof');
  await rowFor(page).waitFor({ state: 'visible' });
  const list = await rpc('agents/list', { query: 'Management Web proof', source: 'local', page: 1, limit: 10 });
  assert.equal(list.items.length, 1); const agentId = list.items[0].metadata.id;
  const scope = { tenantId: 'local', userId: 'local-user', agentId,
    workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex') };
  const original = await rpc('agents/local-get', { agentId });
  assert.equal(original.spec.runtime.type, 'harness'); assert.equal(original.metadata.revision, 1);
  report.checks.push('new-form-defaults-to-native-and-retains-explicit-runtime-options');
  phase = 'build-original';
  await delivery(page);
  await page.getByRole('button', { name: '构建当前版本', exact: true }).click();
  await page.getByText('构建完成，已选中新版本，可以检查部署。', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  const built = await rpc('builds/list', { agentId });
  assert.equal(built.items.length, 1); const buildId = built.items[0].id;
  assert.equal(built.items[0].revision, 1); assert.equal(String(built.items[0].status).toUpperCase(), 'SUCCEEDED');
  report.checks.push('build-original-revision-through-product-ui');
  phase = 'two-editor-conflict';
  await agents(page); await rowFor(page).getByRole('button', { name: '编辑 Agent', exact: true }).click();
  assert.match(await prompt(page).inputValue(), /MANAGEMENT_REVISION_ONE/);
  const second = await page.context().newPage(); second.setDefaultTimeout(20000);
  second.on('pageerror', error => rendererErrors.push(error.name));
  await second.goto(url); await second.getByText('智能体', { exact: true }).first().waitFor({ state: 'visible', timeout: 60000 });
  await agents(second); await rowFor(second).getByRole('button', { name: '编辑 Agent', exact: true }).click();
  assert.match(await prompt(second).inputValue(), /MANAGEMENT_REVISION_ONE/);
  await prompt(second).fill('UNSAVED_SECOND_EDITOR_DRAFT');
  await prompt(page).fill('MANAGEMENT_REVISION_TWO: saved in the first editor.');
  await review(page); await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await rowFor(page).waitFor({ state: 'visible' });
  assert.equal((await rpc('agents/local-get', { agentId })).metadata.revision, 2);
  await review(second); await second.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await second.getByText(/Agent 已被其他窗口更新/).waitFor({ state: 'visible' });
  assert.equal((await rpc('agents/local-get', { agentId })).metadata.revision, 2, 'Conflict must not publish a revision');
  await second.getByRole('button', { name: /1\. 定义 Agent/ }).click();
  assert.equal(await prompt(second).inputValue(), 'UNSAVED_SECOND_EDITOR_DRAFT');
  await second.screenshot({ path: join(root, 'conflict.png'), fullPage: true });
  report.checks.push('stale-editor-cannot-overwrite-and-unsaved-draft-is-preserved');
  phase = 'reload-and-reapply';
  await second.getByRole('button', { name: '读取最新版本', exact: true }).click();
  await prompt(second).waitFor({ state: 'visible' });
  assert.match(await prompt(second).inputValue(), /MANAGEMENT_REVISION_TWO/);
  await prompt(second).fill('MANAGEMENT_REVISION_THREE: return your configured revision marker.');
  await review(second); await second.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await rowFor(second).waitFor({ state: 'visible' });
  const current = await rpc('agents/local-get', { agentId });
  assert.equal(current.metadata.revision, 3); assert.match(current.spec.instructions.system, /MANAGEMENT_REVISION_THREE/);
  await rowFor(second).getByText('r3', { exact: true }).waitFor({ state: 'visible' });
  await rowFor(second).getByText('有历史构建', { exact: true }).waitFor({ state: 'visible' });
  await second.screenshot({ path: join(root, 'current-revision.png'), fullPage: true });
  report.checks.push('explicit-refresh-loads-latest-revision-and-reapplied-edit-publishes-r3');
  phase = 'frozen-build-execution';
  await delivery(page);
  await page.getByText('构建历史（1）', { exact: true }).click();
  const buildRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: '在新会话运行', exact: true }) });
  await buildRow.getByText('版本 1', { exact: true }).waitFor({ state: 'visible' });
  await buildRow.getByRole('button', { name: '在新会话运行', exact: true }).click();
  const trigger = page.locator('.studio-agent-trigger').filter({ hasText: 'Management Web proof' });
  await trigger.waitFor({ state: 'visible' }); const frozenSessionId = await trigger.getAttribute('data-studio-session-id'); assert.ok(frozenSessionId);
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await composer.fill('Report the configured revision.'); await composer.press('Enter');
  await page.getByText('MANAGEMENT_REVISION_ONE_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.reload(); await page.getByText('MANAGEMENT_REVISION_ONE_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.screenshot({ path: join(root, 'frozen-build-run.png'), fullPage: true });
  report.checks.push('old-build-runs-frozen-r1-after-r3-edit-and-history-survives-reload');
  phase = 'current-revision-execution';
  await agents(page); await rowFor(page).getByRole('button', { name: '绑定到新会话', exact: true }).click();
  await trigger.waitFor({ state: 'visible' }); const currentSessionId = await trigger.getAttribute('data-studio-session-id');
  assert.ok(currentSessionId && currentSessionId !== frozenSessionId);
  await composer.fill('Report the configured revision.'); await composer.press('Enter');
  await page.getByText('MANAGEMENT_REVISION_THREE_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.reload(); await page.getByText('MANAGEMENT_REVISION_THREE_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.screenshot({ path: join(root, 'current-run.png'), fullPage: true });
  phase = 'live-reconnect';
  await composer.fill('Continue this session after I reopen the page.'); await composer.press('Enter');
  let heldTimer;
  try {
    await Promise.race([heldRequests[0].promise, new Promise((_, reject) => {
      heldTimer = setTimeout(() => reject(Error('Third model request did not start')), 30000);
    })]);
  } finally { clearTimeout(heldTimer); }
  await page.reload();
  await page.getByText('Continue this session after I reopen the page.', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByText('Management Web proof', { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page.getByText('MANAGEMENT_REVISION_THREE_RECONNECTED', { exact: true }).count(), 0,
    'The held model response has not yet arrived');
  heldReleases[0].resolve();
  await page.getByText('MANAGEMENT_REVISION_THREE_RECONNECTED', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.reload();
  await page.getByText('MANAGEMENT_REVISION_THREE_RECONNECTED', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.screenshot({ path: join(root, 'live-reconnected-run.png'), fullPage: true });
  report.checks.push('running-native-turn-survives-browser-reload-and-resumes-in-same-session');
  phase = 'network-reconnect';
  await composer.fill('Continue this session after a temporary network outage.'); await composer.press('Enter');
  let networkTimer;
  try {
    await Promise.race([heldRequests[1].promise, new Promise((_, reject) => {
      networkTimer = setTimeout(() => reject(Error('Fourth model request did not start')), 30000);
    })]);
  } finally { clearTimeout(networkTimer); }
  await page.context().setOffline(true);
  assert.equal(await page.evaluate(() => navigator.onLine), false);
  heldReleases[1].resolve();
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')));
  let completedOffline = false;
  for (let attempt = 0; attempt < 100 && !completedOffline; attempt++) {
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    try {
      const rows = store.list(scope, currentSessionId);
      completedOffline = rows.length === 3 && rows.every(row => store.load(scope, row.runId).snapshot.phase === 'completed');
    } finally { store.close(); }
    if (!completedOffline) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(completedOffline, true, 'The Native turn must settle durably while the browser is offline');
  await page.context().setOffline(false);
  await page.getByText('MANAGEMENT_REVISION_THREE_NETWORK_RECONNECTED', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.reload();
  await page.getByText('MANAGEMENT_REVISION_THREE_NETWORK_RECONNECTED', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.screenshot({ path: join(root, 'network-reconnected-run.png'), fullPage: true });
  report.checks.push('physical-browser-network-outage-recovers-durable-native-answer-without-reexecution');
  phase = 'product-cancel';
  await composer.fill('Stop this active task before the model responds.'); await composer.press('Enter');
  let cancelTimer;
  try {
    await Promise.race([heldRequests[2].promise, new Promise((_, reject) => {
      cancelTimer = setTimeout(() => reject(Error('Fifth model request did not start')), 30000);
    })]);
  } finally { clearTimeout(cancelTimer); }
  const stopButton = page.getByRole('button', { name: '停止生成', exact: true });
  await stopButton.waitFor({ state: 'visible', timeout: 30000 });
  await stopButton.click();
  await page.getByText('已停止', { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  heldReleases[2].resolve();
  await stopButton.waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.getByText('MANAGEMENT_REVISION_THREE_SHOULD_NOT_APPEAR', { exact: true }).count(), 0);
  await page.reload();
  await page.getByText('已停止', { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
  await page.screenshot({ path: join(root, 'stopped-native-run.png'), fullPage: true });
  report.checks.push('product-stop-button-cancels-native-run-and-history-retains-terminal');
  phase = 'product-failure-visibility';
  await composer.fill('Show the configured model failure safely.'); await composer.press('Enter');
  let failedRun = false;
  for (let attempt = 0; attempt < 100 && !failedRun; attempt++) {
    const store = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
    try {
      const rows = store.list(scope, currentSessionId);
      failedRun = rows.length === 5 && store.load(scope, rows.at(-1).runId).snapshot.phase === 'failed';
    } finally { store.close(); }
    if (!failedRun) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(failedRun, true, 'The failed Run must be durable before displaying its public error');
  const inspectRun = async () => {
    await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
    await page.getByText('模型服务返回不可恢复的错误，请检查模型配置和凭据。', { exact: true })
      .waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.getByText('private-provider-error-body', { exact: false }).count(), 0);
  };
  await inspectRun(); await page.screenshot({ path: join(root, 'failed-native-run.png'), fullPage: true });
  await page.reload(); await inspectRun();
  report.checks.push('provider-failure-is-durable-and-shows-only-public-terminal-message-after-reload');
  phase = 'product-approval';
  const approvalPolicy = { contract: 'agentkit.native-agent-policy/v1', mode: 'strict', rules: {} };
  const approvalAgent = await rpc('agents/create-local', { name: 'Approval Web proof', runtimeType: 'harness',
    spec: { runtime: { type: 'harness' }, instructions: { system: 'APPROVAL_WEB_PROOF: write the requested scratch file.' },
      execution: { nativeTodoMode: 'off', nativePlanMode: 'off', nativeToolSearchMode: 'off' },
      bindings: { modelProfileIds: ['fixture'], tools: ['read_workspace_file', 'write_workspace_file', 'edit_workspace_file'] } },
    bindings: { modelProfileIds: ['fixture'], tools: ['read_workspace_file', 'write_workspace_file', 'edit_workspace_file'] } });
  assert.deepEqual(approvalAgent.spec.bindings.nativeAgentPolicy, approvalPolicy,
    'the authenticated create route pins the default strict Native policy');
  const approvalAgentId = approvalAgent.metadata.id;
  await page.reload();
  await page.getByText('智能体', { exact: true }).first().click();
  await page.getByRole('button', { name: '我的智能体', exact: true }).click();
  await page.getByLabel('搜索 Agent', { exact: true }).fill('Approval Web proof');
  const approvalRow = page.getByRole('row').filter({ hasText: 'Approval Web proof' });
  await approvalRow.waitFor({ state: 'visible' });
  await approvalRow.getByRole('button', { name: '绑定到新会话', exact: true }).click();
  const approvalTrigger = page.locator('.studio-agent-trigger').filter({ hasText: 'Approval Web proof' });
  await approvalTrigger.waitFor({ state: 'visible' });
  const approvalSessionId = await approvalTrigger.getAttribute('data-studio-session-id');
  assert.ok(approvalSessionId);
  await composer.fill('Write approval-web.txt with approved once.'); await composer.press('Enter');
  const approvalPanel = page.locator('[data-approval-key]');
  await approvalPanel.waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await approvalPanel.innerText(), /write_workspace_file/);
  await page.reload();
  await approvalPanel.waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await approvalPanel.locator('button').count(), 2);
  await approvalPanel.locator('button').last().click();
  await page.getByText('APPROVAL_WEB_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  const reasoningRow = page.locator('[data-variant="think"]').filter({ hasText: 'APPROVAL_PUBLIC_REASONING' });
  await reasoningRow.waitFor({ state: 'attached', timeout: 30000 });
  assert.equal(await readFile(join(root, 'workspace/approval-web.txt'), 'utf8'), 'approved once');
  await page.reload(); await page.getByText('APPROVAL_WEB_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await reasoningRow.waitFor({ state: 'attached', timeout: 30000 });
  assert.equal(await approvalPanel.count(), 0);
  report.checks.push('strict-native-approval-survives-reload-and-ui-answer-executes-once');
  phase = 'private-reasoning-hidden';
  const hiddenAgent = await rpc('agents/create-local', { name: 'Hidden Reasoning Web proof', runtimeType: 'harness',
    spec: { runtime: { type: 'harness' }, instructions: { system: 'HIDDEN_REASONING_WEB_PROOF: return the answer.' },
      execution: { nativeTodoMode: 'off', nativePlanMode: 'off', nativeToolSearchMode: 'off' },
      bindings: { modelProfileIds: ['fixture-hidden'] } }, bindings: { modelProfileIds: ['fixture-hidden'] } });
  const hiddenAgentId = hiddenAgent.metadata.id;
  await page.getByText('智能体', { exact: true }).first().click();
  await page.getByRole('button', { name: '我的智能体', exact: true }).click();
  await page.getByLabel('搜索 Agent', { exact: true }).fill('Hidden Reasoning Web proof');
  const hiddenRow = page.getByRole('row').filter({ hasText: 'Hidden Reasoning Web proof' });
  await hiddenRow.waitFor({ state: 'visible' });
  await hiddenRow.getByRole('button', { name: '绑定到新会话', exact: true }).click();
  const hiddenTrigger = page.locator('.studio-agent-trigger').filter({ hasText: 'Hidden Reasoning Web proof' });
  await hiddenTrigger.waitFor({ state: 'visible' });
  const hiddenSessionId = await hiddenTrigger.getAttribute('data-studio-session-id');
  assert.ok(hiddenSessionId);
  await composer.fill('Return the answer.'); await composer.press('Enter');
  await page.getByText('HIDDEN_REASONING_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page.getByText('HIDDEN_REASONING_PRIVATE', { exact: false }).count(), 0);
  await page.reload(); await page.getByText('HIDDEN_REASONING_DONE', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page.getByText('HIDDEN_REASONING_PRIVATE', { exact: false }).count(), 0);
  report.checks.push('profile-disabled-provider-reasoning-stays-private-before-and-after-reload');
  assert.deepEqual(modelFailures, []); assert.deepEqual(rendererErrors, []);
  assert.deepEqual(requests.map(item => item.marker), ['MANAGEMENT_REVISION_ONE', 'MANAGEMENT_REVISION_THREE', 'MANAGEMENT_REVISION_THREE',
    'MANAGEMENT_REVISION_THREE', 'MANAGEMENT_REVISION_THREE', 'MANAGEMENT_REVISION_THREE', 'APPROVAL_WEB_PROOF', 'APPROVAL_WEB_PROOF',
    'HIDDEN_REASONING_WEB_PROOF']);
  assert.equal(await readFile(join(root, 'legacy-loop.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }), '');
  phase = 'durable-version-bindings';
  const ledger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  try {
    const frozenRows = ledger.list(scope, frozenSessionId), currentRows = ledger.list(scope, currentSessionId);
    assert.equal(frozenRows.length, 1); assert.equal(currentRows.length, 5, 'Reconnect, cancellation and failure have independent durable Runs');
    const runs = [...frozenRows, ...currentRows].map(row => ledger.load(scope, row.runId));
    assert.deepEqual(runs.map(run => run.configuration.hostRecoveryBinding.agentRevision), [1, 3, 3, 3, 3, 3]);
    assert.ok(runs.every(run => run.configuration.engine === 'agentkit.native/v1'));
    assert.deepEqual(runs.map(run => run.snapshot.phase), ['completed', 'completed', 'completed', 'completed', 'canceled', 'failed']);
    assert.deepEqual(runs.slice(0, 4).map(run => run.snapshot.usage.modelCalls), [1, 1, 1, 1]);
    assert.ok(runs[4].snapshot.usage.modelCalls <= 1, 'Cancelled request does not issue a second model call');
    assert.equal(runs[0].snapshot.buildId, buildId);
    assert.equal(runs[0].configuration.hostRecoveryBinding.buildId, buildId);
    assert.equal(runs[1].configuration.hostRecoveryBinding.buildId, null);
    assert.match(runs[1].snapshot.buildId, /^revision-[a-f0-9]{64}$/);
    assert.equal(runs[2].configuration.hostRecoveryBinding.buildId, null);
    assert.equal(runs[2].snapshot.parentRunId, runs[1].snapshot.runId, 'Reconnected continuation retains the original Run');
    assert.equal(runs[3].snapshot.parentRunId, runs[2].snapshot.runId, 'Network-reconnected continuation retains the prior Run');
    assert.equal(runs[4].snapshot.parentRunId, runs[3].snapshot.runId, 'Cancelled Run retains its parent');
    assert.equal(runs[5].snapshot.parentRunId, runs[4].snapshot.runId, 'Failed Run retains its parent');
    assert.equal(runs[5].snapshot.reason, 'provider_terminal_error');
    assert.equal(runs[5].snapshot.usage.modelCalls, 1, 'Failed request is accounted once');
    const approvalScope = { ...scope, agentId: approvalAgentId };
    const approvalRows = ledger.list(approvalScope, approvalSessionId);
    assert.equal(approvalRows.length, 1);
    const approvalRun = ledger.load(approvalScope, approvalRows[0].runId);
    assert.equal(approvalRun.snapshot.phase, 'completed');
    assert.equal(approvalRun.snapshot.usage.modelCalls, 2);
    assert.equal(approvalRun.snapshot.usage.toolCalls, 1);
    assert.equal(approvalRun.configuration.hostRecoveryBinding.agentRevision, 1);
    const approvalSessionFile = (await readdir(join(root, 'sessions'), { recursive: true }))
      .find(file => file.endsWith('.jsonl') && file.includes(approvalSessionId));
    assert.ok(approvalSessionFile, 'The answered approval must have a durable Session history');
    const approvalEvents = (await readFile(join(root, 'sessions', approvalSessionFile), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    const asked = approvalEvents.filter(event => event.type === 'approval/asked');
    const decided = approvalEvents.filter(event => event.type === 'approval/decided');
    assert.equal(asked.length, 1); assert.equal(decided.length, 1);
    assert.equal(asked[0].data.toolName, 'write_workspace_file');
    assert.equal(decided[0].data.id, asked[0].data.id);
    assert.equal(decided[0].data.outcome, 'allowed-once');
    assert.doesNotMatch(asked[0].data.reason, /approval-web\.txt|approved once/);
    const hiddenScope = { ...scope, agentId: hiddenAgentId };
    const hiddenRows = ledger.list(hiddenScope, hiddenSessionId);
    assert.equal(hiddenRows.length, 1);
    const hiddenRun = ledger.load(hiddenScope, hiddenRows[0].runId);
    assert.equal(hiddenRun.snapshot.phase, 'completed');
    assert.equal(hiddenRun.configuration.profile.providerThinkingDisplay, false);
    assert.equal(hiddenRun.snapshot.usage.modelCalls, 1);
    assert.ok(!JSON.stringify(hiddenRun.events.filter(event => event.kind === 'model.completed')).includes('HIDDEN_REASONING_PRIVATE'));
    report.durable = { revisions: [1, 3, 3, 3, 3, 3], engine: 'agentkit.native/v1', phases: runs.map(run => run.snapshot.phase),
      modelCalls: runs.map(run => run.snapshot.usage.modelCalls), buildId, frozenSessionId, currentSessionId,
      settledWhileBrowserOffline: completedOffline,
      approval: { agentId: approvalAgentId, sessionId: approvalSessionId, phase: approvalRun.snapshot.phase,
        modelCalls: approvalRun.snapshot.usage.modelCalls, toolCalls: approvalRun.snapshot.usage.toolCalls,
        asked: asked.length, decided: decided.length, outcome: decided[0].data.outcome },
      hiddenReasoning: { agentId: hiddenAgentId, sessionId: hiddenSessionId, phase: hiddenRun.snapshot.phase,
        modelCalls: hiddenRun.snapshot.usage.modelCalls, displayed: false } };
  } finally { ledger.close(); }
  report.checks.push('new-session-runs-current-r3-with-independent-native-ledger-and-history');
  report.passed = true; report.agentId = agentId;
} catch (error) {
  report.failure = { phase, message: String(error.message).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]').slice(0, 1500) };
  await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
} finally {
  for (const release of heldReleases) release.resolve();
  await page?.context().setOffline(false).catch(() => {});
  await browser?.close();
  if (child) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.requests = requests; report.rendererErrors = rendererErrors; report.modelFailures = modelFailures;
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: root, ...report }));
}
