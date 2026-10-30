/** Live Playwright tests for the Native browser adapter against loopback-only HTTP fixtures.
 *
 * Injects a cached Chromium browser (launched via @playwright/test's chromium driver against a
 * cached executable, no download) into the adapter. No external network: the network policy allows
 * only the loopback fixture origin. Covers navigation/click/fill/press/move/scroll, screenshot
 * bytes, element refs (same-node-after-reorder and replaced-node-stale), blocked external
 * request/redirect/WebSocket, run isolation, restart/old-ref rejection, password masking and
 * cleanup. If no cached Chromium is available the suite is reported as skipped (not silently
 * passed) so the environment blocker is visible. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { NativePlaywrightBrowser } from '../src/native/browser-playwright.mjs';
import { createStudioBrowserWorkspacePort } from '../src/native/browser-workspace.mjs';
import { NativeKernel, configure, canonical, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../src/native/sqlite-store.mjs';
import { createHash } from 'node:crypto';

const SCOPE = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };

/** Locate the Playwright browser cache portably (macOS / Linux / Windows). */
function playwrightCache() {
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform() === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}
const CACHE = playwrightCache();

/** Find a cached Chromium executable across revision directories and platform layouts. */
function findChromiumExecutable() {
  if (process.env.AGENTKIT_NATIVE_TEST_CHROMIUM) return process.env.AGENTKIT_NATIVE_TEST_CHROMIUM;
  try {
    const dirs = readdirSync(CACHE).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) {
      const macos = join(CACHE, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
      if (existsSync(macos)) return macos;
      const linux = join(CACHE, d, 'chrome-linux', 'chrome');
      if (existsSync(linux)) return linux;
    }
  } catch {}
  // Fall back to the driver's expected executable (may point to a missing revision).
  try { const ep = chromium.executablePath(); if (existsSync(ep)) return ep; } catch {}
  return null;
}

const EXECUTABLE = findChromiumExecutable();
const AVAILABLE = EXECUTABLE != null;
const skip = (name, fn) => test(name, { timeout: 60000, skip: AVAILABLE ? false : 'no cached Chromium executable' }, fn);

let browser = null;
let server = null;
let origin = null;
const hits = [];

before(async () => {
  if (!AVAILABLE) return;
  browser = await chromium.launch({ headless: true, executablePath: EXECUTABLE });
  const html = (extra = '') => `<!doctype html><title>Local fixture</title>
    <button id="start" onclick="this.textContent='count:'+ ++window.count">start</button>
    <input id="name" aria-label="Name">
    <input id="password" type="password" value="test-secret">
    <p id="key">no key</p>
    <div id="scroll" style="height:2000px;width:100px;background:#eee">tall</div>
    <script>window.count=0;document.addEventListener('keydown',e=>document.querySelector('#key').textContent=e.key);${extra}</script>`;
  const handler = (req, res) => {
    hits.push(req.url);
    if (req.url === '/redirect-first' || req.url === '/redirect-second') {
      res.writeHead(302, { location: req.url === '/redirect-first' ? '/redirect-second' : '/forbidden' });
      res.end();
    } else if (req.url === '/forbidden') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html());
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html(req.url === '/' ? "console.log('local fixture ready');" : ''));
    }
  };
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
});

const allowOrigin = (ref, url) => {
  if (!url) return false;
  try { const u = new URL(url); return u.origin === origin && u.pathname !== '/forbidden'; } catch { return false; }
};
const pageOf = (tool, ref) => tool._sessions.get(ref.sessionId).page;

function tool() {
  return new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'live', workspaceRevision: 'fixture', networkPolicy: allowOrigin, browser });
}

skip('navigate, click, fill, press, move, scroll, screenshot bytes and element refs', async () => {
  const t = tool();
  try {
    const ref = await t.open('run');
    const nav = await t.act(ref, { actionId: 'nav', kind: 'navigate', url: origin + '/' });
    assert.equal(nav.status, 'ok');
    assert.ok(nav.screenshot.width === 1280);
    assert.ok(Buffer.from(nav.screenshot.contentBlock.image_url.url.split(',')[1], 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    assert.ok(nav.console.length > 0, 'fixture console log captured');
    const selectors = new Set(nav.controls.map((c) => c.selector));
    assert.ok(selectors.has('#start') && selectors.has('#name'));
    assert.ok(!selectors.has('#password'), 'password input is not an offered control');
    assert.ok(!JSON.stringify(nav).includes('test-secret'), 'password value never leaks');
    assert.ok(nav.controls.every((c) => c.elementRef != null), 'observed controls carry element refs');

    const clicked = await t.act(ref, { actionId: 'click', kind: 'click', selector: '#start' });
    assert.equal(clicked.status, 'ok');
    assert.match(clicked.text, /count:1/);
    const filled = await t.act(ref, { actionId: 'fill', kind: 'fill', selector: '#name', value: 'player' });
    assert.equal(filled.status, 'ok');
    assert.ok(!filled.controls.some((c) => c.label === 'player'), 'fill value is not echoed as a control label');
    const pressed = await t.act(ref, { actionId: 'press', kind: 'press', selector: 'body', key: 'w' });
    assert.equal(pressed.status, 'ok');
    assert.match(pressed.text, /w/);
    const moved = await t.act(ref, { actionId: 'move', kind: 'move', x: 10, y: 20, steps: 3 });
    assert.equal(moved.status, 'ok');
    const scrolled = await t.act(ref, { actionId: 'scroll', kind: 'scroll', deltaX: 0, deltaY: 500 });
    assert.equal(scrolled.status, 'ok');
    assert.ok(scrolled.scrollY > 0, 'observed scroll offset reflects the dispatched wheel');
  } finally { await t.aclose(); }
});

skip('an observed element ref targets the same node after sibling insertion', async () => {
  const t = tool();
  try {
    const ref = await t.open('run');
    const page = pageOf(t, ref);
    await page.goto(origin + '/');
    const observed = await t.act(ref, { actionId: 'observe', kind: 'screenshot' });
    const control = observed.controls.find((c) => c.selector === '#start');
    assert.ok(control && control.elementRef);
    await page.evaluate(() => {
      const node = document.querySelector('#start').cloneNode(true);
      node.id = 'clone'; node.setAttribute('onclick', 'window.selected="replacement"');
      document.body.prepend(node);
    });
    const clicked = await t.act(ref, { actionId: 'act-on-original', kind: 'click', elementRef: control.elementRef });
    assert.equal(clicked.status, 'ok');
    assert.equal(await page.evaluate(() => window.count), 1, 'the original button was clicked, not the inserted clone');
    const replay = await t.act(ref, { actionId: 'act-on-original', kind: 'click', elementRef: control.elementRef });
    assert.deepEqual(replay, clicked);
    assert.equal(await page.evaluate(() => window.count), 1, 'replay never redispatched the click');
  } finally { await t.aclose(); }
});

skip('a replaced node ref is a safe error with a fresh observation', async () => {
  const t = tool();
  try {
    const ref = await t.open('run');
    const page = pageOf(t, ref);
    await page.goto(origin + '/');
    await page.setContent("<button id='same' onclick='window.clicked=true'>Old</button>");
    const observed = await t.act(ref, { actionId: 'observe', kind: 'screenshot' });
    const token = observed.controls[0].elementRef;
    assert.ok(token);
    await page.evaluate(() => { const n = document.querySelector('#same'); n.replaceWith(n.cloneNode(true)); });
    const result = await t.act(ref, { actionId: 'stale', kind: 'click', elementRef: token });
    assert.equal(result.status, 'error');
    assert.equal(result.complete, true);
    assert.equal(result.retryability, 'safe');
    assert.equal(result.errorCode, 'element_ref_stale');
    assert.ok(result.controls[0].elementRef && result.controls[0].elementRef !== token);
    assert.equal(await page.evaluate(() => Boolean(window.clicked)), false);
  } finally { await t.aclose(); }
});

skip('a blocked external request, redirect and websocket are logged as network failures', async () => {
  const t = tool();
  try {
    const ref = await t.open('run');
    const page = pageOf(t, ref);
    await page.goto(origin + '/');
    hits.length = 0;
    await page.evaluate(async () => {
      try { await fetch('https://example.test/external'); } catch {}
      try { new WebSocket('wss://example.test/socket'); } catch {}
    });
    await new Promise((r) => setTimeout(r, 150)); // let the websocket route handler run before capture
    const shot = await t.act(ref, { actionId: 'shot-ext', kind: 'screenshot' });
    const failures = shot.networkFailures.join('\n');
    assert.match(failures, /network_denied.*example\.test\/external/);
    assert.match(failures, /websocket_denied.*example\.test\/socket/);

    const beforeForbidden = hits.includes('/forbidden');
    const redirect = await t.act(ref, { actionId: 'redirect', kind: 'navigate', url: origin + '/redirect-first' });
    assert.notEqual(redirect.status, 'ok');
    assert.equal(hits.includes('/forbidden'), beforeForbidden, 'the denied redirect target was never served');
    assert.ok(t._sessions.get(ref.sessionId).failures.some((f) => f.includes('redirect_denied') || f.includes('forbidden')));
  } finally { await t.aclose(); }
});

skip('each run gets an isolated context and page', async () => {
  const t = tool();
  try {
    const ref = await t.open('run-a');
    const other = await t.open('run-b');
    assert.notEqual(ref.sessionId, other.sessionId);
    assert.equal(browser.contexts().length, 2);
    assert.equal((await t.recover(ref)).status, 'reconnected');
  } finally { await t.aclose(); }
});

skip('restart increments generation and rejects the old ref', async () => {
  const t = tool();
  try {
    const ref = await t.open('run');
    const restarted = await t.restart(ref);
    assert.equal(restarted.status, 'restarted');
    assert.equal(restarted.sessionRef.generation, ref.generation + 1);
    assert.equal(restarted.sessionRef.sessionId, ref.sessionId);
    await assert.rejects(t.act(ref, { actionId: 'old', kind: 'screenshot' }), (e) => e.code === 'stale_session_ref');
    // the restarted ref is usable
    const ok = await t.act(restarted.sessionRef, { actionId: 'fresh', kind: 'screenshot' });
    assert.equal(ok.status, 'ok');
  } finally { await t.aclose(); }
});

skip('cleanup closes contexts but not the borrowed browser', async () => {
  const t = tool();
  const ref = await t.open('run');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await t.aclose();
  assert.equal(page.isClosed(), true, 'the session page is closed');
  assert.equal(browser.contexts().includes(ctx), false, 'the context is removed from the browser');
  assert.equal(browser.isConnected(), true, 'borrowed browser stays connected');
});

skip('Host-launched Chromium is owned and disconnected by adapter cleanup', async () => {
  let owned;
  const adapter = new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'owned', workspaceRevision: 'fixture',
    launchBrowser: async () => { owned = await chromium.launch({ headless: true, executablePath: EXECUTABLE }); return owned; } });
  try { const ref = await adapter.open('owned-run'); assert.equal((await adapter.recover(ref)).status, 'reconnected'); }
  finally { await adapter.aclose(); }
  assert.equal(owned.isConnected(), false);
});

function workspaceFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'native-browser-workspace-live-')), root = join(directory, 'workspace');
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'index.html'), `<!doctype html><title>Workspace</title>
    <button id="start" onclick="this.textContent='count:'+ ++window.count">Start</button>
    <input id="name"><script src="app.js"></script>`);
  writeFileSync(join(root, 'app', 'app.js'), 'window.count=0;');
  const trace = [], owners = [];
  async function openOwner() {
    let backend;
    const port = await createStudioBrowserWorkspacePort({ scope: SCOPE, root, runtimeId: 'workspace-live', reobserveAfterLoss: true,
      evidenceRoot: join(directory, 'evidence'), createBrowser: options => {
        backend = new NativePlaywrightBrowser({ ...options, browser });
        const act = backend.act.bind(backend);
        backend.act = async (ref, action, options) => { trace.push({ ref, action }); return act(ref, action, options); };
        return backend;
      } });
    owners.push(port); return { port, backend };
  }
  const request = (operationKey, actions = [], runId = 'workspace-run') => ({ scope: SCOPE, runId, operationKey,
    signal: new AbortController().signal, call: { callId: operationKey, name: 'browser_inspect_workspace',
      arguments: { path: 'app', actions, wait_ms: 0 } } });
  return { directory, root, trace, openOwner, request, async close() {
    try { for (const owner of owners) await owner.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  } };
}

skip('actual workspace browser enforces its advertised network boundary and can verify a local replacement without external requests', async () => {
  const fixture = workspaceFixture();
  try {
    writeFileSync(join(fixture.root, 'app', 'index.html'), '<!doctype html><title>Boundary</title><script src="https://external.invalid/dependency.js"></script>');
    const { port } = await fixture.openOwner();
    const capability = port.capability;
    assert.equal(capability.availability, 'available'); assert.equal(capability.externalNetwork, false);
    assert.equal(capability.networkPolicy, 'workspace-origin/v1'); assert.deepEqual(capability.viewport, [1280, 720]);
    const request = (...args) => ({ ...fixture.request(...args), definition: port.definition });
    const denied = await port.execute(request('external-dependency'));
    assert.equal(denied.status, 'error'); assert.equal(denied.content.rendered, true);
    assert.match(denied.content.request_failures.join('\n'), /network_denied: https:\/\/external\.invalid\/dependency\.js/);
    writeFileSync(join(fixture.root, 'app', 'index.html'), '<!doctype html><title>Local dependency</title><script src="app.js"></script><button>Ready</button>');
    const local = await port.execute(request('local-dependency', [{ type: 'reload' }]));
    assert.equal(local.status, 'ok'); assert.equal(local.content.status_code, 200);
    assert.equal(local.content.request_failures.length, 0); assert.equal(local.content.page_errors.length, 0);
    assert.equal(port.capability.externalNetwork, false, 'successful local fallback did not widen permissions');
  } finally { await fixture.close(); }
});

skip('real Studio page owner serves workspace assets, retains interactions and captures fresh cold verification', async () => {
  const fixture = workspaceFixture();
  try {
    const { port } = await fixture.openOwner();
    const request = (...args) => ({ ...fixture.request(...args), definition: port.definition });
    const first = await port.execute(request('click', [{ type: 'click', selector: '#start' }]));
    assert.equal(first.status, 'ok'); assert.match(first.browserObservation.text, /count:1/);
    const next = await port.execute(request('observe'));
    assert.equal(next.status, 'ok'); assert.match(next.browserObservation.text, /count:1/);
    assert.deepEqual(next.browserSessionRef, first.browserSessionRef);
    assert.ok(readFileSync(join(fixture.root, '.artifacts', 'browser-check.png')).subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(next.context.media[0].type, 'image_url');
    const cold = await port.verifyPage({ runId: 'workspace-run', entryPath: 'app/index.html', candidateId: 'candidate' });
    assert.equal(cold.status, 'ok'); assert.match(cold.text, /count:1/);
    assert.notEqual(cold.sessionRef.sessionId, first.browserSessionRef.sessionId);
    assert.equal(browser.contexts().length, 1, 'cold verification context closed, interactive context remains');
    const coldAgain = await port.verifyPage({ runId: 'workspace-run', entryPath: 'app/index.html', candidateId: 'candidate' });
    assert.notEqual(coldAgain.sessionRef.runId, cold.sessionRef.runId);
    writeFileSync(join(fixture.root, 'app', 'app.js'), 'window.count=0;document.querySelector("#start").textContent="Updated";');
    const changed = await port.execute(request('source-changed'));
    assert.equal(changed.status, 'ok'); assert.match(changed.browserObservation.text, /Updated/);
    assert.equal(fixture.trace.filter(row => row.action.kind === 'click' && row.ref.runId === 'workspace-run').length, 1);
  } finally { await fixture.close(); }
  assert.equal(browser.contexts().length, 0);
});

skip('real page loss refuses old input and only explicit reload advances the owner generation', async () => {
  const fixture = workspaceFixture();
  try {
    const { port, backend } = await fixture.openOwner();
    const request = (...args) => ({ ...fixture.request(...args), definition: port.definition });
    const initial = await port.execute(request('click', [{ type: 'click', selector: '#start' }])), ref = initial.browserSessionRef;
    await backend._sessions.get(ref.sessionId).context.close();
    const reports = await port.recoverSessions({ refs: [ref], signal: new AbortController().signal });
    assert.equal(reports[0].status, 'lost'); assert.equal(reports[0].reobserveAvailable, true);
    const rejected = await port.execute(request('stale-click', [{ type: 'click', selector: '#start' }]));
    assert.equal(rejected.status, 'error');
    assert.equal(fixture.trace.filter(row => row.action.kind === 'click').length, 1);
    const fresh = await port.execute(request('reload', [{ type: 'reload' }]));
    assert.equal(fresh.status, 'ok'); assert.equal(fresh.browserSessionRef.generation, ref.generation + 1);
    assert.equal(fresh.browserSessionRef.leaseEpoch, ref.leaseEpoch + 1); assert.match(fresh.browserObservation.text, /Start/);
    assert.equal(fixture.trace.filter(row => row.action.kind === 'click').length, 1);
  } finally { await fixture.close(); }
});

skip('actual Chromium owner and reopened SQLite require new evidence without replaying old clicks', async () => {
  const fixture = workspaceFixture(), filename = join(fixture.directory, 'run.sqlite');
  let store = new SqliteRunStore(filename), models = 0;
  const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
  try {
    const original = await fixture.openOwner();
    const config = configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'live/v1' },
      tools: [original.port.definition], contract: { objective: 'Inspect the actual page' }, hostBindingDigest: 'chromium-owner/v1',
      limits: { maxModelCalls: 5 } });
    const ports = owner => ({ browser: owner, tools: owner, model: { generate: async request => {
      models++;
      if (models === 1 || models === 3) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{
        callId: `browser-${models}`, name: 'browser_inspect_workspace', arguments: { path: 'app', wait_ms: 0,
          actions: models === 1 ? [{ type: 'click', selector: '#start' }] : [{ type: 'reload' }] },
      }] };
      assert.ok(request.messages.some(message => message.role === 'tool' && message.media?.length));
      return { kind: 'final_candidate', text: 'Observed; acceptance still unverified.', toolCalls: [], usage: emptyUsage() };
    } } });
    let interrupted = false;
    const first = new NativeKernel({ store, digest, owner: 'before-restart', ports: ports(original.port), onCheckpoint: async snapshot => {
      if (!interrupted && snapshot.lastBrowserObservation) { interrupted = true; throw Error('delivery interrupted after capture'); }
    } });
    first.start({ scope: SCOPE, runId: 'workspace-run', sessionId: 'session', turnId: '1', buildId: 'test', parentRunId: null, taskChainId: 'workspace-run' }, config);
    await assert.rejects(first.runUntilIdle(SCOPE, 'workspace-run'), /delivery interrupted after capture/);
    const old = store.load(SCOPE, 'workspace-run').snapshot.lastBrowserObservation.sessionRef;
    await original.port.close(); store.close(); store = new SqliteRunStore(filename);
    const replacement = await fixture.openOwner();
    const done = await new NativeKernel({ store, digest, owner: 'after-restart', ports: ports(replacement.port) }).runUntilIdle(SCOPE, 'workspace-run');
    assert.equal(done.phase, 'completed'); assert.equal(done.outcome, 'unverified'); assert.equal(models, 4);
    assert.equal(done.lastBrowserObservation.sessionRef.generation, old.generation + 1);
    assert.equal(done.lastBrowserObservation.sessionRef.leaseEpoch, old.leaseEpoch + 1);
    assert.deepEqual(done.browserReobservationRefs, []);
    assert.equal(fixture.trace.filter(row => row.action.kind === 'click').length, 1);
  } finally { store.close(); await fixture.close(); }
});

for (const stage of ['proposed', 'prepared']) skip(`Chromium + SQLite: lost owner retires a ${stage} click and completes a fresh capture in the same Run`, async () => {
  const fixture = workspaceFixture(), filename = join(fixture.directory, 'run.sqlite');
  let store = new SqliteRunStore(filename), recovering = false, freshRequested = false, models = 0;
  const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
  const runId = 'workspace-run';
  try {
    const original = await fixture.openOwner();
    const config = configure({ profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'live/v1' },
      tools: [original.port.definition], contract: { objective: 'Inspect the actual page after recovery' },
      hostBindingDigest: 'chromium-replan/v1', limits: { maxModelCalls: 5 } });
    const ports = owner => ({ browser: owner, tools: owner, model: { generate: async request => {
      models++;
      if (recovering) {
        const retired = request.messages.find(row => row.role === 'tool' && row.callId === 'old-action');
        assert.ok(retired);assert.equal(JSON.parse(retired.content).executed, false);
        if (freshRequested) return { kind: 'final_candidate', text: 'Fresh page observed; acceptance remains unverified.', toolCalls: [], usage: emptyUsage() };
        freshRequested = true;
      }
      const id = recovering ? 'fresh-observation' : models === 1 ? 'initial-click' : 'old-action';
      return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: id,
        name: 'browser_inspect_workspace', arguments: { path: 'app', wait_ms: 0,
          actions: recovering ? [{ type: 'reload' }] : [{ type: 'click', selector: '#start' }] } }] };
    } } });
    const first = new NativeKernel({ store, digest, owner: 'original', ports: ports(original.port), onCheckpoint: async snapshot => {
      if (snapshot.phase !== 'executing_tools' || snapshot.pendingTools[0]?.callId !== 'old-action') return;
      const pending = store.authority(SCOPE, runId).pendingIntent;
      if (stage === 'proposed' ? pending === null : pending?.status === 'prepared') throw Error('delivery boundary lost');
    } });
    first.start({ scope: SCOPE, runId, sessionId: 'session', turnId: '1', buildId: 'test', parentRunId: null, taskChainId: runId }, config);
    await assert.rejects(first.runUntilIdle(SCOPE, runId), /delivery boundary lost/);
    const before = store.load(SCOPE, runId), ref = before.snapshot.browserSessionRefs[0];
    assert.equal(fixture.trace.filter(row => row.action.kind === 'click').length, 1);
    await original.port.close();store.close();store = new SqliteRunStore(filename);
    recovering = true;const replacement = await fixture.openOwner();
    const done = await new NativeKernel({ store, digest, owner: 'replacement', ports: ports(replacement.port) }).runUntilIdle(SCOPE, runId);
    assert.equal(done.runId, runId);assert.equal(done.phase, 'completed');assert.equal(done.outcome, 'unverified');
    assert.equal(models, 4);assert.deepEqual(done.browserReobservationRefs, []);
    assert.equal(done.lastBrowserObservation.sessionRef.generation, ref.generation + 1);
    assert.equal(done.lastBrowserObservation.sessionRef.leaseEpoch, ref.leaseEpoch + 1);
    assert.equal(fixture.trace.filter(row => row.action.kind === 'click').length, 1, 'the proposed old click never reaches Chromium');
    const record = store.load(SCOPE, runId);
    assert.equal(record.events.filter(event => event.kind === 'tool.not_dispatched' && event.payload.callId === 'old-action').length, 1);
    if (stage === 'prepared') assert.equal(record.receipts.find(row => row.operationKey === before.snapshot.pendingIntent).status, 'not_dispatched');
  } finally { store.close();await fixture.close(); }
});
