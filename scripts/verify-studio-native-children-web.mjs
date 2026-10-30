/** Full mounted Studio child lifecycle acceptance, controlled local model, actual Chrome.
 * Usage: node scripts/verify-studio-native-children-web.mjs --source <built DSH>
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
const root = values.output ? resolve(values.output) : await mkdtemp(join(tmpdir(), 'studio-children-web-'));
await mkdir(root, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [dirname(require.resolve('@playwright/test/package.json'))] }));
const requests = [], modelFailures = [], rendererErrors = [];
let browser, page, child, stopped, phase = 'prepare';
const report = { evidence: 'full-mounted-studio-children-controlled-model', passed: false, checks: [] };
let scenario = 'guided', parentSteps = { guided: 0, cancel: 0 }, childSteps = { guided: 0, cancel: 0 };
const held = {};
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'pinned', object: 'model', owned_by: 'local-fixture' }] })); return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), mode = scenario;
    const childCall = body.messages.some(message => message.role === 'system' && message.content.includes('CHILD_WEB_READER'));
    requests.push({ scenario: mode, kind: childCall ? 'child' : 'parent', inputTokens: 11, outputTokens: 7 });
    assert.ok(requests.length <= 12, 'Unexpected unbounded fixture requests');
    let call, content;
    if (childCall) {
      const step = childSteps[mode]++;
      if (step === 0) {
        await new Promise(resolve => { held[mode] = resolve; });
        call = mode === 'cancel' ? { name: 'write_workspace_file', arguments: { path: 'must-not-exist.txt', content: 'late canceled effect' } }
          : { name: 'read_workspace_file', arguments: { path: 'proof.txt' } };
      } else {
        assert.equal(mode, 'guided'); assert.equal(step, 1);
        assert.match(JSON.stringify(body.messages), /WEB_GUIDANCE: report the original evidence/);
        assert.match(JSON.stringify(body.messages), /Original child workspace evidence/);
        content = 'CHILD_GUIDED_DONE: Original child workspace evidence.';
      }
    } else {
      const step = parentSteps[mode]++;
      const childId = [...JSON.stringify(body.messages).matchAll(/native-child-[a-f0-9]{64}/g)].at(-1)?.[0];
      if (step === 0) call = { name: 'native_delegate', arguments: { role: 'reader', task: mode === 'guided'
        ? 'Read proof.txt. CHILD_WEB_GUIDED.' : 'Wait for a cancellation. CHILD_WEB_CANCEL.' } };
      else if (mode === 'cancel') { assert.equal(step, 1); content = 'PARENT_CANCELED_CHILD_ACK'; }
      else if (step === 1) { assert.ok(childId); call = { name: 'native_child_control', arguments: { child_run_id: childId, action: 'wait', wait_seconds: 20 } }; }
      else if (step === 2) call = { name: 'native_child_result', arguments: { child_run_id: childId } };
      else { assert.equal(step, 3); assert.match(JSON.stringify(body.messages), /CHILD_GUIDED_DONE/); content = 'PARENT_GUIDED_DONE'; }
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'child-web-' + requests.length, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content };
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end('data: ' + JSON.stringify({ id: 'child-web-' + requests.length, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7 } }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { modelFailures.push(error.message); res.writeHead(500); res.end('Local child fixture failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const home = join(root, 'home'), profile = 'children-proof', profileRoot = join(home, 'profiles', profile);
const installed = join(root, 'host/package'), graph = join(root, 'host/node_modules');
async function rpc(method, payload = {}) {
  return page.evaluate(async ({ method, payload }) => {
    const response = await fetch('/agentkit', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload, rpcId: 'children-web-proof' }) });
    const result = (await response.json()).result;
    if (!result?.ok) throw Error(result?.error?.code || 'RPC_FAILED');
    return result.value;
  }, { method, payload });
}
try {
  await mkdir(join(root, 'host')); execFileSync('tar', ['-xzf', resolve(values.archive), '-C', join(root, 'host')]);
  report.archiveSha256 = createHash('sha256').update(await readFile(resolve(values.archive))).digest('hex');
  report.sourceSha256 = {};
  for (const file of ['dist/client.js', 'src/providers/native-subagents.mjs', 'src/native-child-tools.mjs', 'src/native-tool-catalog.mjs',
    'src/client/pages/agent-form.mjs', 'src/client/pages/native-role-fields.mjs', 'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/workspace-tools.mjs']) {
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
  phase = 'create-agent-and-role';
  await writeFile(join(root, 'workspace/proof.txt'), 'Original child workspace evidence');
  await page.getByText('智能体', { exact: true }).first().click();
  await page.getByRole('button', { name: '我的智能体', exact: true }).click();
  await page.getByRole('button', { name: '手动配置', exact: true }).click();
  await page.getByLabel('Agent ID', { exact: true }).fill('children-web-proof');
  await page.getByLabel('名称', { exact: true }).fill('Children Web proof');
  await page.getByLabel('运行时').selectOption('harness');
  await page.getByPlaceholder('描述 Agent 的身份、边界和回答方式', { exact: true }).fill('Delegate bounded work to the reader role.');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  const model = page.getByLabel('默认模型');
  await model.locator('option[value="fixture"]').waitFor({ state: 'attached' }); await model.selectOption('fixture');
  for (const id of ['read_workspace_file', 'write_workspace_file']) {
    const tool = page.locator('label').filter({ has: page.locator('strong', { hasText: new RegExp(`^${id} · Native$`) }) });
    await tool.getByRole('checkbox').check();
  }
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '添加子任务角色', exact: true }).click();
  await page.getByLabel('角色 1 标识', { exact: true }).fill('reader');
  await page.getByLabel('角色 1 任务说明', { exact: true }).fill('CHILD_WEB_READER: read proof.txt and report the evidence.');
  for (const id of ['read_workspace_file', 'write_workspace_file']) await page.getByLabel(`角色 1 工具 ${id}`, { exact: true }).check();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  const row = page.getByRole('row').filter({ hasText: 'Children Web proof' }); await row.waitFor({ state: 'visible' });
  const list = await rpc('agents/list', { query: 'Children Web proof', source: 'local', page: 1, limit: 10 });
  assert.equal(list.items.length, 1); const agentId = list.items[0].metadata.id;
  const saved = await rpc('agents/local-get', { agentId });
  assert.equal(saved.spec.subAgents.length, 1); assert.equal(saved.spec.subAgents[0].name, 'reader');
  assert.deepEqual(saved.spec.subAgents[0].tools, ['read_workspace_file', 'write_workspace_file']);
  report.checks.push('create-native-role-through-real-agent-form');
  await row.getByRole('button', { name: '绑定到新会话', exact: true }).click();
  const trigger = page.locator('.studio-agent-trigger').filter({ hasText: 'Children Web proof' }); await trigger.waitFor({ state: 'visible' });
  const sessionId = await trigger.getAttribute('data-studio-session-id'); assert.ok(sessionId);
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  const dialog = page.getByRole('dialog', { name: '本会话的运行与子任务', exact: true });
  const card = dialog.getByRole('article', { name: '子任务：reader', exact: true });
  phase = 'guidance-and-background';
  await composer.fill('CHILD_WEB_GUIDED: inspect the file using the reader role.'); await composer.press('Enter');
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
  await card.getByRole('button', { name: '转为后台', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await card.getByLabel('给 reader 补充指导', { exact: true }).fill('WEB_GUIDANCE: report the original evidence');
  await card.getByRole('button', { name: '发送指导', exact: true }).click();
  await card.getByRole('status').getByText(/操作已接收|操作已投递/).waitFor({ state: 'visible' });
  await card.getByRole('button', { name: '转为后台', exact: true }).click();
  await card.getByRole('button', { name: '转为后台', exact: true }).waitFor({ state: 'detached' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.ok(held.guided, 'The original child request must still be held'); held.guided();
  // Strict policy also requires explicit permission for the parent's wait tool.
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
  await card.getByText(/已完成.*后台/).waitFor({ state: 'visible', timeout: 30000 });
  await card.getByText(/已计入父任务/).waitFor({ state: 'visible' });
  await card.getByRole('button', { name: '查看结果', exact: true }).click();
  await dialog.getByRole('region', { name: '子任务结果', exact: true }).getByText(/CHILD_GUIDED_DONE/).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(root, 'guided.png'), fullPage: true });
  report.checks.push('explicit-strict-policy-approvals', 'guide-original-child-and-promote-to-background', 'read-settled-result-and-child-usage');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByText('PARENT_GUIDED_DONE', { exact: true }).waitFor({ state: 'visible' });
  phase = 'reload-guided-history';
  await page.reload(); await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
  await card.getByText(/已完成.*后台/).waitFor({ state: 'visible' });
  await card.getByRole('button', { name: '查看结果', exact: true }).click();
  await dialog.getByRole('region', { name: '子任务结果', exact: true }).getByText(/CHILD_GUIDED_DONE/).waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  report.checks.push('reload-restores-original-child-and-result');
  phase = 'cancel-original-child'; scenario = 'cancel';
  await composer.fill('CHILD_WEB_CANCEL: delegate a task and wait.'); await composer.press('Enter');
  await page.getByRole('button', { name: '允许一次', exact: true }).click();
  await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
  const active = card.filter({ hasText: 'CHILD_WEB_CANCEL' });
  await active.getByRole('button', { name: '停止子任务', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await active.getByRole('button', { name: '停止子任务', exact: true }).click();
  await active.getByText(/已取消/).waitFor({ state: 'visible', timeout: 30000 });
  assert.ok(held.cancel, 'Cancel the original held model request'); held.cancel();
  await active.getByText(/已计入父任务/).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(root, 'canceled.png'), fullPage: true });
  report.checks.push('cancel-original-active-child-before-late-tool-dispatch');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByText('PARENT_CANCELED_CHILD_ACK', { exact: true }).waitFor({ state: 'visible' });
  phase = 'reload-canceled-history';
  await page.reload(); await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: '运行与子任务', exact: true }).click();
  await active.getByText(/已取消/).waitFor({ state: 'visible' });
  assert.equal(await card.count(), 2);
  report.checks.push('reload-keeps-both-rounds-and-cancellation');
  const history = await rpc('sessions/native-child-history', { agentId, sessionId });
  assert.equal(history.tasks.length, 2); assert.equal(new Set(history.tasks.map(task => task.childRunId)).size, 2);
  assert.deepEqual(modelFailures, []); assert.deepEqual(rendererErrors, []);
  assert.deepEqual(requests.map(request => `${request.scenario}:${request.kind}`).sort(),
    ['guided:parent', 'guided:parent', 'guided:parent', 'guided:parent', 'guided:child', 'guided:child', 'cancel:parent', 'cancel:parent', 'cancel:child'].sort());
  assert.equal(await readFile(join(root, 'legacy-loop.jsonl'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; }), '');
  phase = 'durable-outcomes';
  const { SqliteRunStore } = await import(pathToFileURL(createRequire(join(installed, 'package.json')).resolve('@kingsoftcloud/agentkit-harness-node/native/sqlite-store')));
  const scope = { tenantId: 'local', userId: 'local-user', agentId,
    workspaceId: createHash('sha256').update(JSON.stringify(resolve(root, 'workspace'))).digest('hex') };
  const ledger = new SqliteRunStore(join(root, 'studio/native-harness/runs.sqlite'));
  try {
    const parents = ledger.list(scope, sessionId).map(snapshot => ledger.load(scope, snapshot.runId));
    assert.equal(parents.length, 2);
    assert.ok(parents.every(run => run.snapshot.phase === 'completed' && run.configuration.engine === 'agentkit.native/v1'
      && run.configuration.hostRecoveryBinding.agentRevision === saved.metadata.revision));
    const children = parents.map(parent => {
      assert.equal(parent.snapshot.childBudgetReservations.length, 1);
      const reservation = parent.snapshot.childBudgetReservations[0]; assert.ok(reservation.settledUsageDigest);
      const childRun = ledger.load(reservation.childScope, reservation.childRunId);
      assert.equal(childRun.configuration.childOwnerBinding.parent.runId, parent.snapshot.runId);
      assert.deepEqual(parent.snapshot.descendantUsage, childRun.snapshot.usage);
      return childRun;
    });
    assert.deepEqual(children.map(run => run.snapshot.phase), ['completed', 'canceled']);
    assert.deepEqual(children.map(run => run.snapshot.usage.modelCalls), [2, 1]);
    assert.deepEqual(children.map(run => run.snapshot.usage.toolCalls), [1, 0]);
    assert.ok(children[0].receipts.some(receipt => receipt.result.results?.some(result => result.status === 'ok'
      && JSON.stringify(result.content, (_, value) => typeof value === 'bigint' ? value.toString() : value).includes('Original child workspace evidence'))));
    assert.ok(!children[1].intents.some(intent => intent.kind === 'tool'), 'Late canceled response must not admit a write intent');
    for (const childRun of children) {
      const isolation = childRun.configuration.hostRecoveryBinding.childWorkspace;
      if (isolation) await assert.rejects(readFile(join(root, 'studio/native-harness/child-workspaces', isolation.isolationId, 'work/must-not-exist.txt')), { code: 'ENOENT' });
    }
    report.durable = { parents: 2, children: 2, phases: children.map(run => run.snapshot.phase), childModelCalls: [2, 1], childToolCalls: [1, 0],
      revision: saved.metadata.revision, engine: 'agentkit.native/v1', childUsageSettledOnce: true, lateWriteDispatched: false };
  } finally { ledger.close(); }
  report.checks.push('actual-sqlite-parent-binding-usage-settlement-and-no-canceled-effect');
  report.passed = true; report.agentId = agentId; report.sessionId = sessionId;
} catch (error) {
  report.failure = { phase, message: String(error.message).split('\n')[0].slice(0, 300) };
  await page?.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {}); process.exitCode = 1;
} finally {
  Object.values(held).forEach(release => release());
  await browser?.close();
  if (child) { child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await stopped; clearTimeout(timer); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  report.requests = requests; report.rendererErrors = rendererErrors; report.modelFailures = modelFailures;
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: root, ...report }));
}
