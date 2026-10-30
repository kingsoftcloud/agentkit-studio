/** Deterministic fault-boundary and identity tests for the Native Playwright browser adapter.
 *
 * Uses a JS fake Playwright surface (Browser/Context/Page/JSHandle/Route/Socket) modeled on the
 * pinned Python reference's fakes, with JS Playwright method names (url()/isClosed()/locator()/
 * waitFor()/evaluateHandle()/getProperties()->Map). These tests exercise fault boundaries and
 * identity invariants, not merely the implementation's happy path. Real I/O is covered by the
 * live test file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical } from '../../agentkit-harness-core/dist/values.mjs';
import { compileToolInput } from '../../agentkit-harness-core/dist/tool-input.mjs';
import {
  validateBrowserObservation, validateBrowserSessionRef, validateBrowserRecovery,
  browserObservationDigest,
} from '../../agentkit-harness-core/dist/browser-contract.mjs';
import { NativePlaywrightBrowser } from '../src/native/browser-playwright.mjs';
import { NativeKernel, MemoryRunStore, configure, emptyUsage } from '../../agentkit-harness-core/dist/index.mjs';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PNG_1280 = Buffer.concat([PNG_HEADER, Buffer.from([0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x02, 0xd0])]); // 1280x720 IHDR tail
const SCOPE = { tenantId: 'tenant', workspaceId: 'workspace', userId: 'user', agentId: 'agent' };
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('action diagnostics distinguish an unacknowledged dispatch from a completed dispatch awaiting capture', async () => {
  for (const boundary of ['dispatch', 'capture_screenshot']) {
    const {adapter,browser}=makeAdapter();const ref=await adapter.open('run');
    const page=browser.contexts[0].pages[0];let release;
    const gate=new Promise(resolve=>{release=resolve;});
    if(boundary==='dispatch')page.block=gate;
    else page.screenshot=async()=>{await gate;return PNG_1280;};
    const facts=[];
    try {
      const action={actionId:'diagnostic',kind:'click',selector:'#start',timeoutMs:40};
      const out=await adapter.act(ref,action,{observeAction:fact=>facts.push(fact)});
      assert.equal(out.status,'uncertain');assert.equal(out.complete,false);
      assert.equal(facts.length,1);assert.equal(facts[0].phase,boundary);
      assert.equal(facts[0].dispatchStarted,true);assert.equal(facts[0].dispatchCompleted,boundary!=='dispatch');
      assert.equal(facts[0].outcome,'timeout');assert.equal(facts[0].errorCode,'action_timed_out');
      const replay=await adapter.act(ref,action,{observeAction:fact=>facts.push(fact)});
      assert.equal(replay.status,'uncertain');assert.equal(facts.at(-1).phase,'replay');
      assert.equal(page.calls.filter(row=>row[0]==='click').length,1);
      assert.doesNotMatch(JSON.stringify(facts),/#start|url|text|image|token/);
    } finally {release();await adapter.aclose();}
  }
});

test('observer exceptions and rejected promises cannot alter browser execution or its receipt', async () => {
  const {adapter}=makeAdapter();const ref=await adapter.open('run');
  try {
    for(const [index,observeAction] of [()=>{throw Error('observer failure');},async()=>{throw Error('async observer failure');}].entries()) {
      const out=await adapter.act(ref,{actionId:'observer-'+index,kind:'screenshot',timeoutMs:1000},{observeAction});
      assert.equal(out.status,'ok');assert.ok(out.screenshot);
    }
    await sleep(0);
  } finally {await adapter.aclose();}
});

test('a recovery fence requires acknowledged context closure, even when best-effort cleanup suppressed the failure', async () => {
  const { adapter, browser } = makeAdapter(); const ref = await adapter.open('run');
  const context = browser.contexts[0], close = context.close.bind(context);
  context.close = async () => { throw new Error('driver close failed'); };
  try {
    await adapter.close(ref);
    await assert.rejects(adapter.close(ref, { confirmClosed: true }), /driver close failed/);
    assert.equal((await adapter.recover(ref)).status, 'lost');
    context.close = close;
    await adapter.close(ref, { confirmClosed: true });
  } finally { context.close = close; await adapter.aclose(); }
});

class FakeRoute {
  constructor(url) { this._request = new FakeRequest(url); this.allowed = false; this.denied = false; this._fetch = null; }
  request() { return this._request; }
  async fetch(opts) { if (this._fetch) return this._fetch(opts); return { status: () => 200, headers: () => ({}) }; }
  async fulfill() { this.allowed = true; }
  async abort() { this.denied = true; }
}
class FakeRequest {
  constructor(url) { this._url = url; this._frame = null; }
  url() { return this._url; }
  frame() { if (this._frame) return this._frame; throw new Error('frame not available'); }
  isNavigationRequest() { return false; }
  resourceType() { return 'document'; }
}
class FakeSocket {
  constructor(url) { this._url = url; this.allowed = false; this.denied = false; }
  url() { return this._url; }
  connectToServer() { this.allowed = true; }
  async close() { this.denied = true; }
}
class FakeSnapshotHandle {
  constructor(value) { this.value = value; }
  getProperty(name) { return Promise.resolve(new FakeSnapshotHandle(this.value[name])); }
  jsonValue() { return Promise.resolve(this.value); }
  getProperties() { return Promise.resolve(new Map()); } // empty -> no element handles (refs all null)
  dispose() { return Promise.resolve(); }
}
class FakePage {
  constructor(context) {
    this.context = context;
    this._url = 'about:blank';
    this.closed = false;
    this.handlers = {};
    this.calls = [];
    this.text = 'A tiny game';
    this.block = null;
    this.actionable = true;
    this.failScreenshot = false;
    this.screenshotFailures = 0;
    this.screenshotCalls = 0;
    this.domReadFailures = 0;
    this.failClick = false;
    this.idleTimeout = false;
    this.clickOptions = [];
    this.selector = null;
    this.mask = null;
    this.mouse = {
      move: async (x, y, opts) => { this.calls.push(['move', x, y, (opts && opts.steps != null) ? opts.steps : null]); },
      wheel: async (dx, dy) => { this.calls.push(['wheel', dx, dy]); },
    };
  }
  on(name, cb) { this.handlers[name] = cb; }
  isClosed() { return this.closed; }
  url() { return this._url; }
  mainFrame() { return this; }
  locator(selector) { this.selector = selector; return this; }
  async count() {
    if (this.selector === '#unresolvable') throw Error('fixture resolution failed');
    return this.selector === '#ambiguous' ? 2 : this.selector === '#missing' ? 0 : 1;
  }
  async waitFor({ state, timeout } = {}) { if (this.selector === '#missing') throw new Error('fixture selector absent'); }
  async waitForElementState(state, { timeout } = {}) { if (this.selector === '#missing') throw new Error('fixture selector absent'); }
  async goto(url, opts = {}) {
    const route = new FakeRoute(url);
    await this.context.httpHandler(route);
    if (route.denied) throw new Error('secret diagnostic must not leak');
    this._url = url;
    this.calls.push(['navigate', url]);
  }
  async waitForLoadState(state, opts = {}) { if (this.idleTimeout) throw new Error('fixture page keeps polling'); }
  async click(opts = {}) {
    if (opts.trial) { if (!this.actionable) throw new Error('fixture overlay blocks click'); return; }
    this.calls.push(['click', this.selector]);
    this.clickOptions.push(opts);
    if (this.failClick) throw new Error('fixture dispatch did not confirm');
    if (this.block) await this.block;
  }
  async fill(value, opts = {}) { this.calls.push(['fill', value]); }
  async press(key, opts = {}) { this.calls.push(['press', key]); }
  _meta() {
    return {
      url: this._url, title: 'Game', text: this.text, focus: 'BUTTON', lifecycle: 'complete',
      scrollX: 0, scrollY: 0, pointerLockActive: false,
      controls: [
        { tag: 'button', selector: '#start', label: 'Start', role: 'button', clickable: true, hitTestReachable: true, duplicateId: false },
        { tag: 'input', selector: '#name', label: 'Name', role: 'textbox', clickable: false, hitTestReachable: true, duplicateId: false },
      ],
    };
  }
  async evaluateHandle(fn) {
    if (this.domReadFailures > 0) { this.domReadFailures -= 1; throw new Error('fixture DOM read unavailable'); }
    return new FakeSnapshotHandle({ meta: this._meta(), refElements: [] });
  }
  async screenshot(opts = {}) {
    this.screenshotCalls += 1;
    if (this.failScreenshot || this.screenshotFailures > 0) {
      this.screenshotFailures = Math.max(0, this.screenshotFailures - 1);
      throw new Error('fixture capture unavailable');
    }
    this.mask = opts.mask;
    return PNG_1280;
  }
  async close() { this.closed = true; }
}
class FakeContext {
  constructor() { this.pages = []; this.closed = false; this.httpHandler = null; this.wsHandler = null; this.handlers = {}; }
  async route(pattern, handler) { this.httpHandler = handler; }
  async routeWebSocket(pattern, handler) { this.wsHandler = handler; }
  on(name, cb) { this.handlers[name] = cb; }
  async newPage() { const page = new FakePage(this); this.pages.push(page); return page; }
  async close() { this.closed = true; for (const page of this.pages) await page.close(); }
}
class FakeBrowser {
  constructor() { this.contexts = []; this.connected = true; this.options = []; this.closed = false; }
  isConnected() { return this.connected; }
  version() { return 'fake-1'; }
  async newContext(opts = {}) { this.options.push(opts); const context = new FakeContext(); this.contexts.push(context); return context; }
  async close() { this.closed = true; }
}

function makeAdapter(opts = {}) {
  const browser = new FakeBrowser();
  const adapter = new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'runtime', workspaceRevision: 'rev1', browser, ...opts });
  return { adapter, browser };
}
const allowLocal = (_ref, url) => url.startsWith('http://127.0.0.1:') || url.startsWith('ws://127.0.0.1:');

// --- tool definition / protocol schema ---
test('tool definition pins the native_browser protocol and observation role', () => {
  const def = NativePlaywrightBrowser.definition();
  assert.equal(def.name, 'native_browser');
  assert.equal(def.observationRole, 'browser');
  assert.equal(def.progressObservation, true);
  assert.equal(def.readOnly, false);
  assert.equal(def.concurrentSafe, false);
  assert.deepEqual(def.parameters.oneOf.map((s) => s.properties.action.const),
    ['open', 'navigate', 'click', 'fill', 'press', 'move', 'scroll', 'screenshot', 'close']);
});

test('tool parameters schema admits the action protocol and rejects malformed actions', () => {
  const validate = compileToolInput(NativePlaywrightBrowser.definition().parameters);
  const ref = { session_id: 'session', generation: 1 };
  const valid = [
    { action: 'open' },
    { action: 'navigate', ...ref, url: 'http://127.0.0.1:8080/' },
    { action: 'fill', ...ref, selector: '#title', value: '' },
    { action: 'fill', ...ref, selector: '#title', value: 42 },
    { action: 'press', ...ref, selector: 'body', key: 'w', duration_ms: 300 },
    { action: 'press', ...ref, selector: 'body', key: 1 },
    { action: 'click', ...ref, selector: '#game', duration_ms: 300 },
    { action: 'click', ...ref, selector: '#game', button: 'right' },
    { action: 'click', ...ref, element_ref: 'r1' },
    { action: 'move', ...ref, x: 0, y: 360, steps: 5 },
    { action: 'screenshot', ...ref },
  ];
  const invalid = [
    { action: 'open', url: 'http://127.0.0.1:8080/' },
    { action: 'open', session_id: 'session' },
    { action: 'navigate', url: 'http://127.0.0.1:8080/' },
    { action: 'click', ...ref },
    { action: 'fill', ...ref, selector: '#title' },
    { action: 'press', ...ref, selector: 'body', key: 'w', duration_ms: 5001 },
    { action: 'fill', ...ref, selector: '#title', value: 'x', duration_ms: 1 },
    { action: 'fill', ...ref, selector: '#title', value: true },
    { action: 'press', ...ref, selector: 'body', key: 13 },
    { action: 'click', ...ref, selector: '#game', button: 'other' },
    { action: 'move', ...ref, x: 12 },
    { action: 'move', ...ref, x: 12, y: 12, steps: 31 },
    { action: 'scroll', ...ref, delta_x: 0, delta_y: 3, x: 2 },
    { action: 'scroll', ...ref, delta_x: 0, delta_y: 10001 },
  ];
  for (const args of valid) assert.ok(validate(args), JSON.stringify(args));
  for (const args of invalid) assert.ok(!validate(args), JSON.stringify(args));
});

// --- persistent sessions, real image content, isolation ---
test('persistent page actions carry real image content and a single isolated context', async () => {
  const saved = [];
  const sink = (ref, data, mime) => { saved.push([ref, data, mime]); return 'artifact://opaque/screenshot'; };
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal, artifactSink: sink });
  const ref = await tool.open('run');
  const actions = [
    { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/game?token=secret' },
    { actionId: 'click', kind: 'click', selector: '#start' },
    { actionId: 'fill', kind: 'fill', selector: '#name', value: 'player' },
    { actionId: 'press', kind: 'press', selector: 'body', key: 'w' },
  ];
  for (const [index, action] of actions.entries()) {
    const observation = await tool.act(ref, action);
    assert.equal(observation.actionSeq, index + 1);
    assert.equal(observation.status, 'ok');
    assert.equal(observation.complete, true);
    assert.equal(observation.screenshot.contentRef, 'artifact://opaque/screenshot');
    assert.equal(observation.screenshot.width, 1280);
    assert.equal(observation.screenshot.height, 720);
    const block = observation.screenshot.contentBlock;
    assert.equal(block.type, 'image_url');
    assert.ok(Buffer.from(block.image_url.url.split(',')[1], 'base64').equals(PNG_1280));
    assert.ok(!observation.url.includes('secret'));
    assert.deepEqual(observation.controls.map((c) => c.selector), ['#start', '#name']);
  }
  assert.equal(browser.contexts.length, 1);
  assert.equal(browser.contexts[0].pages.length, 1);
  assert.equal(saved.length, 4);
  assert.equal(browser.options[0].serviceWorkers, 'block');
  assert.equal(browser.options[0].acceptDownloads, false);
  assert.ok(browser.contexts[0].pages[0].mask);
  await tool.aclose();
  assert.equal(browser.contexts[0].closed, true);
  assert.equal(browser.closed, false); // borrowed browser not shut down
});

test('a borrowed injected browser is never shut down by adapter cleanup', async () => {
  const browser = new FakeBrowser();
  const tool = new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'rt', workspaceRevision: 'rev', browser });
  assert.equal(tool._ownedBrowser, false);
  await tool.open('run');
  await tool.aclose();
  assert.equal(browser.closed, false);
});

// --- no double dispatch across capture retries ---
test('a failed screenshot after a click retries observation without dispatching the click twice', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const page = browser.contexts[0].pages[0];
  page.screenshotFailures = 1;
  const observed = await tool.act(ref, { actionId: 'click', kind: 'click', selector: '#start' });
  assert.equal(observed.status, 'ok');
  assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
  assert.equal(page.screenshotCalls, 3); // navigate + two capture attempts
  await tool.aclose();
});

test('a failed DOM read after a right click retries observation without redispatching input', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const page = browser.contexts[0].pages[0];
  page.domReadFailures = 1;
  const action = { actionId: 'place', kind: 'click', selector: '#start', button: 'right' };
  const observed = await tool.act(ref, action);
  assert.equal(observed.status, 'ok');
  assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
  assert.equal(page.clickOptions[page.clickOptions.length - 1].button, 'right');
  const replay = await tool.act(ref, action);
  assert.deepEqual(replay, observed);
  assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
  await tool.aclose();
});

// --- bounded move / scroll ---
test('mouse move is bounded to the viewport and replay safe', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const page = browser.contexts[0].pages[0];
  const action = { actionId: 'hover', kind: 'move', x: 0, y: 360, steps: 5 };
  const observed = await tool.act(ref, action);
  assert.equal(observed.status, 'ok');
  const replay = await tool.act(ref, action);
  assert.deepEqual(replay, observed);
  assert.equal(page.calls.filter((c) => c[0] === 'move' && c[1] === 0 && c[2] === 360 && c[3] === 5).length, 1);
  const outside = await tool.act(ref, { actionId: 'offscreen', kind: 'move', x: 1280, y: 0 });
  assert.equal(outside.status, 'error');
  assert.equal(outside.errorCode, 'position_outside_viewport');
  assert.equal(outside.complete, true);
  assert.equal(outside.retryability, 'safe');
  assert.equal(page.calls.some((c) => c[0] === 'move' && c[1] === 1280), false);
  await tool.aclose();
});

test('scroll dispatches wheel once even when capture fails', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: (r, u) => u === 'about:blank' });
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  const dispatched = [];
  page.mouse.wheel = async (dx, dy) => { dispatched.push([dx, dy]); };
  page.domReadFailures = 1; // first capture fails, retry must not re-dispatch wheel
  const action = { actionId: 'wheel', kind: 'scroll', deltaX: -12, deltaY: 300, x: 200, y: 150 };
  const result = await tool.act(ref, action);
  assert.deepEqual(dispatched, [[-12, 300]]);
  assert.equal(page.calls.filter((c) => c[0] === 'move' && c[1] === 200 && c[2] === 150).length, 1);
  assert.equal(result.status, 'ok');
  assert.equal(result.complete, true);
  const replay = await tool.act(ref, action);
  assert.deepEqual(replay, result);
  assert.deepEqual(dispatched, [[-12, 300]]);
  await tool.aclose();
});

// --- safe feedback before mutation ---
test('target ambiguity and resolution failures are distinct safe errors for every selector input action', async () => {
  const { adapter, browser } = makeAdapter({ networkPolicy: allowLocal });const ref = await adapter.open('run');
  try {
    for (const [selector, code] of [['#ambiguous', 'selector_ambiguous'], ['#unresolvable', 'selector_resolution_failed']])
      for (const kind of ['click', 'fill', 'press']) {
        const facts = [], result = await adapter.act(ref, { actionId: kind + selector, kind, selector,
          ...(kind === 'fill' ? { value: 'text' } : kind === 'press' ? { key: 'w' } : {}) }, { observeAction: fact => facts.push(fact) });
        assert.equal(result.status, 'error');assert.equal(result.errorCode, code);
        assert.equal(result.complete, true);assert.equal(result.retryability, 'safe');
        assert.equal(facts.at(-1).dispatchStarted, false);
      }
    assert.equal(browser.contexts[0].pages[0].calls.some(([kind]) => ['click', 'fill', 'press'].includes(kind)), false);
  } finally { await adapter.aclose(); }
});
test('an unconfirmed input dispatch is a distinct uncertain error', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  browser.contexts[0].pages[0].failClick = true;
  const observed = await tool.act(ref, { actionId: 'click', kind: 'click', selector: '#start' });
  assert.equal(observed.status, 'uncertain');
  assert.equal(observed.errorCode, 'action_dispatch_failed_or_timed_out');
  await tool.aclose();
});

test('target cardinality is rechecked after a failed click trial without authorizing an input', async () => {
  const { adapter, browser } = makeAdapter({ networkPolicy: allowLocal });const ref = await adapter.open('run');
  const page = browser.contexts[0].pages[0];let matches = 1;
  page.count = async () => matches;
  page.click = async options => { assert.equal(options.trial, true);matches = 2;throw Error('DOM changed before input'); };
  try {
    const result = await adapter.act(ref, { actionId: 'changing-target', kind: 'click', selector: '.target' });
    assert.equal(result.status, 'error');assert.equal(result.errorCode, 'selector_ambiguous');
  } finally { await adapter.aclose(); }
});

test('an absent selector is safe feedback before any mutating action', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const wrong = { actionId: 'wrong', kind: 'fill', selector: '#missing', value: 'text' };
  const result = await tool.act(ref, wrong);
  const replay = await tool.act(ref, wrong);
  assert.deepEqual(result, replay);
  assert.equal(result.status, 'error');
  assert.equal(result.complete, true);
  assert.equal(result.retryability, 'safe');
  assert.equal(result.errorCode, 'selector_not_found');
  assert.equal(result.controls[1].selector, '#name');
  assert.equal(browser.contexts[0].pages[0].calls.some((c) => c[0] === 'fill' && c[1] === 'text'), false);
  const recovered = await tool.act(ref, { actionId: 'correct', kind: 'fill', selector: '#name', value: 'text' });
  assert.equal(recovered.status, 'ok');
  await tool.aclose();
});

test('an obscured click is safe feedback before dispatch', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const page = browser.contexts[0].pages[0];
  page.actionable = false;
  const blocked = { actionId: 'blocked', kind: 'click', selector: '#start' };
  const result = await tool.act(ref, blocked);
  assert.equal(result.status, 'error');
  assert.equal(result.complete, true);
  assert.equal(result.retryability, 'safe');
  assert.equal(result.errorCode, 'selector_not_actionable');
  assert.equal(page.calls.some((c) => c[0] === 'click' && c[1] === '#start'), false);
  page.actionable = true;
  const recovered = await tool.act(ref, { actionId: 'recovered', kind: 'click', selector: '#start' });
  assert.equal(recovered.status, 'ok');
  assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
  await tool.aclose();
});

test('a failed screenshot is safe to retry without terminal uncertainty', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const page = browser.contexts[0].pages[0];
  page.failScreenshot = true;
  const failed = { actionId: 'failed-capture', kind: 'screenshot' };
  const result = await tool.act(ref, failed);
  assert.equal(result.status, 'error');
  assert.equal(result.complete, true);
  assert.equal(result.retryability, 'safe');
  assert.equal(result.errorCode, 'observation_failed');
  const replay = await tool.act(ref, failed);
  assert.deepEqual(replay, result);
  page.failScreenshot = false;
  const recovered = await tool.act(ref, { actionId: 'retry-capture', kind: 'screenshot' });
  assert.equal(recovered.status, 'ok');
  await tool.aclose();
});

// --- network policy: default deny, redirects, websockets, popups ---
test('network is denied by default and revalidated on replay', async () => {
  const { adapter: tool, browser } = makeAdapter();
  const ref = await tool.open('run');
  await assert.rejects(tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'https://example.test/' }),
    (e) => e.code === 'network_denied');
  const context = browser.contexts[0];
  const route = new FakeRoute('https://example.test/subresource');
  await context.httpHandler(route);
  assert.equal(route.denied, true);
  assert.equal(route.allowed, false);
  const socket = new FakeSocket('wss://example.test/socket');
  await context.wsHandler(socket);
  assert.equal(socket.denied, true);
  assert.equal(socket.allowed, false);

  let enabled = true;
  const { adapter: allowed, browser: browser2 } = makeAdapter({ networkPolicy: () => enabled });
  const ref2 = await allowed.open('run');
  const action = { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' };
  await allowed.act(ref2, action);
  enabled = false;
  await assert.rejects(allowed.act(ref2, action), (e) => e.code === 'network_denied');
  assert.equal(browser2.contexts[0].pages[0].calls.filter((c) => c[0] === 'navigate').length, 1);
  await tool.aclose();
  await allowed.aclose();
});

test('subresources, redirects, websockets and popups all use the host policy', async () => {
  const seen = [];
  const policy = (ref, url) => { seen.push([ref.scope, url]); return allowLocal(ref, url); };
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: policy });
  await tool.open('run');
  const context = browser.contexts[0];
  for (const [url, ok] of [['http://127.0.0.1:8000/ok', true], ['https://example.test/redirect', false]]) {
    const route = new FakeRoute(url);
    await context.httpHandler(route);
    assert.equal(route.allowed, ok);
    assert.equal(route.denied, !ok);
  }
  const socket = new FakeSocket('ws://127.0.0.1:8000/ws');
  await context.wsHandler(socket);
  assert.equal(socket.allowed, true);
  const popup = new FakePage(context);
  await context.handlers.page(popup);
  assert.equal(popup.closed, true);
  assert.ok(seen.every(([scope]) => scope && scope.tenantId === SCOPE.tenantId
    && scope.workspaceId === SCOPE.workspaceId && scope.userId === SCOPE.userId && scope.agentId === SCOPE.agentId));
  await tool.aclose();
});

test('a redirect location is checked before the browser can follow', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  await tool.open('run');
  const route = new FakeRoute('http://127.0.0.1:8000/redirect');
  route._fetch = () => ({ status: () => 302, headers: () => ({ location: 'https://denied.test/private' }) });
  await browser.contexts[0].httpHandler(route);
  assert.equal(route.denied, true);
  assert.equal(route.allowed, false);
  await tool.aclose();
});

test('a popup request is denied even for an allowed origin', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  await tool.open('run');
  const context = browser.contexts[0];
  const route = new FakeRoute('http://127.0.0.1:8000/newtab');
  route._request._frame = { page: () => new FakePage(context) };
  await context.httpHandler(route);
  assert.equal(route.denied, true);
  assert.equal(route.allowed, false);
  await tool.aclose();
});

// --- response cache eviction keeps action identity without replay ---
test('image cache eviction keeps action identity without replaying the click', async () => {
  const { adapter: tool, browser } = makeAdapter({ maxCachedImages: 1 });
  const ref = await tool.open('run');
  const click = { actionId: 'click', kind: 'click', selector: 'body' };
  await tool.act(ref, click);
  await tool.act(ref, { actionId: 'shot', kind: 'screenshot' });
  const replay = await tool.act(ref, click);
  assert.equal(replay.status, 'uncertain');
  assert.equal(replay.errorCode, 'response_cache_evicted');
  assert.equal(replay.actionSeq, 1);
  assert.equal(replay.screenshot, null);
  assert.equal(browser.contexts[0].pages[0].calls.filter((c) => c[0] === 'click' && c[1] === 'body').length, 1);
  await tool.aclose();
});

test('action capacity is bounded', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal, maxActions: 2 });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'a', kind: 'screenshot' });
  await tool.act(ref, { actionId: 'b', kind: 'screenshot' });
  await assert.rejects(tool.act(ref, { actionId: 'c', kind: 'screenshot' }), (e) => e.code === 'action_capacity_reached');
  await tool.aclose();
});

// --- identity isolation ---
test('scope, runtime, workspace, generation, lease and run mismatches are rejected', async () => {
  const { adapter: tool } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.open('other-run');
  const mutations = [
    { scope: { ...SCOPE, tenantId: 'other' } }, { scope: { ...SCOPE, userId: 'other' } },
    { runtimeId: 'other' }, { workspaceRevision: 'rev2' }, { generation: 2 }, { leaseEpoch: 2 }, { runId: 'other-run' },
  ];
  for (const update of mutations) {
    await assert.rejects(tool.act({ ...ref, ...update }, { actionId: 'a', kind: 'screenshot' }), BrowserSessionErrorLike);
  }
  await tool.aclose();
});

test('action identity is idempotent but a changed payload conflicts', async () => {
  const { adapter: tool, browser } = makeAdapter();
  const ref = await tool.open('run');
  const action = { actionId: 'click', kind: 'click', selector: '#start' };
  const [first, second] = await Promise.all([tool.act(ref, action), tool.act(ref, action)]);
  assert.deepEqual(first, second);
  assert.deepEqual(browser.contexts[0].pages[0].calls, [['click', '#start']]);
  await assert.rejects(tool.act(ref, { actionId: 'click', kind: 'click', selector: '#other' }),
    (e) => e.code === 'action_conflict');
  await tool.aclose();
});

test('per-action timeout never replays a dispatched click', async () => {
  const { adapter: tool, browser } = makeAdapter();
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  // Real Playwright clicks always have a timeout; the fake's block resolves shortly so the
  // orphaned _perform (quarantined by the signal fence) settles instead of pending forever.
  page.block = new Promise((r) => setTimeout(r, 50));
  const action = { actionId: 'click', kind: 'click', selector: '#start', timeoutMs: 20 };
  const observation = await tool.act(ref, action);
  assert.equal(observation.status, 'uncertain');
  const replay = await tool.act(ref, action);
  assert.equal(replay.status, 'uncertain');
  assert.equal(replay.complete, false);
  assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
  await tool.aclose();
});

test('external cancellation never replays a dispatched click and rejects the caller', async () => {
  const { adapter: tool, browser } = makeAdapter();
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  page.block = new Promise((r) => setTimeout(r, 50));
  const action = { actionId: 'click', kind: 'click', selector: '#start', timeoutMs: 10000 };
  const ctrl = new AbortController();
  const p = tool.act(ref, action, { signal: ctrl.signal });
  while (page.calls.filter((c) => c[0] === 'click').length === 0) await sleep(0);
  ctrl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const replay = await tool.act(ref, action);
  assert.equal(replay.status, 'uncertain');
  assert.equal(replay.complete, false);
  assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
  await tool.aclose();
});

test('a hanging policy reports action_not_dispatched_timeout before any dispatch', async () => {
  const blockedPolicy = () => new Promise((r) => setTimeout(r, 50));
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: blockedPolicy });
  const ref = await tool.open('run');
  const action = { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/', timeoutMs: 10 };
  await assert.rejects(tool.act(ref, action), (e) => e.code === 'action_not_dispatched_timeout');
  assert.equal(browser.contexts[0].pages[0].calls.filter((c) => c[0] === 'navigate').length, 0);
  await tool.aclose();
});

// --- recovery / restart ---
test('recovery reports lost and explicit restart increments generation', async () => {
  const { adapter: tool, browser } = makeAdapter();
  const ref = await tool.open('run');
  assert.equal((await tool.recover(ref)).status, 'reconnected');
  assert.equal(browser.contexts.length, 1);
  const fresh = new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'runtime', workspaceRevision: 'rev1', browser: new FakeBrowser() });
  assert.equal((await fresh.recover(ref)).status, 'lost');
  const restarted = await fresh.restart(ref);
  assert.equal(restarted.status, 'restarted');
  assert.equal(restarted.sessionRef.generation, ref.generation + 1);
  assert.equal(restarted.lastActionSeq, 0);
  await assert.rejects(fresh.act(ref, { actionId: 'old', kind: 'click', selector: 'body' }), BrowserSessionErrorLike);
  browser.connected = false;
  assert.equal((await tool.recover(ref)).status, 'lost');
  await tool.aclose();
  await fresh.aclose();
});

test('recoverSessions is a read-only probe that does not restart or advance actionSeq', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  await tool.act(ref, { actionId: 'shot', kind: 'screenshot' });
  const before = tool._sessions.get(ref.sessionId).actionSeq;
  const reports = await tool.recoverSessions({ refs: [ref] });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'reconnected');
  assert.equal(reports[0].lastActionSeq, before);
  assert.equal(tool._sessions.get(ref.sessionId).actionSeq, before);
  assert.equal(browser.contexts.length, 1);
  await tool.close(ref);
  const lost = await tool.recoverSessions({ refs: [ref] });
  assert.equal(lost[0].status, 'lost');
  await tool.aclose();
});

// --- logs: incremental, truncated, sanitized ---
test('logs are incremental, truncated and sanitized', async () => {
  const { adapter: tool, browser } = makeAdapter({ maxTextChars: 32 });
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  page.text = 'x'.repeat(100);
  page.handlers.console({ type: () => 'error', text: () => 'Authorization: Bearer abcsecret' });
  page.handlers.pageerror(new Error('api_key=xyzsecret'));
  const first = await tool.act(ref, { actionId: 'one', kind: 'screenshot' });
  assert.equal(first.textTruncated, true);
  assert.ok(first.text.length <= 32);
  assert.ok(!JSON.stringify(first).includes('abcsecret'));
  assert.ok(!JSON.stringify(first).includes('xyzsecret'));
  assert.ok(first.console.length > 0 && first.pageErrors.length > 0);
  const second = await tool.act(ref, { actionId: 'two', kind: 'screenshot' });
  assert.equal(second.console.length, 0);
  assert.equal(second.pageErrors.length, 0);
  await tool.aclose();
});

test('script error locations omit query strings and foreign origins', async () => {
  const { adapter: tool } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const session = tool._sessions.get(ref.sessionId);
  tool._exceptionLocation(session, { exceptionDetails: { url: 'http://127.0.0.1:8000/broken.js?token=secret', lineNumber: 0, columnNumber: 9 } });
  tool._exceptionLocation(session, { exceptionDetails: { url: 'https://example.org/outside.js?token=secret', lineNumber: 2, columnNumber: 3 } });
  assert.deepEqual(session.errorLocations, ['/broken.js:1:10']);
  await tool.aclose();
});

// --- tool port (execute): scope/run/generation checks, typed fields, image blocks ---
test('execute admits only the bound scope/run/generation and emits typed fields with image blocks', async () => {
  const { adapter: tool } = makeAdapter();
  const def = NativePlaywrightBrowser.definition();
  const request = (args, operation = 'op', scope = SCOPE, run = 'run') => ({
    scope, runId: run, operationKey: operation, signal: undefined,
    call: { callId: 'call', name: 'native_browser', arguments: args }, definition: def,
  });
  const opened = await tool.execute(request({ action: 'open' }));
  assert.equal(opened.status, 'ok');
  const ref = opened.content.sessionRef;
  assert.equal(opened.browserSessionRef.runId, 'run');
  assert.equal(opened.browserSessionClosed, false);
  assert.deepEqual(validateBrowserSessionRef(opened.content.sessionRef), opened.browserSessionRef);
  const args = { action: 'screenshot', session_id: ref.sessionId, generation: ref.generation };
  const result = await tool.execute(request(args, 'shot'));
  assert.equal(result.status, 'ok');
  assert.equal(result.contentBlocks.length, 1);
  assert.equal(result.contentBlocks[0].type, 'image_url');
  assert.ok(result.contentBlocks[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(result.content.screenshot.contentBlock, undefined);
  assert.ok(!JSON.stringify(result.content).includes('base64'));
  assert.ok(result.content.screenshot.contentRef.startsWith('sha256:'));
  assert.ok(result.progressObservationDigest.startsWith('sha256:'));
  assert.equal(result.browserSessionRef.sessionId, ref.sessionId);
  assert.equal(result.browserObservation.sessionRef.sessionId, ref.sessionId);
  assert.equal((await tool.execute(request(args, 'shot', SCOPE, 'other'))).status, 'error');
  assert.equal((await tool.execute(request(args, 'shot', { ...SCOPE, tenantId: 'other' }))).status, 'error');
  assert.equal((await tool.execute(request({ ...args, run_id: 'other' }, 'bad'))).status, 'error');
  // a downgraded (non-browser) binding is rejected as a scope/tool mismatch with no digest
  const downgraded = { ...def, observationRole: 'none' };
  const rejected = await tool.execute({ scope: SCOPE, runId: 'run', operationKey: 'd', signal: undefined, call: { callId: 'd', name: 'native_browser', arguments: args }, definition: downgraded });
  assert.equal(rejected.status, 'error');
  assert.deepEqual(rejected.content, { error_code: 'scope_or_tool_mismatch' });
  assert.equal(rejected.progressObservationDigest, undefined);
  await tool.aclose();
});

test('close through execute emits a typed closed fact and is idempotent', async () => {
  const { adapter: tool } = makeAdapter();
  const def = NativePlaywrightBrowser.definition();
  const req = (args, op) => ({ scope: SCOPE, runId: 'tool-run', operationKey: op, signal: undefined, call: { callId: op, name: 'native_browser', arguments: args }, definition: def });
  const opened = await tool.execute(req({ action: 'open' }, 'open'));
  const ref = opened.browserSessionRef;
  const closeReq = req({ action: 'close', session_id: ref.sessionId, generation: ref.generation }, 'close');
  const closed = await tool.execute(closeReq);
  assert.equal(closed.status, 'ok');
  assert.equal(closed.browserSessionClosed, true);
  assert.equal(closed.browserSessionRef.sessionId, ref.sessionId);
  const again = await tool.execute(closeReq);
  assert.deepEqual(again, closed);
  await tool.aclose();
});

// --- idle expiry ---
test('idle expiry closes the page and does not restart', async () => {
  const { adapter: tool, browser } = makeAdapter({ idleTimeoutMs: 5 });
  const ref = await tool.open('run');
  await sleep(20);
  assert.equal(browser.contexts[0].closed, true);
  assert.equal((await tool.recover(ref)).status, 'lost');
  assert.equal(browser.contexts[0].closed, true);
  assert.equal(browser.contexts.length, 1);
  await tool.aclose();
});

// --- open idempotency ---
test('open operation key is idempotent and a closed adapter cannot reopen', async () => {
  const { adapter: tool, browser } = makeAdapter();
  const first = await tool.open('run', { operationKey: 'open-once' });
  const second = await tool.open('run', { operationKey: 'open-once' });
  assert.deepEqual(second, first);
  assert.notEqual(second, first); // independent snapshots, not the same object
  assert.equal(browser.contexts.length, 1);
  await tool.aclose();
  await assert.rejects(tool.open('run', { operationKey: 'open-once' }), (e) => e.code === 'adapter_closed');
});

// --- returned image independence / missing screenshot / sink safety ---
test('mutating a returned image does not change replay evidence', async () => {
  const { adapter: tool } = makeAdapter();
  const ref = await tool.open('run');
  const action = { actionId: 'shot', kind: 'screenshot' };
  const first = await tool.act(ref, action);
  first.screenshot.contentBlock.image_url.url = 'malicious';
  const second = await tool.act(ref, action);
  assert.ok(second.screenshot.contentBlock.image_url.url.startsWith('data:image/png;base64,'));
  await tool.aclose();
});

test('an oversize/invalid screenshot is explicit incomplete and the action is not repeated', async () => {
  const { adapter: tool, browser } = makeAdapter({ maxImageBytes: 4 });
  const ref = await tool.open('run');
  const action = { actionId: 'click', kind: 'click', selector: 'body' };
  const first = await tool.act(ref, action);
  assert.equal(first.complete, false);
  assert.equal(first.screenshot, null);
  assert.equal(first.status, 'uncertain');
  assert.equal(first.errorCode, 'screenshot_invalid_or_oversize');
  const replay = await tool.act(ref, action);
  assert.deepEqual(replay, first);
  assert.equal(browser.contexts[0].pages[0].calls.filter((c) => c[0] === 'click' && c[1] === 'body').length, 1);
  await tool.aclose();
});

test('an artifact sink cannot expose a signed url or local path', async () => {
  const { adapter: tool } = makeAdapter({ artifactSink: () => 'https://host.test/image?token=secret' });
  const ref = await tool.open('run');
  const result = await tool.act(ref, { actionId: 'shot', kind: 'screenshot' });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.errorCode, 'invalid_artifact_ref');
  assert.ok(!JSON.stringify(result).includes('token'));
  await tool.aclose();
});

// --- observation digest identity invariants (original) ---
test('observation digest excludes identity, timing and elementRef but not observed progress', async () => {
  const { adapter: tool } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  await tool.act(ref, { actionId: 'nav', kind: 'navigate', url: 'http://127.0.0.1:8000/' });
  const r1 = await tool.act(ref, { actionId: 'a1', kind: 'screenshot' });
  const r2 = await tool.act(ref, { actionId: 'a2', kind: 'screenshot' });
  assert.equal(browserObservationDigest(r1, digest), browserObservationDigest(r2, digest)); // actionId/seq excluded
  const flipped = validateBrowserObservation({ ...r2, domChangedDuringCapture: !r2.domChangedDuringCapture });
  assert.equal(browserObservationDigest(flipped, digest), browserObservationDigest(r2, digest)); // timing excluded
  const scrolled = validateBrowserObservation({ ...r2, scrollY: (r2.scrollY || 0) + 1 });
  assert.notEqual(browserObservationDigest(scrolled, digest), browserObservationDigest(r2, digest)); // progress included
  assert.equal(r2.sourceTrust, 'untrusted_page'); // never a verification verdict
  await tool.aclose();
});

// --- invalid configuration ---
test('invalid constructor configuration is rejected with stable errors', () => {
  assert.throws(() => new NativePlaywrightBrowser({ scope: SCOPE }), /invalid browser configuration/);
  assert.throws(() => new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: '', workspaceRevision: 'r' }), /invalid browser configuration/);
  assert.throws(() => new NativePlaywrightBrowser({ scope: { tenantId: '', workspaceId: 'w', userId: 'u', agentId: 'a' }, runtimeId: 'r', workspaceRevision: 'w' }), /invalid_scope/);
  assert.throws(() => new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'r', workspaceRevision: 'w', viewport: [99999, 1] }), /invalid viewport/);
  assert.throws(() => new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'r', workspaceRevision: 'w', maxActions: 0 }), /invalid observation limits/);
});

// --- async save response wait keeps the click single (idle timeout never justifies replay) ---
test('a click observation waits for its async response and idle polling keeps the effect single', async () => {
  const { adapter: tool, browser } = makeAdapter();
  try {
    const ref = await tool.open('polling-page');
    const page = browser.contexts[0].pages[0];
    page.idleTimeout = true; // waitForLoadState('networkidle') raises, but the click is already committed
    const action = { actionId: 'click-once', kind: 'click', selector: '#start' };
    const result = await tool.act(ref, action);
    assert.equal(result.status, 'ok');
    assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
    const again = await tool.act(ref, action);
    assert.deepEqual(again, result);
    assert.equal(page.calls.filter((c) => c[0] === 'click' && c[1] === '#start').length, 1);
  } finally {
    await tool.aclose();
  }
});

// --- parent-review fault regressions (immunity to the 4 blocking repro scenarios) ---
test('open returns an independent snapshot: mutating the returned ref does not corrupt the session', async () => {
  const { adapter: tool } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  ref.generation = 99; ref.scope = { ...SCOPE, tenantId: 'mutated' };
  // recover must still succeed using the session's internal (un-corrupted) identity
  const recovered = await tool.recover({ ...ref, generation: 1, scope: SCOPE });
  assert.equal(recovered.status, 'reconnected');
  // the internal session ref is untouched by the caller's mutation
  assert.equal(tool._sessions.get(ref.sessionId).ref.generation, 1);
  assert.equal(tool._sessions.get(ref.sessionId).ref.scope.tenantId, 'tenant');
  await tool.aclose();
});

test('an element_ref click that throws after dispatch is uncertain, not a safe selector error', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  tool._sessions.get(ref.sessionId).elementRefs.resolve = async () => page;
  page.failClick = true; // records the dispatch, then throws
  const out = await tool.act(ref, { actionId: 'handle-write', kind: 'click', elementRef: 'e1', timeoutMs: 1000 });
  assert.equal(out.status, 'uncertain');
  assert.equal(out.retryability, 'requires_reconcile');
  assert.equal(out.errorCode, 'action_dispatch_failed_or_timed_out');
  assert.equal(page.calls.filter((c) => c[0] === 'click').length, 1, 'the click dispatched once');
  await tool.aclose();
});

test('cancel during a blocked waitFor never dispatches the click', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  let ready, release;
  const entered = new Promise((r) => { ready = r; });
  const gate = new Promise((r) => { release = r; });
  page.waitFor = async () => { ready(); await gate; };
  const controller = new AbortController();
  const running = tool.act(ref, { actionId: 'canceled', kind: 'click', selector: '#start', timeoutMs: 1000 }, { signal: controller.signal });
  await entered;
  controller.abort();
  await running.catch(() => {});
  release();
  await sleep(25);
  assert.equal(page.calls.filter((c) => c[0] === 'click').length, 0, 'no click dispatched after cancel');
  await tool.aclose();
});

test('an already-aborted open signal is rejected and creates no context', async () => {
  const { adapter: tool, browser } = makeAdapter();
  const c = new AbortController(); c.abort();
  await assert.rejects(tool.open('run', { signal: c.signal }), isAbortError);
  assert.equal(browser.contexts.length, 0);
  await tool.aclose();
});

test('already-aborted restart, recover and close reject without side effects', async () => {
  const { adapter: tool } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const c = new AbortController(); c.abort();
  await assert.rejects(tool.restart(ref, { signal: c.signal }), isAbortError);
  await assert.rejects(tool.recover(ref, { signal: c.signal }), isAbortError);
  await assert.rejects(tool.close(ref, { signal: c.signal }), isAbortError);
  // nothing was closed/restarted: the session is still live
  assert.equal((await tool.recover(ref)).status, 'reconnected');
  await tool.aclose();
});

// --- constructor and definition independence regressions ---
test('non-finite and non-integer budgets are rejected (not Math.min(NaN) passthrough)', () => {
  const base = { scope: SCOPE, runtimeId: 'r', workspaceRevision: 'w' };
  assert.throws(() => new NativePlaywrightBrowser({ ...base, maxTextChars: NaN }), /invalid observation limits/);
  assert.throws(() => new NativePlaywrightBrowser({ ...base, maxActions: Infinity }), /invalid observation limits/);
  assert.throws(() => new NativePlaywrightBrowser({ ...base, maxImageBytes: 1.5 }), /invalid observation limits/);
  assert.throws(() => new NativePlaywrightBrowser({ ...base, idleTimeoutMs: NaN }), /invalid browser configuration/);
  assert.throws(() => new NativePlaywrightBrowser({ ...base, idleTimeoutMs: Infinity }), /invalid browser configuration/);
});

test('a sparse viewport is rejected (Array#every skips holes)', () => {
  const base = { scope: SCOPE, runtimeId: 'r', workspaceRevision: 'w' };
  const sparse = [1280]; sparse[1] = 720; sparse.length = 2; // but make a real sparse one:
  const holey = [1280, ,]; holey.length = 2;
  assert.throws(() => new NativePlaywrightBrowser({ ...base, viewport: holey }), /invalid viewport/);
  assert.throws(() => new NativePlaywrightBrowser({ ...base, viewport: [1280, 1.5] }), /invalid viewport/);
  assert.throws(() => new NativePlaywrightBrowser({ ...base, viewport: [0, 720] }), /invalid viewport/);
});

test('definition returns independent data and a valid tool timeout under the effect budget', () => {
  const a = NativePlaywrightBrowser.definition();
  const b = NativePlaywrightBrowser.definition();
  assert.notEqual(a, b); // independent objects
  assert.deepEqual(a, b); // same content
  assert.ok(a.timeoutMs > 0 && a.timeoutMs < 120000, 'tool timeoutMs must be < effectTimeoutMs (120000)');
  a.parameters.oneOf = []; // mutate one copy
  assert.notDeepEqual(a.parameters, b.parameters); // the other is untouched
  const inst = new NativePlaywrightBrowser({ scope: SCOPE, runtimeId: 'r', workspaceRevision: 'w' });
  const c = inst.definition();
  assert.notEqual(c, a); assert.notEqual(c, b);
  assert.deepEqual(c, NativePlaywrightBrowser.definition());
});

// --- second-review fault regressions (overlap, capture-retry deadline, canceled CDP open) ---
test('a canceled in-flight click quarantines the session; a new action is refused, restart permits new input', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  let release, ready; const gate = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { ready = r; });
  let active = 0, overlaps = 0;
  page.click = async (opts = {}) => {
    if (opts.trial) return;
    active++; if (active > 1) overlaps++;
    if (active === 1) { ready(); await gate; }
    active--;
  };
  const abort = new AbortController();
  const old = tool.act(ref, { actionId: 'old', kind: 'click', selector: '#start', timeoutMs: 1000 }, { signal: abort.signal });
  await entered;
  abort.abort();
  await old.catch(() => {});
  // The old click is genuinely still in-flight (JS cannot cancel it). The session is quarantined:
  // NO new page is created on the same ref/generation. A new action is refused (uncertain,
  // requires_reconcile) and never dispatches, so it cannot overlap the old in-flight click.
  const contextsBefore = browser.contexts.length;
  const next = await tool.act(ref, { actionId: 'new', kind: 'click', selector: '#start', timeoutMs: 1000 });
  assert.equal(overlaps, 0, 'the new click never ran concurrently with the old in-flight click');
  assert.equal(next.status, 'uncertain');
  assert.equal(next.retryability, 'requires_reconcile');
  assert.equal(next.errorCode, 'session_quarantined');
  assert.equal(browser.contexts.length, contextsBefore, 'no new context was created on the old ref');
  // recover reports lost for the quarantined session.
  assert.equal((await tool.recover(ref)).status, 'lost');
  // Only explicit restart(ref) — generation+1 AND leaseEpoch+1 — creates a replacement and permits
  // new input on the incremented identity.
  const restarted = await tool.restart(ref);
  assert.equal(restarted.status, 'restarted');
  assert.equal(restarted.sessionRef.generation, ref.generation + 1);
  assert.equal(restarted.sessionRef.leaseEpoch, ref.leaseEpoch + 1);
  release();
  await sleep(10);
  const fresh = await tool.act(restarted.sessionRef, { actionId: 'fresh', kind: 'screenshot' });
  assert.equal(fresh.status, 'ok');
  await tool.aclose();
});

test('a blocked capture retry honors the action deadline (no hang past timeout)', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  page.domReadFailures = 1; // first capture fails -> triggers a read-only retry
  let release, ready; const gate = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { ready = r; });
  page.screenshot = async () => { ready(); await gate; return PNG_1280; }; // retry screenshot blocks
  let settled = false;
  const action = tool.act(ref, { actionId: 'retry-capture', kind: 'click', selector: '#start', timeoutMs: 40 })
    .then(() => { settled = true; }, () => { settled = true; });
  await entered;
  await sleep(100);
  assert.equal(settled, true, 'act must settle by its deadline even when the retry screenshot blocks');
  release();
  await action;
  await tool.aclose();
});

test('cancel during CDP setup does not register a live session or leak a context', async () => {
  const { adapter: tool, browser } = makeAdapter();
  let release, ready; const gate = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { ready = r; });
  const orig = browser.newContext.bind(browser);
  browser.newContext = async (opts) => {
    const context = await orig(opts);
    context.newCDPSession = async () => ({ on() {}, async send() { ready(); await gate; } });
    return context;
  };
  const abort = new AbortController();
  const opening = tool.open('run', { signal: abort.signal });
  await entered;
  abort.abort();
  release();
  let opened = false;
  try { await opening; opened = true; } catch {}
  assert.equal(opened, false, 'a canceled open must not resolve');
  assert.equal(browser.contexts[0].closed, true, 'the late-created context is cleaned up');
  assert.equal(tool._sessions.size, 0, 'no live session is registered');
  await tool.aclose();
});

// --- quarantine revokes late network; action_conflict holds under quarantine ---
test('a quarantined session denies late route fulfillment after a pending policy resolves', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const context = browser.contexts[0];
  // A request whose policy is pending when the session is quarantined must not be fulfilled.
  let policyRelease, policyReady;
  const policyGate = new Promise((r) => { policyRelease = r; });
  const policyEntered = new Promise((r) => { policyReady = r; });
  tool._policy = (r, url) => { policyReady(); return policyGate.then(() => true); };
  const route = new FakeRoute('http://127.0.0.1:8000/late');
  const routePromise = context.httpHandler(route);
  await policyEntered;
  // Quarantine the session (close its context) while the policy is still pending.
  await tool._quarantine(tool._sessions.get(ref.sessionId));
  policyRelease();
  await routePromise;
  assert.equal(route.allowed, false, 'a quarantined session must not fulfill a late request');
  assert.equal(route.denied, true, 'the late request is aborted');
  await tool.aclose();
});

test('a quarantined session denies a late WebSocket connect after a pending policy resolves', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const context = browser.contexts[0];
  let policyRelease, policyReady;
  const policyGate = new Promise((r) => { policyRelease = r; });
  const policyEntered = new Promise((r) => { policyReady = r; });
  tool._policy = (r, url) => { policyReady(); return policyGate.then(() => true); };
  const socket = new FakeSocket('ws://127.0.0.1:8000/late-ws');
  const socketPromise = context.wsHandler(socket);
  await policyEntered;
  await tool._quarantine(tool._sessions.get(ref.sessionId));
  policyRelease();
  await socketPromise;
  assert.equal(socket.allowed, false, 'a quarantined session must not connect a late WebSocket');
  assert.equal(socket.denied, true, 'the late socket is closed');
  await tool.aclose();
});

test('a changed payload under the same actionId remains action_conflict on a quarantined session', async () => {
  const { adapter: tool, browser } = makeAdapter({ networkPolicy: allowLocal });
  const ref = await tool.open('run');
  const page = browser.contexts[0].pages[0];
  let release, ready; const gate = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { ready = r; });
  page.click = async (opts = {}) => { if (opts.trial) return; ready(); await gate; };
  const abort = new AbortController();
  const old = tool.act(ref, { actionId: 'dup', kind: 'click', selector: '#start', timeoutMs: 1000 }, { signal: abort.signal });
  await entered; abort.abort(); await old.catch(() => {});
  // Let the quarantined session's old in-flight click drain (the context close would make real
  // Playwright reject it; here releasing the gate lets the stuck fake click settle so the old
  // _act records the action_canceled tombstone).
  release();
  await sleep(10);
  // The session is quarantined with a canceled tombstone for actionId 'dup'. A replay with the
  // SAME payload returns the cached tombstone; a changed payload under the same id is a conflict.
  const replay = await tool.act(ref, { actionId: 'dup', kind: 'click', selector: '#start', timeoutMs: 1000 });
  assert.equal(replay.errorCode, 'action_canceled');
  await assert.rejects(tool.act(ref, { actionId: 'dup', kind: 'click', selector: '#other', timeoutMs: 1000 }),
    (e) => e.code === 'action_conflict');
  await tool.aclose();
});

test('cancel returns while driver cleanup is blocked and revokes the page immediately', { timeout: 2000 }, async () => {
  const { adapter, browser } = makeAdapter(), ref = await adapter.open('run');
  const context = browser.contexts[0], page = context.pages[0];
  let release, ready, closeRelease, closeReady;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { ready = resolve; });
  const closeGate = new Promise(resolve => { closeRelease = resolve; }), closeEntered = new Promise(resolve => { closeReady = resolve; });
  page.click = async options => { if (options.trial) return; ready(); await gate; };
  const original = context.close.bind(context);
  context.close = async () => { closeReady(); await closeGate; await original(); };
  const abort = new AbortController(); let settled = false;
  const pending = adapter.act(ref, { actionId: 'blocked-cleanup', kind: 'click', selector: '#start', timeoutMs: 1000 }, { signal: abort.signal })
    .then(() => assert.fail('canceled action must reject'), error => { assert.equal(error.name, 'AbortError'); settled = true; });
  try {
    await entered; abort.abort(); await closeEntered; await sleep(40);
    assert.equal(settled, true, 'driver cleanup cannot postpone cancellation');
    assert.equal((await adapter.recover(ref)).status, 'lost');
    assert.equal((await adapter.act(ref, { actionId: 'later', kind: 'click', selector: '#start' })).errorCode, 'session_quarantined');
  } finally { closeRelease(); release(); await pending; await adapter.aclose(); }
});

test('timeout of a queued attempt cannot quarantine another active action', { timeout: 2000 }, async () => {
  const { adapter, browser } = makeAdapter(), ref = await adapter.open('run'), page = browser.contexts[0].pages[0];
  let release, ready; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { ready = resolve; });
  const click = page.click.bind(page);
  page.click = async options => { if (options.trial) return; ready(); await gate; await click(options); };
  const first = adapter.act(ref, { actionId: 'active', kind: 'click', selector: '#start', timeoutMs: 1000 });
  await entered;
  const keepAlive = setTimeout(() => {}, 250);
  try {
    await assert.rejects(adapter.act(ref, { actionId: 'queued', kind: 'click', selector: '#start', timeoutMs: 15 }),
      error => error.code === 'action_not_dispatched_timeout');
    assert.equal(adapter._sessions.get(ref.sessionId).quarantined, false);
    release(); assert.equal((await first).status, 'ok');
    assert.equal((await adapter.recover(ref)).status, 'reconnected');
    assert.equal(page.calls.filter(row => row[0] === 'click').length, 1);
  } finally { clearTimeout(keepAlive); release(); await first; await adapter.aclose(); }
});

test('canceling a started close revokes ownership without waiting on blocked shutdown', { timeout: 2000 }, async () => {
  const { adapter, browser } = makeAdapter(), ref = await adapter.open('run'), context = browser.contexts[0];
  let release, ready; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { ready = resolve; });
  const close = context.close.bind(context);
  context.close = async () => { ready(); await gate; await close(); };
  const abort = new AbortController(); let settled = false;
  const closing = adapter.act(ref, { actionId: 'close', kind: 'close', timeoutMs: 1000 }, { signal: abort.signal })
    .then(() => assert.fail('canceled close must reject'), error => { assert.equal(error.name, 'AbortError'); settled = true; });
  try {
    await entered; abort.abort(); await sleep(40);
    assert.equal(settled, true); assert.equal((await adapter.recover(ref)).status, 'lost');
  } finally { release(); await closing; await adapter.aclose(); }
});

test('adapter cleanup does not wait for an abandoned quarantined action lock', { timeout: 2000 }, async () => {
  const { adapter, browser } = makeAdapter(), ref = await adapter.open('run'), page = browser.contexts[0].pages[0];
  let release, ready; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { ready = resolve; });
  page.click = async options => { if (options.trial) return; ready(); await gate; };
  const abort = new AbortController(), running = adapter.act(ref, { actionId: 'abandoned', kind: 'click', selector: '#start' }, { signal: abort.signal });
  try {
    await entered; abort.abort(); await assert.rejects(running, isAbortError);
    assert.equal(await Promise.race([adapter.aclose().then(() => true), sleep(60).then(() => false)]), true);
    assert.equal(browser.contexts[0].closed, true);
  } finally { release(); await running.catch(() => {}); }
});

test('generic tool delivers screenshot media through the actual Native Kernel tool context', async () => {
  const { adapter } = makeAdapter(), def = adapter.definition();
  const config = configure({ profile: { profileId: 'test', profileVersion: '1', providerFamily: 'fixture', compatibilityDigest: 'fixture/v1' },
    contract: { objective: 'Inspect the current image' }, tools: [def], hostBindingDigest: 'browser/v1' });
  const store = new MemoryRunStore(); let models = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'browser-test', ports: { tools: adapter, model: { generate: async request => {
    models++;
    if (models === 1) return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'open', name: def.name, arguments: { action: 'open' } }] };
    if (models === 2) {
      const ref = JSON.parse(request.messages.find(message => message.role === 'tool').content).sessionRef;
      return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: 'capture', name: def.name,
        arguments: { action: 'screenshot', session_id: ref.sessionId, generation: ref.generation } }] };
    }
    const message = request.messages.filter(message => message.role === 'tool').at(-1);
    assert.equal(message.media[0].type, 'image_url');
    assert.deepEqual(Buffer.from(message.media[0].image_url.url.split(',')[1], 'base64'), PNG_1280);
    assert.equal(message.content.includes('base64'), false);
    return { kind: 'final_candidate', text: 'Observed, acceptance unverified.', toolCalls: [], usage: emptyUsage() };
  } } } });
  try {
    kernel.start({ scope: SCOPE, runId: 'run', sessionId: 'session', turnId: '1', buildId: 'test', taskChainId: 'run', parentRunId: null }, config);
    const done = await kernel.runUntilIdle(SCOPE, 'run');
    assert.equal(done.phase, 'completed'); assert.equal(done.outcome, 'unverified'); assert.equal(models, 3);
    assert.ok(done.lastBrowserObservation); assert.equal(done.browserSessionRefs.length, 1);
  } finally { await adapter.aclose(); }
});

/** Matches any BrowserSessionError (NativeError subclass carrying a stable code). */
function BrowserSessionErrorLike(e) { return e && typeof e.code === 'string' && e.name === 'BrowserSessionError'; }
const isAbortError = (e) => e && e.name === 'AbortError';
