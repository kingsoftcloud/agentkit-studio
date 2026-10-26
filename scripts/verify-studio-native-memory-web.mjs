/** Full mounted Studio Memory acceptance, controlled local model, actual Chrome.
 * Usage: node scripts/verify-studio-native-memory-web.mjs --source <built DSH>
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
const root = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'studio-memory-web-'));
await mkdir(root, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
const requests = [], modelFailures = [], rendererErrors = [];
let browser, page, child, stopped, phase = 'prepare';
const report = { evidence: 'full-mounted-studio-memory-controlled-model', passed: false, checks: [] };
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'pinned', object: 'model', owned_by: 'local-fixture' }] })); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input = body.messages.filter(message => message.role === 'user').map(message => {
      try { return JSON.parse(message.content); } catch { return null; }
    }).find(value => value?.source?.messages);
    const auxiliary = Boolean(input), exhaustion = auxiliary && JSON.stringify(input.source).includes('BUDGET_MODE');
    requests.push({ kind: auxiliary ? exhaustion ? 'budget' : 'success' : 'main', inputTokens: 11, outputTokens: 7 });
    assert.ok(requests.length <= 14, 'Unexpected unbounded fixture requests');
    let delta = { content: auxiliary ? 'Memory extraction finished.' : 'MEMORY_WEB_MAIN_DONE' }, finish = 'stop';
    if (auxiliary && (exhaustion || !body.messages.some(message => message.role === 'tool'))) {
      const call = exhaustion ? { name: 'read_memory', arguments: { memory_id: 'missing-fact' } }
        : { name: 'manage_memory', arguments: { action: 'remember', scope: 'user', memory_type: 'fact',
          content: 'Financial reports use UTC.', source_event_ids: [input.source.messages.find(message => message.role === 'user' && !message.modelOnly).id] } };
      delta = { tool_calls: [{ index: 0, id: `memory-${requests.length}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }; finish = 'tool_calls';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(`data: ${JSON.stringify({ id: `memory-${requests.length}`, choices: [{ index: 0, delta, finish_reason: finish }],
      usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { modelFailures.push(error.message); res.writeHead(500); res.end('Local Memory fixture failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const home = join(root, 'home'), profile = 'memory-proof', profileRoot = join(home, 'profiles', profile);
const installed = join(root, 'host/package'), graph = join(root, 'host/node_modules');
async function rpc(method, payload = {}) {
  return page.evaluate(async ({ method, payload }) => {
    const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload, rpcId: 'memory-web-proof' }) });
    const result = (await response.json()).result;
    if (!result?.ok) throw Error(result?.error?.code || 'RPC_FAILED');
    return result.value;
  }, { method, payload });
}
try {
  await mkdir(join(root, 'host')); execFileSync('tar', ['-xzf', resolve(values.archive), '-C', join(root, 'host')]);
  assert.ok((await readFile(join(installed, 'dist/client.js'))).equals(await readFile(join(repository, 'dist/client.js'))), 'Packed browser bundle differs');
  assert.ok((await readFile(join(installed, 'src/host/services/native-memory-extraction.mjs')))
    .equals(await readFile(join(repository, 'src/host/services/native-memory-extraction.mjs'))), 'Packed Memory dispatcher differs');
  await mkdir(join(graph, '@deepseek-ai'), { recursive: true });
  for (const entry of await readdir(join(repository, 'node_modules'))) if (!entry.startsWith('.') && entry !== '@deepseek-ai')
    await symlink(join(repository, 'node_modules', entry), join(graph, entry));
  const dshPackages = join(source, 'apps/cli/node_modules/@deepseek-ai');
  for (const entry of await readdir(dshPackages)) await symlink(join(dshPackages, entry), join(graph, '@deepseek-ai', entry));
  const modules = join(profileRoot, 'node_modules');
  await mkdir(join(modules, '@kingsoftcloud'), { recursive: true });
  await symlink(join(graph, '@deepseek-ai'), join(modules, '@deepseek-ai'));
  await symlink(installed, join(modules, '@kingsoftcloud/agentkit-studio'));
  await writeFile(join(profileRoot, 'package.json'), JSON.stringify({ name: 'local-memory-proof', private: true, type: 'module',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio'] } },
    dependencies: { '@deepseek-ai/dsh-base': '0.2.1-rc.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.2', '@kingsoftcloud/agentkit-studio': '0.0.2' } }));
  await writeFile(join(root, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
    modelName: 'pinned', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, default: true, credentialName: 'LOCAL_PROOF' }],
    modelProfileKeys: { LOCAL_PROOF: 'local-fixture-key' } }), { mode: 0o600 });
  const patch = join(root, 'proof.patch.yml');
  await writeFile(patch, ['- id: session-persistence-jsonl', '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
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
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000); page.on('pageerror', error => rendererErrors.push(error.name));
  await page.goto(await launch);
  await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 60000 });
  phase = 'create-agent';
  await page.getByText('智能体', { exact: true }).first().click();
  await page.getByRole('button', { name: '我的智能体', exact: true }).click();
  await page.getByRole('button', { name: '手动配置', exact: true }).click();
  await page.getByLabel('Agent ID', { exact: true }).fill('memory-web-proof');
  await page.getByLabel('名称', { exact: true }).fill('Memory Web proof');
  await page.getByLabel('运行时').selectOption('harness');
  await page.getByPlaceholder('描述 Agent 的身份、边界和回答方式', { exact: true }).fill('Local Memory integration acceptance.');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const model = page.getByLabel('默认模型');
  await model.locator('option[value="fixture"]').waitFor({ state: 'attached' }); await model.selectOption('fixture');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel('启用跨会话记忆', { exact: true }).check();
  await page.getByLabel('记忆写入方式', { exact: true }).selectOption('candidate');
  await page.getByLabel('轮次后刷新记忆', { exact: true }).check();
  await page.getByLabel('启用模型记忆提炼', { exact: true }).check();
  await page.getByLabel('记忆提炼累计字符数', { exact: true }).fill('64');
  await page.getByLabel('记忆写入开关', { exact: true }).selectOption('enabled');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Memory Web proof' }); await row.waitFor({ state: 'visible' });
  const list = await rpc('agents/list', { query: 'Memory Web proof', source: 'local', page: 1, limit: 10 });
  assert.equal(list.items.length, 1); const agentId = list.items[0].metadata.id;
  const saved = await rpc('agents/local-get', { agentId });
  assert.deepEqual(saved.spec.memory.extraction, { enabled: true, minUserCharacters: 64 });
  assert.equal(saved.spec.context.rollout.memoryWrite, 'enabled');
  report.checks.push('create-and-enable-memory-through-form');
  phase = 'bind-agent';
  await row.getByRole('button', { name: '绑定到新会话', exact: true }).click();
  const trigger = page.locator('.studio-agent-trigger').filter({ hasText: 'Memory Web proof' }); await trigger.waitFor({ state: 'visible' });
  const sessionId = await trigger.getAttribute('data-studio-session-id'); assert.ok(sessionId);
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  for (const mode of ['success', 'budget']) {
    phase = `run-${mode}`;
    const text = `${mode === 'budget' ? 'BUDGET_MODE ' : ''}我们的财务报表统一使用协调世界时，所有金额必须注明币种并保留两位小数。客户支持答复使用简体中文，且保留用户订单编号，方便后续查询与核查。`;
    await composer.fill(text); await composer.press('Enter');
    await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '本会话的运行与子任务', exact: true });
    const memory = dialog.getByRole('region', { name: '自动记忆提炼', exact: true });
    await memory.getByText(mode === 'success' ? /已完成.*模型 2 次/ : /模型 5 次.*已达到提炼预算上限/).waitFor({ state: 'visible', timeout: 30000 });
    await dialog.getByRole('region', { name: 'Native 运行用量', exact: true }).getByText(/模型 1 次/).waitFor({ state: 'visible' });
    await page.screenshot({ path: join(root, `${mode}.png`), fullPage: true });
    report.checks.push(`${mode}-separate-main-and-memory-usage`);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    phase = `reload-${mode}`;
    await page.reload();
    // Started conversations replace the blank-session Agent selector with the
    // native conversation header. Check its actual Session identity.
    await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: 'visible', timeout: 30000 });
    await page.getByText('Memory Web proof', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
    await memory.getByText(mode === 'success' ? /已完成.*模型 2 次/ : /模型 5 次.*已达到提炼预算上限/).waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    report.checks.push(`${mode}-reload-preserves-status-and-usage`);
  }
  assert.deepEqual(modelFailures, []); assert.deepEqual(rendererErrors, []);
  assert.deepEqual(Object.fromEntries(['main', 'success', 'budget'].map(kind => [kind, requests.filter(request => request.kind === kind).length])),
    { main: 2, success: 2, budget: 5 });
  assert.equal(await readFile(join(root, 'legacy-loop.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }), '');
  phase = 'durable-outcomes';
  const { SqliteRunStore } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/sqlite-store.mjs')));
  const { SqliteNativeMemoryProvider } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/memory-store.mjs')));
  const { memoryDigest } = await import(pathToFileURL(join(installed, 'packages/agentkit-harness/src/native/memory-candidate.mjs')));
  const scope = { tenantId: 'local', userId: 'local-user', agentId,
    workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex') };
  const ledger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  try {
    const parents = ledger.list(scope, sessionId).map(snapshot => ledger.load(scope, snapshot.runId));
    assert.equal(parents.length, 2);
    assert.ok(parents.every(run => run.snapshot.phase === 'completed' && run.snapshot.usage.modelCalls === 1
      && run.configuration.engine === 'agentkit.native/v1'
      && run.configuration.hostRecoveryBinding.agentRevision === saved.metadata.revision));
    assert.equal(parents[1].snapshot.parentRunId, parents[0].snapshot.runId);
    assert.equal(ledger.list(scope).filter(snapshot => snapshot.sessionId !== sessionId).length, 2);
    report.durable = { parentRuns: 2, separateAuxiliaryRuns: 2, engine: 'agentkit.native/v1', revision: saved.metadata.revision };
  } finally { ledger.close(); }
  const memoryStore = new SqliteNativeMemoryProvider(join(root, 'studio/native-harness/memory-v1', memoryDigest('local').slice(7), 'memory.sqlite'),
    { principal: scope, scopes: saved.spec.memory.scopes });
  try {
    const records = memoryStore.list();
    assert.equal(records.length, 1); assert.equal(records[0].content, 'Financial reports use UTC.');
    assert.equal(records[0].version, 1); assert.equal(records[0].metadata.extractionPolicy, 'native-model-memory/v1');
    report.durable.memoryFacts = 1; report.durable.memoryVersion = 1;
  } finally { memoryStore.close(); }
  report.checks.push('actual-sqlite-effect-and-original-revision-binding');
  report.passed = true; report.requests = requests; report.agentId = agentId; report.sessionId = sessionId;
} catch (error) {
  report.failure = { phase, message: String(error.message).split('\n')[0].slice(0, 300) };
  await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
} finally {
  await browser?.close();
  if (child) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer); }
  await new Promise(resolve => server.close(resolve));
  report.rendererErrors = rendererErrors; report.modelFailures = modelFailures;
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: root, ...report }));
}
