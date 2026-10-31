import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { NativePlaywrightBrowser } from '../src/native/browser-playwright.mjs';
import { resolveNativeBrowserExecutable } from '../src/native/browser-availability.mjs';

const executablePath = resolveNativeBrowserExecutable();
test('real Chromium: ambiguous canvas cannot dispatch input or masquerade as invisible; a unique target works',
  { skip: executablePath ? false : 'No installed browser executable', timeout: 15000 }, async t => {
    const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html');res.end(`<!doctype html>
      <canvas id="icon" width="32" height="32"></canvas><canvas id="scene" width="320" height="200"></canvas>
      <p id="count">clicks:0</p><script>let n=0;document.querySelector('#scene').onclick=()=>document.querySelector('#count').textContent='clicks:'+ ++n;</script>`); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections();return new Promise(resolve => server.close(resolve)); });
    const browser = await chromium.launch({ executablePath, headless: true });t.after(() => browser.close());
    const origin = 'http://127.0.0.1:' + server.address().port;
    const adapter = new NativePlaywrightBrowser({ scope: { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' },
      runtimeId: 'target-test', workspaceRevision: 'fixture', browser,
      networkPolicy: (_ref, url) => url === 'about:blank' || url.startsWith(origin + '/') });
    t.after(() => adapter.aclose());const ref = await adapter.open('run');
    assert.equal((await adapter.act(ref, { actionId: 'load', kind: 'navigate', url: origin + '/' })).status, 'ok');
    const facts = [], ambiguous = await adapter.act(ref, { actionId: 'ambiguous', kind: 'click', selector: 'canvas' },
      { observeAction: value => facts.push(value) });
    assert.equal(ambiguous.status, 'error');assert.equal(ambiguous.errorCode, 'selector_ambiguous');
    assert.equal(facts[0].dispatchStarted, false);assert.match(ambiguous.text, /clicks:0/);
    const clicked = await adapter.act(ref, { actionId: 'specific', kind: 'click', selector: '#scene' });
    assert.equal(clicked.status, 'ok');assert.match(clicked.text, /clicks:1/);
    const malformed = await adapter.act(ref, { actionId: 'malformed', kind: 'click', selector: '[' });
    assert.equal(malformed.status, 'error');assert.equal(malformed.errorCode, 'selector_resolution_failed');
    assert.match(malformed.text, /clicks:1/);
  });
