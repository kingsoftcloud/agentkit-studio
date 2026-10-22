/** Cloud browser tool surface: URL policy, registration, bounded outputs, CDP harness and disposal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BROWSER_TOOLS, MAX_SCREENSHOT_BASE64, MAX_SNAPSHOT_BYTES, createCloudBrowser,
  isRefusedAddress, registerAssistantCloudBrowserTools, resolveCloudBrowser, urlPolicy,
} from '../src/assistant-cloud-browser.mjs';
import { CdpConnection } from '../src/assistant-cloud-browser-cdp.mjs';

const PNG_BASE64 = 'cG5n';

function fakeSpawn({ port = 9222, wsPath = '/devtools/browser/fake-1', pid = 424_242 } = {}) {
  const calls = [];
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new PassThrough();
  child.kill = () => true;
  const spawn = (file, args, options) => {
    const profileArg = args.find(argument => argument.startsWith('--user-data-dir=')) || '';
    const profile = profileArg.slice('--user-data-dir='.length);
    writeFileSync(join(profile, 'DevToolsActivePort'), `${port}\n${wsPath}\n`);
    calls.push({ file, args, options });
    return child;
  };
  return { spawn, calls, child };
}

/** Fake browser-level WebSocket that answers CDP commands from a small scripted page. */
function fakeCdp() {
  const commands = [];
  const state = {
    page: { url: 'https://example.com/final', title: 'Example Domain' },
    snapshot: { url: 'https://example.com/page', title: 'Example Page', text: 'hello', links: [] },
    rect: { found: true, left: 100, top: 50, width: 40, height: 20 },
    screenshot: PNG_BASE64,
    resources: [],
  };
  let handler;
  const instances = [];
  const defaultHandler = message => {
    const { method, params = {} } = message;
    if (method === 'Target.createTarget') return { result: { targetId: 'target-1' } };
    if (method === 'Target.attachToTarget') return { result: { sessionId: 'session-1' } };
    if (method === 'Page.navigate') return { result: { frameId: 'frame-1' } };
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression || '');
      if (expression.includes('readyState')) return { result: { result: { type: 'string', value: 'complete' } } };
      if (expression.includes('performance.getEntriesByType')) return { result: { result: { type: 'object', value: state.resources } } };
      if (expression.includes('innerText')) return { result: { result: { type: 'object', value: state.snapshot } } };
      if (expression.includes('getBoundingClientRect')) return { result: { result: { type: 'object', value: state.rect } } };
      if (expression.includes('querySelector') && expression.includes('focus')) return { result: { result: { type: 'object', value: true } } };
      if (expression.includes('document.title')) return { result: { result: { type: 'object', value: state.page } } };
      return { result: { result: { type: 'undefined' } } };
    }
    if (method === 'Page.captureScreenshot') return { result: { data: state.screenshot } };
    return { result: {} };
  };
  class WebSocketImpl {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      instances.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); }
    send(raw) {
      const message = JSON.parse(raw);
      commands.push(message);
      const response = (handler || defaultHandler)(message);
      if (response === undefined) return;
      queueMicrotask(() => {
        if (this.readyState === 3) return;
        this.emit('message', { data: JSON.stringify({ id: message.id, ...response }) });
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', {});
    }
  }
  return { WebSocketImpl, commands, state, instances, setHandler: next => { handler = next; } };
}

function fixture(overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'akt-cloud-browser-test-')));
  mkdirSync(join(root, 'files'), { recursive: true });
  const chromium = join(root, 'chromium');
  writeFileSync(chromium, '#!/bin/false\n', { mode: 0o755 });
  const cdp = fakeCdp();
  const spawned = fakeSpawn();
  const kills = [];
  const browser = createCloudBrowser({
    workspace: root,
    sessionId: 'session-test',
    env: { AGENTKIT_CHROMIUM: chromium },
    spawn: spawned.spawn,
    WebSocketImpl: cdp.WebSocketImpl,
    kill: (pid, signal) => kills.push({ pid, signal }),
    now: () => 1_700_000_000_000,
    idleTimeoutMs: 600_000,
    ...overrides,
  });
  return { root, chromium, cdp, spawned, kills, browser };
}

function cleanup(t, created) {
  t.after(async () => {
    await created.browser.dispose().catch(() => {});
    rmSync(created.root, { recursive: true, force: true });
  });
}

const openTool = browser => browser.tool('cloud_browser_open');
const execute = (browser, name, args) => browser.tool(name).execute(args);

test('urlPolicy refuses loopback, private, metadata, credential and non-http URLs', () => {
  const refused = [
    'http://127.0.0.1', 'http://localhost', 'http://[::1]', 'http://169.254.169.254',
    'http://' + ['10', '0', '0', '1'].join('.'), 'http://' + ['192', '168', '1', '1'].join('.'), 'http://100.64.0.1', 'ftp://example.com/file',
    'https://' + 'user' + ':' + 'pass' + '@' + 'example.com', 'http://' + ['printer', 'internal'].join('.'), 'http://nas.local',
    'http://x.lan', 'http://router.home.arpa', 'http://[fe80::1]', 'http://224.0.0.1',
    'http://198.51.100.7', 'http://metadata.' + ['google', 'internal'].join('.'), 'http://example.com:8080',
    'not a url', '',
  ];
  for (const value of refused) {
    assert.throws(() => urlPolicy(value), { code: 'ASSISTANT_BROWSER_URL_REFUSED' }, value);
  }
  for (const value of ['https://example.com', 'https://example.com/path?q=1', 'http://example.com:80/']) {
    const { url } = urlPolicy(value);
    assert.equal(url.protocol.startsWith('http'), true);
  }
  assert.equal(urlPolicy('https://example.com/').url.href, 'https://example.com/');
});

test('isRefusedAddress covers IPv4, IPv6 and internal suffixes', () => {
  for (const value of ['127.0.0.1', '127.0.0.1.', '0x7f.0.0.1', '2130706433', '169.254.169.254', '::1', '[::1]', '[fe80::1]', 'fd00::1', 'ff02::1', '2001:db8::1', '::ffff:' + ['192', '168', '1', '1'].join('.'), 'localhost', ['svc', 'internal'].join('.'), 'printer.local', 'x.home.arpa', '']) {
    assert.equal(isRefusedAddress(value), true, value);
  }
  for (const value of ['example.com', 'cdn.example.com', '8.8.8.8', '2606:4700:4700::1111', '1.1.1.1']) {
    assert.equal(isRefusedAddress(value), false, value);
  }
});

test('resolveCloudBrowser requires an existing Chromium and a credential-free socks5 proxy', () => {
  const missing = resolveCloudBrowser({ env: { AGENTKIT_CHROMIUM: '/nonexistent/chromium-xyz' } });
  assert.equal(missing.available, false);
  assert.equal(missing.chromium, null);
  assert.match(missing.reason, /Chromium/);

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'akt-cloud-browser-resolve-')));
  try {
    const chromium = join(root, 'chromium');
    writeFileSync(chromium, '#!/bin/false\n');
    const available = resolveCloudBrowser({ env: { AGENTKIT_CHROMIUM: chromium } });
    assert.equal(available.available, true);
    assert.equal(available.chromium, chromium);
    assert.equal(available.proxy, 'socks5://127.0.0.1:8899');
    const custom = resolveCloudBrowser({ env: { AGENTKIT_CHROMIUM: chromium, AGENTKIT_EGRESS_PROXY: 'socks5h://127.0.0.1:9000' } });
    assert.equal(custom.available, true);
    assert.equal(custom.proxy, 'socks5h://127.0.0.1:9000');
    for (const proxy of ['http://proxy.example:3128', 'socks5://user:pass@127.0.0.1:8899', 'not-a-proxy']) {
      const invalid = resolveCloudBrowser({ env: { AGENTKIT_CHROMIUM: chromium, AGENTKIT_EGRESS_PROXY: proxy } });
      assert.equal(invalid.available, false, proxy);
      assert.match(invalid.reason, /代理/);
    }
    const defaulted = resolveCloudBrowser({ env: {} });
    assert.equal(defaulted.proxy, 'socks5://127.0.0.1:8899');
    assert.equal(defaulted.available, existsSync('/usr/bin/chromium'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registration keeps the Host tools service receiver bound', async t => {
  const created = fixture();
  cleanup(t, created);
  // The real registry exposes register() as a prototype method; an extracted
  // reference loses `this` and used to throw before any tool was registered.
  class HostTools {
    #registered = [];
    register(definition) { this.#registered.push(definition.name); return () => {}; }
    get registered() { return [...this.#registered]; }
  }
  const tools = new HostTools();
  const agent = { ctx: { get: name => name === 'tools' ? tools : undefined }, session: { id: 'bound' } };
  const result = registerAssistantCloudBrowserTools({ agent, workspaceRoot: created.root, env: { AGENTKIT_CHROMIUM: created.chromium } });
  assert.deepEqual(result.names, [...BROWSER_TOOLS]);
  assert.deepEqual(tools.registered, [...BROWSER_TOOLS]);
});

test('registerAssistantCloudBrowserTools registers the eight bounded definitions', async t => {
  const created = fixture();
  cleanup(t, created);
  const registered = [];
  const result = registerAssistantCloudBrowserTools(definition => {
    registered.push(definition);
    return () => {};
  }, created.browser);
  assert.deepEqual(result.names, [...BROWSER_TOOLS]);
  assert.deepEqual(registered.map(definition => definition.name), [...BROWSER_TOOLS]);
  assert.equal(result.disposers.length, BROWSER_TOOLS.length);
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(typeof definition.execute, 'function');
  }
  assert.ok(created.browser.tool('cloud_browser_snapshot'));
  assert.equal(typeof result.browser.open, 'function');

  const objectRegistered = [];
  const objectForm = registerAssistantCloudBrowserTools({ browser: created.browser, register: definition => objectRegistered.push(definition) });
  assert.equal(objectRegistered.length, BROWSER_TOOLS.length);
  assert.deepEqual(objectForm.names, [...BROWSER_TOOLS]);

  const unavailable = createCloudBrowser({
    workspace: created.root, sessionId: 'no-image', env: { AGENTKIT_CHROMIUM: '/nonexistent/chromium-xyz' },
  });
  assert.throws(() => registerAssistantCloudBrowserTools(() => {}, unavailable), { code: 'ASSISTANT_BROWSER_UNAVAILABLE' });
});

test('open validates the final URL, collects refused subresources and refuses redirect targets', async t => {
  const created = fixture();
  cleanup(t, created);
  created.cdp.state.resources = ['https://169.254.169.254/latest/meta-data', 'https://cdn.example.com/app.js', 'http://' + ['10', '0', '0', '5'].join('.') + '/admin'];
  const opened = await execute(created.browser, 'cloud_browser_open', { url: 'https://example.com/start' });
  assert.equal(opened.url, 'https://example.com/final');
  assert.equal(opened.title, 'Example Domain');
  assert.deepEqual(opened.warnings, ['169.254.169.254', ['10', '0', '0', '5'].join('.')]);

  created.cdp.state.page = { url: 'http://127.0.0.1/admin', title: 'Internal' };
  await assert.rejects(execute(created.browser, 'cloud_browser_open', { url: 'https://example.com/start' }), { code: 'ASSISTANT_BROWSER_URL_REFUSED' });
});

test('snapshot truncates text at 32 KiB and links at 200 entries', async t => {
  const created = fixture();
  cleanup(t, created);
  await openTool(created.browser).execute({ url: 'https://example.com/start' });
  created.cdp.state.snapshot = {
    url: 'https://example.com/page', title: 'Long page', text: 'a'.repeat(40_000),
    links: Array.from({ length: 250 }, (_, index) => ({ text: `link-${index}`, href: `https://example.com/${index}` })),
  };
  const snapshot = await execute(created.browser, 'cloud_browser_snapshot', {});
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.bytes, MAX_SNAPSHOT_BYTES);
  assert.ok(Buffer.byteLength(snapshot.text, 'utf8') <= MAX_SNAPSHOT_BYTES);
  assert.equal(snapshot.links.length, 200);
  assert.equal(snapshot.links[0].href, 'https://example.com/0');
  assert.equal(snapshot.title, 'Long page');
});

test('click maps the element rect to center coordinates and dispatches press/release', async t => {
  const created = fixture();
  cleanup(t, created);
  await openTool(created.browser).execute({ url: 'https://example.com/start' });
  created.cdp.commands.length = 0;
  const clicked = await execute(created.browser, 'cloud_browser_click', { selector: 'button.buy' });
  assert.deepEqual(clicked, { selector: 'button.buy', x: 120, y: 60 });
  const mouse = created.cdp.commands.filter(command => command.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouse.map(command => command.params.type), ['mousePressed', 'mouseReleased']);
  for (const command of mouse) {
    assert.equal(command.params.x, 120);
    assert.equal(command.params.y, 60);
    assert.equal(command.params.button, 'left');
    assert.equal(command.sessionId, 'session-1');
  }
  created.cdp.state.rect = { found: false };
  await assert.rejects(execute(created.browser, 'cloud_browser_click', { selector: '#missing' }), { code: 'ASSISTANT_BROWSER_SELECTOR_NOT_FOUND' });
});

test('press rejects keys outside the allowlist and dispatches allowlisted keys', async t => {
  const created = fixture();
  cleanup(t, created);
  await openTool(created.browser).execute({ url: 'https://example.com/start' });
  created.cdp.commands.length = 0;
  await assert.rejects(execute(created.browser, 'cloud_browser_press', { key: 'F5' }), { code: 'ASSISTANT_BROWSER_KEY_REFUSED' });
  assert.equal(created.cdp.commands.filter(command => command.method === 'Input.dispatchKeyEvent').length, 0);
  const pressed = await execute(created.browser, 'cloud_browser_press', { key: 'Enter' });
  assert.deepEqual(pressed, { key: 'Enter' });
  const events = created.cdp.commands.filter(command => command.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(events.map(event => event.params.type), ['rawKeyDown', 'keyUp']);
  assert.equal(events[0].params.windowsVirtualKeyCode, 13);
});

test('type focuses the selector before inserting text', async t => {
  const created = fixture();
  cleanup(t, created);
  await openTool(created.browser).execute({ url: 'https://example.com/start' });
  const typed = await execute(created.browser, 'cloud_browser_type', { selector: 'input[name=q]', text: 'cloud browser' });
  assert.deepEqual(typed, { selector: 'input[name=q]', typed: 13 });
  const insert = created.cdp.commands.find(command => command.method === 'Input.insertText');
  assert.equal(insert.params.text, 'cloud browser');
});

test('screenshot rejects captures over 4 MiB and writes bounded PNGs under the workspace', async t => {
  const created = fixture();
  cleanup(t, created);
  await openTool(created.browser).execute({ url: 'https://example.com/start' });
  created.cdp.state.screenshot = 'A'.repeat(MAX_SCREENSHOT_BASE64 + 1);
  await assert.rejects(execute(created.browser, 'cloud_browser_screenshot', {}), { code: 'ASSISTANT_BROWSER_SCREENSHOT_TOO_LARGE' });

  created.cdp.state.screenshot = PNG_BASE64;
  const shot = await execute(created.browser, 'cloud_browser_screenshot', {});
  assert.equal(shot.path, 'files/.cloud-browser/shot-1700000000000.png');
  assert.equal(shot.bytes, 3);
  assert.equal(shot.width, 1280);
  assert.equal(shot.height, 800);
  assert.equal(readFileSync(join(created.root, shot.path), 'utf8'), 'png');
});

test('download deletes an overflow file and reports the 64 MiB cap', async t => {
  const created = fixture({
    listDownloads: (() => {
      let calls = 0;
      return async () => (++calls === 1 ? [] : ['big.bin']);
    })(),
    statFile: async () => ({ size: 64 * 1024 * 1024 + 1, isFile: () => true, mtimeMs: 1 }),
    removeFile: async path => { removed.push(path); },
  });
  const removed = [];
  cleanup(t, created);
  await assert.rejects(
    execute(created.browser, 'cloud_browser_download', { url: 'https://example.com/big.bin' }),
    { code: 'ASSISTANT_BROWSER_DOWNLOAD_TOO_LARGE' },
  );
  assert.deepEqual(removed, [join(created.root, 'files', 'downloads', 'big.bin')]);
  const behavior = created.cdp.commands.filter(command => command.method === 'Browser.setDownloadBehavior');
  assert.equal(behavior.some(command => command.params.behavior === 'allow'
    && command.params.downloadPath === join(created.root, 'files', 'downloads')), true);
  assert.equal(behavior.some(command => command.params.behavior === 'deny'), true);
});

test('download returns one bounded workspace-relative file', async t => {
  const created = fixture({
    listDownloads: (() => {
      let calls = 0;
      return async () => (++calls === 1 ? [] : ['small.bin']);
    })(),
    statFile: async () => ({ size: 1024, isFile: () => true, mtimeMs: 1 }),
  });
  cleanup(t, created);
  const downloaded = await execute(created.browser, 'cloud_browser_download', { url: 'https://example.com/small.bin' });
  assert.deepEqual(downloaded, { path: 'files/downloads/small.bin', bytes: 1024 });
});

test('dispose kills the spawned Chromium process group and refuses later calls', async t => {
  const created = fixture();
  t.after(() => rmSync(created.root, { recursive: true, force: true }));
  await openTool(created.browser).execute({ url: 'https://example.com/start' });
  assert.equal(created.spawned.calls.length, 1);
  const [spawned] = created.spawned.calls;
  assert.equal(spawned.file, created.chromium);
  assert.ok(spawned.args.includes('--proxy-server=socks5://127.0.0.1:8899'));
  assert.ok(spawned.args.includes('--remote-debugging-port=0'));
  assert.equal(spawned.options.detached, true);
  await created.browser.dispose();
  assert.deepEqual(created.kills, [{ pid: 424_242, signal: 'SIGKILL' }]);
  assert.equal(created.browser.available, false);
  await assert.rejects(openTool(created.browser).execute({ url: 'https://example.com/start' }), { code: 'ASSISTANT_BROWSER_DISPOSED' });
});

test('tools refuse before open and after close', async t => {
  const created = fixture();
  cleanup(t, created);
  await assert.rejects(execute(created.browser, 'cloud_browser_snapshot', {}), { code: 'ASSISTANT_BROWSER_NOT_OPEN' });
  await openTool(created.browser).execute({ url: 'https://example.com/start' });
  assert.deepEqual(await execute(created.browser, 'cloud_browser_close', {}), { closed: true });
  await assert.rejects(execute(created.browser, 'cloud_browser_click', { selector: 'a' }), { code: 'ASSISTANT_BROWSER_NOT_OPEN' });
});

test('CDP commands time out individually instead of hanging the tool call', async () => {
  const cdp = fakeCdp();
  cdp.setHandler(() => undefined);
  const ws = new cdp.WebSocketImpl('ws://127.0.0.1:9222/devtools/browser/fake-1');
  const connection = new CdpConnection(ws, { commandTimeoutMs: 20 });
  await assert.rejects(connection.send('Runtime.evaluate', {}, { timeoutMs: 20 }), { code: 'ASSISTANT_BROWSER_CDP_TIMEOUT' });
  connection.close();
});
