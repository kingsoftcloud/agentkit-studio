import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { createDshNodeBrowserTools } from '../src/providers/dsh-node-browser-tools.mjs';
import { browserImageVariation } from '../packages/agentkit-harness/src/native/browser-canvas-metrics.mjs';
import { canonical } from '../packages/agentkit-harness-core/dist/index.mjs';
import { browserExecutable } from './fixtures/browser-executable.mjs';

const executable = browserExecutable();
assert.ok(existsSync(executable), 'real cached Chromium is required for Browser acceptance');
const html = `<!doctype html><title>Browser 😀</title><div id="app">
<button id="hit" onclick="this.textContent='count:'+ ++window.count">Start</button><input id="name"><input type="password" value="private-password">
<p id="key">key:none</p></div><canvas width="1000" height="400" style="background:#112233"></canvas>
<div style="position:absolute;top:100px;left:50px;color:white">HUD overlay must not alter canvas metrics</div>
<script>window.count=0;document.addEventListener('keydown',e=>document.querySelector('#key').textContent='key:'+e.key);</script>`;
function records(directory) { return readdirSync(directory, { recursive: true }).filter(p => p.endsWith('record.json')).map(p => {
  const path = join(directory, p), bytes = readFileSync(path); return { path, bytes, value: JSON.parse(bytes) };
}); }
function setup(t, extra = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-browser-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot); mkdirSync(stateDir); writeFileSync(join(workspaceRoot, 'index.html'), html);
  const options = { agentId: 'browser-agent', agentRevision: 3, buildId: 'frozen-browser', workspaceRoot, stateDir, browserExecutablePath: executable };
  let launches = 0, policy = 'workspace-write', approval = async () => 'allowed-once', navigated;
  const live = [];
  const launchBrowser = async () => {
    launches++;
    const intent = records(stateDir).find(r => r.value.phase === 'executing'); assert.ok(intent, 'original fsynced intent precedes Chromium launch');
    assert.equal(intent.value.request.agentId, options.agentId);
    for (const key of ['scope', 'runId', 'turnId', 'executionFence', 'taskChainId']) assert.equal(Object.hasOwn(intent.value.request, key), false);
    const browser = await chromium.launch({ executablePath: executable, headless: true }); live.push(browser);
    const contexts = new Set(), closeBrowser = browser.close.bind(browser);
    browser.close = async () => { assert.equal(contexts.size, 0, 'Context close must finish before Browser close starts'); await closeBrowser(); };
    const original = browser.newContext.bind(browser);
    browser.newContext = async settings => { const context = await original(settings);
      contexts.add(context); const closeContext = context.close.bind(context);
      context.close = async () => { await closeContext(); contexts.delete(context); };
      context.on('page', page => page.once('domcontentloaded', () => navigated?.())); return context;
    };
    return browser;
  };
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: policy }) }, approval: { request: input => approval(input) } };
  const owners = [], create = overrides => { const port = createDshNodeBrowserTools({ ...options, ctx, launchBrowser, ...extra, ...overrides }); owners.push(port); return port; };
  const port = create();
  const exec = (args = { path: '.', wait_ms: 0 }, overrides = {}) => ({ name: 'browser_inspect_workspace', arguments: args,
    agent: { session: { id: 'original-session' } }, callId: 'original-call', signal: new AbortController().signal, ...overrides });
  const invoke = (args, e = exec(args), target = port) => target.execute(e.name, args, e);
  t.after(async () => { await Promise.all(owners.map(p => p.close())); await Promise.all(live.map(b => b.close())); rmSync(root, { recursive: true, force: true }); });
  return { root, options, port, create, exec, invoke, records: () => records(stateDir), get launches() { return launches; },
    policy: value => { policy = value; }, approval: fn => { approval = fn; }, onNavigated: fn => { navigated = fn; } };
}

test('actual Chromium actions, full screenshot, isolated canvas pixels and exact durable duplicate/cold receipt', { timeout: 60000 }, async t => {
  const h = setup(t), args = { path: '.', wait_ms: 0, actions: [{ type: 'click', selector: '#hit', duration_ms: 10, button: 'left' },
    { type: 'fill', selector: '#name', value: 'player' }, { type: 'press', selector: '#name', key: 'x' },
    { type: 'move', x: 60, y: 60, steps: 3 }, { type: 'wait', ms: 0 }] }, exec = h.exec(args);
  h.policy('read-only'); let approvals = 0;
  h.approval(async request => { approvals++; assert.equal(request.agent, exec.agent); assert.equal(request.callId, exec.callId); return 'allowed-once'; });
  const [first, duplicate] = await Promise.all([h.invoke(args, exec), h.invoke(args, exec)]);
  assert.equal(first.status, 'ok', canonical(first)); assert.deepEqual(duplicate, first); assert.equal(first.content.ok, true);
  assert.equal(first.content.title, 'Browser 😀'); assert.match(first.content.body_text_preview, /count:1/); assert.match(first.content.body_text_preview, /key:x/);
  assert.equal(first.content.actions.length, 5); assert.equal(first.content.canvas_metrics[0].visually_uniform, true);
  assert.equal(first.content.canvas_metrics[0].colour_buckets, 1); assert.equal(first.content.visual_warnings.length, 1);
  assert.equal(Object.is(first.content.canvas_metrics[0].entropy_bits, -0), false);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'the first receipt must already survive JSON persistence unchanged');
  assert.doesNotMatch(canonical(first), /private-password/); assert.equal(h.launches, 1); assert.equal(approvals, 2);
  const screenshot = readFileSync(join(h.options.workspaceRoot, '.artifacts/browser-check.png'));
  assert.equal(PNG.sync.read(screenshot).width, 1280);
  const before = h.records().map(r => [r.path, r.bytes.toString()]); await h.port.close();
  h.approval(async () => 'allowed-once'); const replacement = h.create();
  assert.deepEqual(await h.invoke(args, h.exec(args), replacement), first); assert.equal(h.launches, 1);
  assert.deepEqual(h.records().map(r => [r.path, r.bytes.toString()]), before);
  assert.ok(readFileSync(join(h.options.workspaceRoot, '.artifacts/browser-check.png')).equals(screenshot));
  const changed = h.create({ agentRevision: 4 });
  assert.equal((await h.invoke(args, h.exec(args), changed)).content.error_type, 'dsh_node_command_call_identity_conflict'); assert.equal(h.launches, 1);
});

test('bounded colour diagnostics distinguish a rendered multicolour canvas from uniform pixels', () => {
  const image = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4;
    image.data[i] = x * 4; image.data[i + 1] = y * 4; image.data[i + 2] = (x + y) * 2; image.data[i + 3] = 255;
  }
  const result = browserImageVariation(PNG.sync.write(image)); assert.equal(result.colour_buckets, 16); assert.equal(result.visually_uniform, false); assert.ok(result.entropy_bits > 3);
});

test('policy denial, argument/path/screenshot escape and unavailable browser fail before effects', async t => {
  const h = setup(t); h.policy('read-only'); h.approval(async () => 'rejected');
  const args = { path: '.', wait_ms: 0 }; assert.equal((await h.invoke(args)).content.error_type, 'STUDIO_NATIVE_PERMISSION_DENIED');
  assert.equal(h.records().length, 0); h.policy('workspace-write');
  symlinkSync(h.root, join(h.options.workspaceRoot, 'outside'));
  for (const value of [{ path: '../outside' }, { path: '.', screenshot_path: '../escape.png' }, { path: '.', screenshot_path: 'outside/escape.png' },
    { path: '.', actions: [{ type: 'evaluate', value: 'script' }] }]) assert.equal((await h.invoke(value)).status, 'error');
  assert.equal(h.launches, 0); assert.equal(h.records().length, 0);
  const missing = h.create({ launchBrowser: async () => { throw new Error('missing Chromium'); } });
  const result = await h.invoke(args, h.exec(args), missing); assert.equal(result.content.error_type, 'browser_runtime_unavailable');
  assert.equal((await h.invoke(args, h.exec(args), missing)).content.error_type, 'browser_runtime_unavailable');
});

for (const cause of ['cancel', 'retire', 'timeout']) test(`actual page ${cause} after navigation preserves uncertainty and cannot publish or replay`, { timeout: 30000 }, async t => {
  const began = Date.now(), checkpoint = text => t.diagnostic(`${cause} +${Date.now() - began}ms: ${text}`);
  const h = setup(t), controller = new AbortController(), args = { path: '.', wait_ms: 30000 };
  const screenshot = join(h.options.workspaceRoot, 'proof.png'); writeFileSync(screenshot, 'original'); args.screenshot_path = 'proof.png';
  let entered; const navigation = new Promise(resolve => { entered = resolve; }); h.onNavigated(entered);
  const exec = h.exec(args, { signal: cause === 'timeout' ? AbortSignal.timeout(2000) : controller.signal });
  const pending = h.invoke(args, exec);
  await Promise.race([navigation, pending.then(result => assert.fail('inspection ended before actual navigation: ' + canonical(result)))]);
  checkpoint('actual navigation observed');
  if (cause === 'retire') void h.port.close(); else if (cause === 'cancel') controller.abort();
  checkpoint(`interruption submitted, caller.aborted=${exec.signal.aborted}`);
  const result = await pending; assert.equal(result.status, 'uncertain', canonical(result)); assert.equal(h.launches, 1);
  checkpoint('original call settled');
  assert.equal(readFileSync(screenshot, 'utf8'), 'original'); assert.equal(h.records()[0].value.request.call.callId, 'original-call');
  const cold = h.create(); assert.deepEqual(await h.invoke(args, h.exec(args), cold), result); assert.equal(h.launches, 1);
  checkpoint('cold receipt matched');
});

test('late noncooperative browser launch is closed; original approval identity cannot drift', async t => {
  let complete, launched; const pending = new Promise(resolve => { complete = resolve; }), started = new Promise(resolve => { launched = resolve; }); let closed = 0;
  const h = setup(t, { launchBrowser: () => { launched(); return pending; } }), controller = new AbortController(), args = { path: '.', wait_ms: 0 };
  const exec = h.exec(args, { signal: controller.signal }); const result = h.invoke(args, exec);
  await started;
  controller.abort(); assert.equal((await result).status, 'uncertain');
  complete({ close: async () => { closed++; } }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1);
  h.policy('read-only'); const different = h.exec(args, { callId: 'approval-drift' });
  h.approval(async () => { different.agent.session.id = 'foreign'; return 'allowed-once'; });
  assert.equal((await h.invoke(args, different)).content.error_type, 'dsh_node_browser_request_drifted');
  assert.equal(h.records().length, 1);
});

test('explicit E2B backend cannot silently inspect on the Host local browser', async t => {
  const h = setup(t, { backend: 'e2b', launchBrowser: () => assert.fail('E2B selection must not launch local Chromium') });
  assert.equal((await h.invoke({ path: '.', wait_ms: 0 })).content.error_type, 'BROWSER_LOCAL_BACKEND_REQUIRED');
  assert.equal(h.records().length, 0);
});

test('a stalled Context close cannot block Browser/server retirement or claim successful cleanup', { timeout: 15000 }, async t => {
  const h = setup(t); let entered, finishClose, browsersClosed = 0;
  const routing = new Promise(resolve => { entered = resolve; });
  const stalled = new Promise(resolve => { finishClose = resolve; });
  const context = { routeWebSocket() {}, route() { entered(); return new Promise(() => {}); }, close: () => stalled };
  const port = createDshNodeBrowserTools({ ...h.options, ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }, launchBrowser: async () => ({
    newContext: async () => context, close: async () => { browsersClosed++; },
  }) });
  t.after(() => { finishClose(); });
  const args = { path: '.', wait_ms: 0 }, controller = new AbortController();
  const pending = h.invoke(args, h.exec(args, { signal: controller.signal }), port);
  await routing; controller.abort();
  assert.equal((await pending).status, 'uncertain'); assert.equal(browsersClosed, 1);
  await assert.rejects(port.close(), error => error instanceof AggregateError
    && error.message === 'dsh_node_browser_cleanup_unknown'
    && error.errors[0].code === 'dsh_node_browser_cleanup_unknown');
  finishClose();
});

test('late resource disposal observes synchronous and asynchronous failures without unhandled rejection', async t => {
  const h = setup(t);
  for (const synchronous of [true, false]) {
    let entered, complete;
    const started = new Promise(resolve => { entered = resolve; });
    const launched = new Promise(resolve => { complete = resolve; });
  const port = createDshNodeBrowserTools({ ...h.options, ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } },
      launchBrowser: () => { entered(); return launched; } });
    const controller = new AbortController(), args = { path: '.', wait_ms: 0 };
    const exec = h.exec(args, { callId: `late-disposal-${synchronous}`, signal: controller.signal });
    const pending = h.invoke(args, exec, port); await started; controller.abort();
    assert.equal((await pending).status, 'uncertain');
    complete({ close: () => { const error = new Error('injected disposal failure');
      if (synchronous) throw error; return Promise.reject(error); } });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(port.close(), /dsh_node_browser_cleanup_unknown/);
  }
});

test('actual page cannot fetch, open popups or connect WebSockets outside its private workspace server', { timeout: 30000 }, async t => {
  let requests = 0, upgrades = 0;
  const server = createServer((_req, res) => { requests++; res.end('must not be contacted'); });
  server.on('upgrade', (_req, socket) => { upgrades++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, h = setup(t);
  writeFileSync(join(h.options.workspaceRoot, 'network.html'), `<!doctype html><title>Local only</title><p>Network policy</p><script>
    fetch('${origin}/private').catch(()=>{}); window.open('${origin}/popup');
    const socket = new WebSocket('${origin.replace('http:', 'ws:')}/socket');socket.onerror=()=>{};</script>`);
  const result = await h.invoke({ path: 'network.html', wait_ms: 200 });
  assert.equal(result.status, 'ok', canonical(result)); assert.equal(result.content.ok, false);
  assert.ok(result.content.request_failures.some(value => /denied/.test(value)));
  assert.equal(requests, 0); assert.equal(upgrades, 0);
});

test('identity drift at actual navigation retains original intent and cannot dispatch later input or screenshot', { timeout: 30000 }, async t => {
  const h = setup(t), args = { path: '.', wait_ms: 0, actions: [{ type: 'click', selector: '#hit' }] }, exec = h.exec(args);
  h.onNavigated(() => { exec.agent.session.id = 'foreign-session'; });
  const result = await h.invoke(args, exec); assert.equal(result.status, 'uncertain', canonical(result));
  assert.equal(h.records()[0].value.request.sessionId, 'original-session');
  assert.equal(existsSync(join(h.options.workspaceRoot, '.artifacts/browser-check.png')), false);
});

test('fifty legacy actions are supported and a different Session owns a separate inspection', { timeout: 60000 }, async t => {
  const h = setup(t), args = { path: '.', wait_ms: 0, actions: Array.from({ length: 50 }, () => ({ type: 'wait', ms: 0 })) };
  const a = await h.invoke(args); assert.equal(a.content.actions.length, 50);
  const b = await h.invoke(args, h.exec(args, { agent: { session: { id: 'another-session' } } }));
  assert.equal(b.status, 'ok'); assert.equal(h.launches, 2); assert.equal(h.records().length, 2);
});

test('actual SIGKILL after Chromium navigation and a new Node PID never relaunch the original call', { timeout: 30000 }, async t => {
  const h = setup(t), args = { path: '.', wait_ms: 30000 }, fixture = new URL('./fixtures/dsh-node-browser-driver.mjs', import.meta.url);
  let browserPid;
  const child = fork(fixture, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python' } });
  t.after(() => { child.kill('SIGKILL'); if (browserPid) try { process.kill(browserPid, 'SIGTERM'); } catch {} });
  const message = once(child, 'message'); child.send({ ...h.options, args, waitForNavigation: true });
  const [ready] = await message; assert.equal(ready.kind, 'navigated'); browserPid = ready.browserPid;
  assert.equal(h.records()[0].value.phase, 'executing'); child.kill('SIGKILL'); await once(child, 'exit');
  const original = h.records()[0].bytes;
  const cold = fork(fixture, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, AGENTKIT_KSADK_PYTHON: '/unavailable/python' } });
  t.after(() => cold.kill('SIGKILL')); const reply = once(cold, 'message'), exited = once(cold, 'exit');
  cold.send({ ...h.options, args }); const [recovered] = await reply; assert.notEqual(recovered.pid, child.pid);
  assert.equal(recovered.result.status, 'uncertain'); assert.equal(recovered.launches, 0); await exited;
  assert.ok(h.records()[0].bytes.equals(original)); assert.equal(existsSync(join(h.options.workspaceRoot, '.artifacts/browser-check.png')), false);
});
