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
const heldRequests = [Promise.withResolvers(), Promise.withResolvers()];
const heldReleases = [Promise.withResolvers(), Promise.withResolvers()];
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
    const marker = system.includes('MANAGEMENT_REVISION_THREE') ? 'MANAGEMENT_REVISION_THREE' : 'MANAGEMENT_REVISION_ONE';
    assert.ok(system.includes(marker));
    requests.push({ marker, inputTokens: 11, outputTokens: 7 });
    assert.ok(requests.length <= 4, 'Unexpected repeated model request');
    const heldIndex = requests.length - 3;
    if (heldIndex >= 0 && heldIndex < heldRequests.length) {
      heldRequests[heldIndex].resolve(); await heldReleases[heldIndex].promise;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end('data: ' + JSON.stringify({ id: 'management-' + requests.length,
      choices: [{ index: 0, delta: { content: marker + (requests.length === 3 ? '_RECONNECTED'
        : requests.length === 4 ? '_NETWORK_RECONNECTED' : '_DONE') }, finish_reason: 'stop' }],
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
    modelName: 'pinned', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, default: true, credentialName: 'LOCAL_PROOF' }],
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
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')));
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
  assert.deepEqual(modelFailures, []); assert.deepEqual(rendererErrors, []);
  assert.deepEqual(requests.map(item => item.marker), ['MANAGEMENT_REVISION_ONE', 'MANAGEMENT_REVISION_THREE', 'MANAGEMENT_REVISION_THREE', 'MANAGEMENT_REVISION_THREE']);
  assert.equal(await readFile(join(root, 'legacy-loop.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }), '');
  phase = 'durable-version-bindings';
  const ledger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  try {
    const frozenRows = ledger.list(scope, frozenSessionId), currentRows = ledger.list(scope, currentSessionId);
    assert.equal(frozenRows.length, 1); assert.equal(currentRows.length, 3, 'Both reconnected turns have independent durable Runs');
    const runs = [...frozenRows, ...currentRows].map(row => ledger.load(scope, row.runId));
    assert.deepEqual(runs.map(run => run.configuration.hostRecoveryBinding.agentRevision), [1, 3, 3, 3]);
    assert.ok(runs.every(run => run.snapshot.phase === 'completed' && run.configuration.engine === 'agentkit.native/v1'));
    assert.deepEqual(runs.map(run => run.snapshot.usage.modelCalls), [1, 1, 1, 1]);
    assert.equal(runs[0].snapshot.buildId, buildId);
    assert.equal(runs[0].configuration.hostRecoveryBinding.buildId, buildId);
    assert.equal(runs[1].configuration.hostRecoveryBinding.buildId, null);
    assert.match(runs[1].snapshot.buildId, /^revision-[a-f0-9]{64}$/);
    assert.equal(runs[2].configuration.hostRecoveryBinding.buildId, null);
    assert.equal(runs[2].snapshot.parentRunId, runs[1].snapshot.runId, 'Reconnected continuation retains the original Run');
    assert.equal(runs[3].snapshot.parentRunId, runs[2].snapshot.runId, 'Network-reconnected continuation retains the prior Run');
    report.durable = { revisions: [1, 3, 3, 3], engine: 'agentkit.native/v1', modelCalls: [1, 1, 1, 1], buildId, frozenSessionId, currentSessionId,
      settledWhileBrowserOffline: completedOffline };
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
