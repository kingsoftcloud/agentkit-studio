// Studio's chat node for Native engine runs: grouping from Session events, and
// a real-browser check that the renderer embeds the engine-delivered view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { createNativeEngineRuntime } from '../src/providers/native-engine-runtime.mjs';
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

const require = createRequire(import.meta.url);
const browserPath = (() => { try { return require('playwright-core').chromium.executablePath(); } catch { return null; } })();
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', browserPath].find(path => { try { return path && readFileSync(path, { flag: 'r' }) && true; } catch { return false; } });
const engineView = process.env.AGENTKIT_ENGINE_VIEW_FILE ? readFileSync(process.env.AGENTKIT_ENGINE_VIEW_FILE, 'utf8') : null;

test('the renderer embeds the engine view in a sandboxed iframe and relays the run\'s events',
  { skip: !chrome ? 'No installed browser' : !engineView ? 'engine view not built' : false, timeout: 60000 }, async t => {
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
    assert.deepEqual(errors, []);
  });
