// Studio's chat node for Native engine runs: grouping from Session events, and
// a real-browser check that the renderer embeds the engine-delivered view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createNativeEngineRuntime } from '../src/providers/native-engine-runtime.mjs';
import { registerNativeWebDelivery } from '../src/host/routes/native-web-delivery.mjs';
import { registerNativeEngineView } from '../src/host/routes/native-engine-view.mjs';
import { nativeEngineViewDefinition, NATIVE_ENGINE_EVENT, NATIVE_ENGINE_VIEW_KIND } from '../src/client/dsh/native-engine-view.mjs';

const view = 'a'.repeat(64);
const sessionEvent = (seq, event, extra = {}) => ({ seq, type: NATIVE_ENGINE_EVENT, ignorable: true, data: { runId: 'r1', view, event }, ...extra });
const e = (seq, kind, extra = {}) => ({ schema: 'agentkit.engine-event/v1', seq, kind, ...extra });

test('Session engine events group into one node per run, in order and without duplicates', () => {
  const d = nativeEngineViewDefinition;
  assert.equal(d.match({ seq: 1, type: 'other', ignorable: true, data: {} }), null);
  assert.equal(d.match(sessionEvent(1, e(1, 'run.started'), { ignorable: false })), null);
  assert.deepEqual(d.match(sessionEvent(1, e(1, 'run.started'))), { id: 'r1', role: 'start' });
  const at = event => ({ event, location: { kind: 'turn', turn: { turn: 1, status: 'open' } } });
  let state = d.start({}, at(sessionEvent(10, e(1, 'run.started'))));
  for (const [seq, ev] of [[11, e(4, 'model.completed')], [12, e(4, 'model.completed')], [13, e(2, 'effect.prepared')], [14, e(9, 'run.terminal')]])
    state = d.update({ state }, at(sessionEvent(seq, ev)));
  assert.deepEqual(state.events.map(ev => ev.seq), [1, 4, 9]);
  const node = d.buildViewNode({ state, key: 'k', id: 'r1', start: null, current: new Map() });
  assert.equal(node.kind, NATIVE_ENGINE_VIEW_KIND); assert.equal(node.data.view, view); assert.equal(node.data.last, 9); assert.equal(node.anchorSeq, 10);
  const same = d.buildViewNode({ state, key: 'k', id: 'r1', start: null, current: new Map([['chat', node]]) });
  assert.equal(same, node, 'unchanged state reuses the node');
});

test('cold managed Session views are fetched by digest and remain cached after the Engine stops', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'managed-engine-view-'));
  const html = '<!doctype html><p>Archived engine view</p>';
  const sha256 = createHash('sha256').update(html).digest('hex');
  const token = 'fixture-engine-view-secret-token';
  const requests = [];
  const server = createServer((request, response) => {
    requests.push([request.url, request.headers.authorization]);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    if (server.listening) server.close();
    rmSync(stateRoot, { recursive: true, force: true });
  });
  const runtime = createNativeEngineRuntime({ env: {}, stateRoot,
    viewService: { endpoint: 'http://127.0.0.1:' + server.address().port, token } });
  let route;
  registerNativeEngineView({ connection: { fetch: { register: value => { route = value; } } } }, runtime);
  const request = 'https://studio.invalid' + route.path + '?sha256=' + sha256;
  const response = await route.fetch(new Request(request));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), html);
  assert.match(response.headers.get('content-security-policy'), /sandbox allow-scripts/);
  await new Promise(resolve => server.close(resolve));
  assert.equal((await route.fetch(new Request(request, { method: 'HEAD' }))).status, 200);
  assert.deepEqual(requests, [['/v1/views/' + sha256, 'Bearer ' + token]]);
});


test('a completed run opens its host-bound application and rejects other entries', async t => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'native-web-delivery-'));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  writeFileSync(join(workspaceRoot, 'index.html'), '<!doctype html><title>Work orders</title>');
  let route;
  const event = e(1, 'run.terminal', { title: 'completed', detail: 'Delivered',
    deliverables: [{ kind: 'file', path: 'index.html' }] });
  const ctx = {
    effect() {},
    connection: { fetch: { register: value => { route = value; } } },
    sessionQuery: { readEvent: async ({ seq }) => ({
      session: { cwd: workspaceRoot },
      target: sessionEvent(seq, seq === 1 ? event : e(seq, 'model.completed')),
    }) },
  };
  registerNativeWebDelivery(ctx, {}, { workspaceRoot, origin: 'http://127.0.0.1:18445', entryPath: 'index.html' });
  const request = (query, method = 'GET') => route.fetch(new Request(
    'http://localhost' + route.path + '?' + new URLSearchParams({
      sessionId: 'session', seq: '1', mode: 'sidebar', application: '1', path: 'index.html', ...query,
    }), { method, headers: { host: 'localhost' } }));
  assert.equal((await request({}, 'HEAD')).status, 204);
  assert.deepEqual(await (await request({})).json(), { url: 'http://127.0.0.1:18445/' });
  assert.equal((await request({ path: 'other.html' })).status, 404);
  assert.equal((await request({ seq: '2' })).status, 404);
  registerNativeWebDelivery(ctx, {}, { workspaceRoot, origin: 'http://example.test:18445', entryPath: 'index.html' });
  assert.equal((await request({})).status, 404);
});

const require = createRequire(import.meta.url);
const browserPath = (() => { try { return require('playwright-core').chromium.executablePath(); } catch { return null; } })();
const configuredBrowser = process.env.AGENTKIT_NATIVE_TEST_CHROMIUM ?? process.env.KSADK_BROWSER_EXECUTABLE_PATH;
const chrome = (configuredBrowser ? [configuredBrowser]
  : [browserPath, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']).find(path => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
const engineServer = import.meta.resolve('@kingsoftcloud/agentkit-harness-node/native/engine-server');
const engineView = readFileSync(process.env.AGENTKIT_ENGINE_VIEW_FILE ?? new URL('../../dist/engine-view.html', engineServer), 'utf8');
if (configuredBrowser || process.env.CI) assert.ok(chrome, 'Chromium must be installed for the engine view integration test');

test('the renderer embeds the engine view in a sandboxed iframe and relays the run\'s events',
  { skip: !chrome && 'No installed browser', timeout: 60000 }, async t => {
    const dir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.engine-view-ui-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'entry.mjs'), `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { createNativeEngineView } from ${JSON.stringify(fileURLToPath(new URL('../src/client/dsh/native-engine-view.mjs', import.meta.url)))};
      const View = createNativeEngineView({ React, fetchView: () => fetch('/view').then(r => r.text()) });
      const e = (seq, kind, extra = {}) => ({ schema: 'agentkit.engine-event/v1', seq, kind, ...extra });
      const events = [e(1, 'run.started'),
        e(5, 'model.completed', { detail: 'Checking the refund policy.', calls: [{ callId: 'c1', name: 'kb_search', arguments: { query: 'refund' } }] }),
        e(7, 'tool.completed', { title: 'kb_search', status: 'ok', callId: 'c1', result: { hits: 1 } })];
      const root = createRoot(document.getElementById('root'));
      const render = list => root.render(React.createElement(View, { node: { data: { runId: 'r1', view: '${view}', events: list, last: list.at(-1).seq } } }));
      render(events);
      const compaction = e(8, 'effect.prepared', { category: 'model', title: 'request', purpose: 'compaction' });
      const observed = [...events, compaction, e(9, 'effect.settled', { category: 'model', title: 'request' }),
        e(10, 'model.failure_observed', { status: 'retrying' })];
      const retrying = [...observed, e(11, 'effect.prepared', { category: 'model', title: 'request', retry: true })];
      window.compact = () => render([...events, compaction]);
      window.observeFailure = () => render(observed);
      window.retry = () => render(retrying);
      window.fail = () => render([...retrying,
        e(12, 'effect.settled', { category: 'model', title: 'request' }),
        e(13, 'run.terminal', { title: 'failed', status: 'failed', reason: 'provider_terminal_error',
          modelError: '模型网关拒绝了请求（HTTP 400），未自动重试。' })]);
      window.finish = () => render([...events, e(12, 'run.terminal', { title: 'completed', status: 'unverified', detail: 'Refunds are accepted within 30 days.' })]);
    `);
    const bundle = await build({ entryPoints: [join(dir, 'entry.mjs')], bundle: true, write: false, format: 'iife', platform: 'browser',
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const page = `<!doctype html><html style="color-scheme: dark"><body style="background:#151517;color:#eee"><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.url === '/view' ? engineView : page); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    t.after(() => browser.close());
    const tab = await browser.newPage();
    const errors = []; tab.on('pageerror', error => errors.push(String(error)));
    await tab.goto(`http://127.0.0.1:${server.address().port}/`);
    const iframe = tab.locator('iframe[title="任务过程"]');
    await iframe.waitFor();
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    const frame = tab.frameLocator('iframe[title="任务过程"]');
    await frame.getByText('Checking the refund policy.').waitFor({ timeout: 15000 });
    await tab.evaluate(() => window.finish());
    await frame.getByText('Refunds are accepted within 30 days.').waitFor({ timeout: 15000 });
    assert.equal(await frame.getByText('Checking the refund policy.').count(), 0, 'completed process starts folded');
    await frame.getByTestId('work-history-toggle').click();
    assert.equal(await frame.getByText('Checking the refund policy.').count(), 1, 'events already sent are not resent');
    await tab.waitForFunction(() => document.querySelector('iframe').getBoundingClientRect().height !== 160);
    // The host's dark scheme reaches the view: light text on a transparent background.
    assert.equal(await iframe.evaluate(node => node.style.colorScheme), 'dark');
    const inner = tab.frames().find(frame => frame !== tab.mainFrame());
    const colors = await inner.evaluate(() => ({ text: getComputedStyle(document.body).color, scheme: getComputedStyle(document.documentElement).colorScheme,
      bg: getComputedStyle(document.body).backgroundColor }));
    assert.equal(colors.scheme, 'dark');
    const [r, g, b] = colors.text.match(/\d+/g).map(Number);
    assert.ok(r > 180 && g > 180 && b > 180, `text should be light in dark mode, got ${colors.text}`);
    assert.match(colors.bg, /rgba\(0, 0, 0, 0\)|transparent/);
    await tab.reload();
    await frame.getByText('Checking the refund policy.').waitFor({ timeout: 15000 });
    await tab.evaluate(() => window.compact());
    await frame.getByText('正在压缩上下文…').waitFor();
    assert.equal(await frame.getByTestId('model-thinking').count(), 0);
    await tab.evaluate(() => window.observeFailure());
    assert.equal(await frame.getByTestId('model-retry').count(), 0);
    await tab.evaluate(() => window.retry());
    await frame.getByText('模型正在重试…').waitFor();
    await tab.evaluate(() => window.fail());
    const failure = frame.locator('details.harness-turn-error');
    await failure.waitFor();
    assert.equal(await failure.getAttribute('open'), null, 'terminal failure starts as a collapsed summary');
    assert.equal(await frame.getByRole('alert').count(), 0, 'a terminal failure does not add a bright alert banner');
    const reason = failure.getByText('模型网关拒绝了请求（HTTP 400），未自动重试。', { exact: true });
    assert.equal(await reason.isVisible(), false, 'the complete reason is available on demand');
    await failure.locator('summary').click();
    await reason.waitFor();
    assert.equal(await frame.getByTestId('model-retry').count(), 0);
    assert.deepEqual(errors, []);
  });
