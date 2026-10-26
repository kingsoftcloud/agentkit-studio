/** Real full Studio web profile, controlled local provider, browser reconnect and history.
 * Retains its isolated temporary root as evidence; the final report prints its path.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { dshModelRoute } from '../src/agent-preset-admission.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, archive: { type: 'string' }, chromium: { type: 'string' } } });
assert.ok(values.source && values.archive, '--source and --archive are required');
const source = resolve(values.source), repository = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'studio-native-full-page-'));
const report = { root, evidence: 'packed-studio-full-web-profile-local-provider-real-browser', checks: [], passed: false };
report.archiveSha256 = createHash('sha256').update(await readFile(resolve(values.archive))).digest('hex');
report.dshCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const graph = join(root, 'graph'), installed = join(graph, 'package');
await mkdir(join(graph, 'node_modules/@deepseek-ai'), { recursive: true });
execFileSync('tar', ['-xzf', resolve(values.archive), '-C', graph]);
for (const entry of await readdir(join(repository, 'node_modules'))) {
  if (!entry.startsWith('.') && entry !== '@deepseek-ai') await symlink(join(repository, 'node_modules', entry), join(graph, 'node_modules', entry));
}
for (const entry of await readdir(join(source, 'apps/cli/node_modules/@deepseek-ai'))) {
  await symlink(join(source, 'apps/cli/node_modules/@deepseek-ai', entry), join(graph, 'node_modules/@deepseek-ai', entry));
}
const profile = join(root, 'dsh/profiles/native-full-page');
await mkdir(join(profile, 'node_modules/@kingsoftcloud'), { recursive: true });
await symlink(installed, join(profile, 'node_modules/@kingsoftcloud/agentkit-studio'));
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'native-full-page', private: true, type: 'module', dsh: { profile: {
  bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kingsoftcloud/agentkit-studio'],
} } }));
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
await mkdir(join(root, 'agentkit'), { recursive: true });
await mkdir(join(root, 'workspace'), { recursive: true });
process.env.DSH_HOME = join(root, 'dsh');
process.env.AGENTKIT_HOME = join(root, 'agentkit');
process.env.AGENTKIT_STUDIO_WORKSPACE = join(root, 'workspace');
const requests = [], gates = new Map();
let stopping = false;
const gate = name => stopping ? Promise.resolve() : new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Fixture gate ${name} not released`)), 30000);
  timer.unref();
  gates.set(name, () => { clearTimeout(timer); resolve(); });
});
const provider = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'pinned' }] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const count = requests.length;
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `full-page-${count}`, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (count === 1) {
      send({ reasoning_content: 'FULL_PAGE_THINK_BEFORE_NETWORK_LOSS' });
      send({ content: 'FULL_PAGE_PREFIX' });
      await gate('offline');
      send({ reasoning_content: '\nFULL_PAGE_THINK_WHILE_OFFLINE' });
      await gate('online');
      send({ tool_calls: [{ index: 0, id: 'full-page-write', type: 'function', function: {
        name: 'write_workspace_file', arguments: JSON.stringify({ path: 'full-page-marker.txt', content: 'once' }),
      } }] }, 'tool_calls');
    } else if (count === 2) {
      assert.ok(body.messages.some(message => message.role === 'tool'), 'tool result reaches the next model request');
      send({ reasoning_content: 'FULL_PAGE_FINAL_THINK' });
      send({ content: 'FULL_PAGE_COMPLETED' }, 'stop');
    } else throw new Error('Unexpected extra model request');
    res.end('data: [DONE]\n\n');
  } catch (error) { report.providerError = error.message; res.destroy(error); }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
await writeFile(join(root, 'agentkit/config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
  modelName: 'pinned', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, default: true, credentialName: 'LOCAL_FIXTURE' }],
  modelProfileKeys: { LOCAL_FIXTURE: 'local-fixture-only' } }), { mode: 0o600 });
const require = createRequire(join(source, 'apps/cli/package.json'));
const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
const { runProfile } = await import(pathToFileURL(join(source, 'apps/cli/lib/profile-boot.js')).href);
const { chromium } = createRequire(import.meta.url)('playwright-core');
let launch, running, browser, page, stage = 'boot';
const networkFrames = [], sockets = [];
const publicFrames = [];
const stdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  const match = String(chunk).match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/);
  if (match) launch = match[1];
  appendFileSync(join(root, 'host.log'), String(chunk).replace(/token=[A-Za-z0-9_-]+/g, 'token=REDACTED'));
  args.find(value => typeof value === 'function')?.(); return true;
};
const check = name => report.checks.push(name);
try {
  running = await runProfile({ profile: 'native-full-page', environment: loadLayeredEnv('dsh', source), patchFiles: [],
    args: ['--no-open', '--port', '0', '--host', '127.0.0.1'] });
  running.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    publicFrames.push({ sessionId: agent.session.id, frame });
  }, { global: true });
  await running.ctx.workspaceRegistry.initializeDefault(async () => join(root, 'workspace'));
  assert.ok(launch, 'real web profile launch');
  browser = await chromium.launch({ executablePath: values.chromium || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext(); page = await context.newPage();
  let offline = false;
  await page.routeWebSocket('**/*', socket => {
    if (offline) { socket.close({ code: 1013, reason: 'acceptance network outage' }); return; }
    const server = socket.connectToServer(); sockets.push({ socket, server, path: new URL(socket.url()).pathname });
    const connection = sockets.length;
    socket.onMessage(message => { networkFrames.push({ connection, direction: 'client', body: String(message) }); server.send(message); });
    server.onMessage(message => { networkFrames.push({ connection, direction: 'host', body: String(message) }); socket.send(message); });
  });
  page.on('response', response => { if (response.status() >= 400) (report.httpFailures ??= []).push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on('pageerror', error => { (report.pageErrors ??= []).push(error.message.slice(0, 200)); });
  page.setDefaultTimeout(15000);
  await page.goto(launch);
  await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 60000 });
  check('complete Studio browser mounted'); stage = 'admit-agent';
  const origin = new URL(launch).origin;
  const login = await fetch(launch, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const rpc = async (method, payload) => {
    const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method, payload, rpcId: method }) });
    const result = (await response.json()).result;
    assert.ok(result?.ok, `${method}: ${result?.error?.code}`); return result.value;
  };
  const record = await rpc('agents/create-local', { name: 'Native full-page proof', runtimeType: 'harness', spec: {
    execution: { nativeTodoMode: 'off', nativePlanMode: 'off', nativeToolSearchMode: 'off' },
  }, bindings: { modelProfileIds: ['fixture'], tools: ['write_workspace_file'] } });
  const admission = await rpc('agents/ensure-preset', { agentId: record.metadata.id });
  assert.ok(admission.presetId);
  await page.reload();
  await page.locator('.studio-agent-trigger').waitFor({ state: 'visible', timeout: 30000 });
  const modelDeadline = Date.now() + 15000;
  const route = dshModelRoute({ id: 'fixture' });
  while (!await running.ctx.llm.resolveModelInfo(route, 'pinned').catch(() => null)) {
    assert.ok(Date.now() < modelDeadline, 'browser model directory synchronized');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  stage = 'open-session';
  const selector = page.getByRole('button', { name: '选择当前会话智能体', exact: true });
  const item = page.getByRole('menuitem').filter({ has: page.getByText(record.metadata.name, { exact: true }) });
  const selectionDeadline = Date.now() + 15000;
  while (!await item.isVisible() && Date.now() < selectionDeadline) {
    if (await selector.getAttribute('aria-expanded') !== 'true') await selector.click();
    await item.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});
  }
  await item.click();
  await page.locator('.studio-agent-trigger').filter({ hasText: record.metadata.name }).waitFor({ state: 'visible', timeout: 20000 });
  const sessionId = await page.locator('.studio-agent-trigger').getAttribute('data-studio-session-id');
  assert.ok(sessionId); report.sessionId = sessionId;
  await running.ctx.sessionController.selectModel({ sessionId, provider: route, model: 'pinned', saveDefault: false });
  stage = 'send';
  const composer = page.locator('[role="textbox"][contenteditable="true"]');
  await composer.fill('/permission workspace-write'); await composer.press('Enter');
  await composer.waitFor({ state: 'visible' });
  await composer.fill('Write the marker once and report completion.'); await composer.press('Enter');
  const reasoning = page.locator('[data-disclosure-row][role="button"]').filter({ hasText: '思考' }).first();
  await reasoning.waitFor({ state: 'visible', timeout: 20000 });
  if (await reasoning.getAttribute('aria-expanded') !== 'true') await reasoning.click();
  const thought = page.getByText('FULL_PAGE_THINK_BEFORE_NETWORK_LOSS', { exact: false });
  await thought.first().waitFor({ state: 'visible', timeout: 20000 });
  check('provider reasoning visible before model completion');
  stage = 'offline';
  const connectionsBeforeLoss = sockets.length;
  offline = true; await context.setOffline(true);
  await Promise.all(sockets.map(({ socket, server }) => Promise.all([socket.close({ code: 1012 }), server.close({ code: 1012 })])));
  assert.ok(gates.has('offline')); gates.get('offline')();
  // Observe the provider-side prefix write while the browser transport is disabled.
  const gateDeadline = Date.now() + 5000;
  let publishedOffline;
  while (!(publishedOffline = publicFrames.find(({ sessionId: id, frame }) => id === sessionId
    && frame.chunk?.text?.includes('FULL_PAGE_THINK_WHILE_OFFLINE')))) {
    // Host history folds this event synchronously. Provider write completion
    // alone would race its accumulator and the reconnect opening snapshot.
    assert.ok(Date.now() < gateDeadline, 'Native published the offline prefix before reconnect');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(gates.has('online'));
  offline = false; await context.setOffline(false);
  stage = 'reconnect';
  await page.getByText('FULL_PAGE_THINK_WHILE_OFFLINE', { exact: false }).first().waitFor({ state: 'visible', timeout: 20000 });
  assert.ok(sockets.length > connectionsBeforeLoss, 'new physical Gateway socket after transport cut');
  check('real transport reconnected with reasoning emitted while offline');
  gates.get('online')();
  stage = 'settlement';
  await page.getByText('FULL_PAGE_COMPLETED', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
  const resolved = await running.ctx.sessionController.resolveAgent(sessionId);
  assert.ok(!('error' in resolved)); await resolved.agent.whenIdle();
  assert.equal(await realpath(resolved.agent.session.header.cwd), await realpath(join(root, 'workspace')));
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
  assert.equal(await readFile(join(root, 'workspace/full-page-marker.txt'), 'utf8'), 'once');
  assert.equal(requests.length, 2);
  const durable = resolved.agent.session.snapshotEvents();
  assert.equal(durable.filter(event => event.type === 'tool/call').length, 1);
  assert.equal(durable.filter(event => event.type === 'tool/result').length, 1);
  assert.equal(durable.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  check('one durable tool call/result and completed turn retire the browser stop control');
  await page.getByText('已调用工具', { exact: true }).click();
  const tool = page.locator('[data-disclosure-row][role="button"]').filter({ hasText: 'write_workspace_file' });
  await tool.waitFor({ state: 'visible', timeout: 10000 });
  if (await tool.getAttribute('aria-expanded') !== 'true') await tool.click();
  await page.getByText('full-page-marker.txt', { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
  const receipt = durable.find(event => event.type === 'tool/result').data.message;
  assert.equal(receipt.isError, false);
  await page.getByText(receipt.content[0].text, { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  check('real tool disclosure exposes parameters and the authoritative result');
  await page.screenshot({ path: join(root, 'settled.png'), fullPage: true });
  stage = 'reload';
  await page.reload();
  await page.getByText('FULL_PAGE_COMPLETED', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page.getByText('FULL_PAGE_COMPLETED', { exact: true }).count(), 1);
  const thoughtRows = page.locator('[data-variant="think"]');
  assert.equal(await thoughtRows.count(), 2, 'one reasoning block per model request after history replay');
  const restoredThought = thoughtRows.first();
  if (!await restoredThought.locator('[data-disclosure-row][role="button"]').isVisible()) {
    await page.locator('button[data-turn-process]').click();
    await page.getByText('已完成分析', { exact: true }).click();
  }
  assert.notEqual(await restoredThought.getAttribute('data-expanded'), 'true', 'history reasoning initially collapsed');
  await restoredThought.locator('[data-disclosure-row][role="button"]').click();
  await page.getByText('FULL_PAGE_THINK_WHILE_OFFLINE', { exact: false }).first().waitFor({ state: 'visible' });
  assert.equal(requests.length, 2, 'history restoration does not invoke the model');
  check('full page reload restores one settled response without executing again');
  report.remotePaths = [...new Set(sockets.map(socket => socket.path))]; report.modelRequests = requests.length;
  report.physicalConnections = sockets.length;
  const messages = networkFrames.map(frame => ({ ...frame, body: JSON.parse(frame.body) }));
  const follows = messages.filter(frame => frame.direction === 'client' && frame.body.endpoint === 'session/follow');
  const followIds = new Set(follows.map(frame => frame.body.streamId));
  const snapshots = messages.filter(frame => frame.direction === 'host' && followIds.has(frame.body.streamId) && frame.body.value?.type === 'snapshot');
  assert.ok(follows.length > 0 && snapshots.length > 0, 'real Gateway session/follow opens and snapshots captured');
  const restored = snapshots.find(frame => frame.connection > connectionsBeforeLoss
    && JSON.stringify(frame.body.value.assistantStream?.activeAttempt?.stream ?? []).includes('FULL_PAGE_THINK_WHILE_OFFLINE'));
  assert.ok(restored, 'actual post-disconnect network baseline contains the missed reasoning chunk');
  assert.ok(restored.body.value.assistantStream.revision >= publishedOffline.frame.revision);
  const final = snapshots.at(-1).body.value;
  assert.ok(final.assistantStream, 'reload has an assistant-stream baseline');
  assert.equal(final.assistantStream.activeAttempt, undefined);
  assert.ok(final.records.some(record => record.event?.type === 'turn/end' && record.event.data.reason.kind === 'completed'));
  report.reconnect = { revision: restored.body.value.assistantStream.revision,
    startedAfterSeq: restored.body.value.assistantStream.activeAttempt.startedAfterSeq,
    nextIndex: restored.body.value.assistantStream.activeAttempt.nextIndex,
    finalRevision: final.assistantStream.revision, followOpens: follows.length };
  check('captured real Gateway baseline restores active attempt and reload retires it');
  assert.equal(report.providerError, undefined);
  assert.deepEqual(report.pageErrors ?? [], []);
  report.passed = true;
} catch (error) {
  report.failure = { stage, message: error.message.replace(/token=[A-Za-z0-9_-]+/g, 'token=REDACTED').slice(0, 1300) }; process.exitCode = 1;
  if (page) { await page.screenshot({ path: join(root, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
} finally {
  await writeFile(join(root, 'gateway-frames.json'), JSON.stringify(networkFrames, null, 2));
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2) + '\n');
  stdout(JSON.stringify(report) + '\n');
  stopping = true;
  for (const resolve of gates.values()) resolve();
  await browser?.close(); await running?.shutdown.shutdown(process.exitCode || 0);
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  process.stdout.write = stdout;
}
