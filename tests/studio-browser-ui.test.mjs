import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStudioBrowser, registerStudioBrowser } from '../src/studio-browser.mjs';

test('the real Studio client activation connects Agent navigation to the official Browser', async () => {
  const source = await readFile(new URL('../src/client-fragments/08-settings-and-entry.js', import.meta.url), 'utf8');
  const start = source.indexOf('    function apply(ctx) {');
  const prefix = source.slice(start, source.indexOf('      const scheduleRemote', start)) + '\n}';
  let installed = false;
  const ctx = {
    uiConversation: { events: { register() {} } },
    slots: { inject() {} }, connection: { rpc: {} },
    on() {}, effect() {},
    inject(dependencies, activate) {
      if (dependencies.includes('sidebarRight')) activate(this);
    },
  };
  new Function('window', 'codexToolDefinition', 'CredentialOnboarding', 'CodexPluginMarketItem', 'installStudioBrowser', prefix + '; apply(arguments[5]);')(
    {}, {}, () => {}, () => {}, () => { installed = true; }, ctx,
  );
  assert.equal(installed, true, 'Agent in-app navigation has no active client receiver');
});

async function bridgeFixture({ changeSession = false, failOpen = false } = {}) {
  const host = createStudioBrowser({ timeoutMs: 1000 });
  const input = { agent: { session: { id: 'conversation-a' } }, signal: new AbortController().signal };
  const opened = [], disposed = [], calls = [];
  let current = 'conversation-a', tick;
  const result = host.tool.execute({ url: 'https://github.com/' }, input);
  const done = result.then(value => ({ value }), error => ({ error }));
  const source = await readFile(new URL('../src/client-fragments/02-studio-browser.js', import.meta.url), 'utf8');
  const ctx = {
    effect: callback => disposed.push(callback()),
    connection: { rpc: { call: async (channel, endpoint, payload) => {
      assert.equal(channel, '/agentkit-ui'); calls.push(endpoint);
      try {
        const value = host.handle(endpoint, payload);
        if (changeSession && endpoint === 'browser/confirm') current = 'conversation-b';
        return { ok: true, value };
      } catch (error) { return { ok: false, error: { code: error.code } }; }
    } } },
    sidebarRightTabs: { get: kind => kind === 'browser' },
    sidebarRight: {
      mounted: { getSnapshot: () => current },
      openTab: (kind, options) => { if (failOpen) throw Error('native refusal'); opened.push({ kind, options, sessionId: current }); },
      active: () => ({ kind: 'browser', id: 'official-tab-id' }),
    },
  };
  new Function('ctx', 'setTimeout', 'clearTimeout', source + '; installStudioBrowser(ctx);')(ctx, callback => { tick = callback; }, () => {});
  const outcome = await done;
  disposed.forEach(dispose => dispose());
  await tick?.(); // a disposed receiver must not replay or claim any command
  host.dispose();
  return { ...outcome, opened, calls };
}

test('Agent → authenticated Connection → official Browser → ack is the success boundary', async () => {
  const result = await bridgeFixture();
  assert.equal(result.value.status, 'opened');
  assert.equal(result.value.tabId, 'official-tab-id');
  assert.deepEqual(result.opened, [{ kind: 'browser', options: { params: { url: 'https://github.com/' } }, sessionId: 'conversation-a' }]);
  assert.deepEqual(result.calls, ['browser/claim', 'browser/confirm', 'browser/ack']);
});

test('switching conversations during an RPC never opens in the other conversation', async () => {
  const result = await bridgeFixture({ changeSession: true });
  assert.equal(result.error.code, 'BROWSER_OPEN_FAILED');
  assert.deepEqual(result.opened, []);
});

test('native Browser refusal reaches the Agent instead of reporting an opened page', async () => {
  const result = await bridgeFixture({ failOpen: true });
  assert.equal(result.error.code, 'BROWSER_OPEN_FAILED');
  assert.deepEqual(result.opened, []);
});

test('cancelled, expired and unloaded requests cannot replay navigation', async () => {
  for (const mode of ['abort', 'timeout', 'unload']) {
    const host = createStudioBrowser({ timeoutMs: 10 });
    const abort = new AbortController();
    const promise = host.tool.execute({ url: 'https://github.com' }, { agent: { session: { id: 'a' } }, signal: abort.signal });
    const rejected = assert.rejects(promise);
    if (mode === 'abort') abort.abort();
    if (mode === 'unload') host.dispose();
    await rejected;
    assert.equal(host.handle('browser/claim', { sessionId: 'a' }), null);
    host.dispose();
  }
});

test('only the live execution session and its unique claim can acknowledge the command', async () => {
  const host = createStudioBrowser();
  const promise = host.tool.execute({ url: 'https://github.com' }, { agent: { session: { id: 'a' } } });
  const failed = assert.rejects(promise);
  assert.equal(host.handle('browser/claim', { sessionId: 'b' }), null);
  const request = host.handle('browser/claim', { sessionId: 'a' });
  assert.equal(host.handle('browser/claim', { sessionId: 'a' }), null);
  assert.throws(() => host.handle('browser/ack', { ...request, claim: 'guessed', kind: 'browser', tabId: 'id' }), /BROWSER_REQUEST_EXPIRED/);
  host.dispose(); await failed;
});

test('the browser tool rejects local files, scripts and embedded credentials', () => {
  const host = createStudioBrowser();
  const embedded = new URL('https://github.com');
  embedded.username = 'fixture'; embedded.password = 'fixture';
  for (const url of ['file:///tmp/game.html', 'javascript:alert(1)', embedded.href]) {
    assert.throws(() => host.tool.execute({ url }, { agent: { session: { id: 'a' } } }), /BROWSER_URL_INVALID/);
  }
  host.dispose();
});

test('Host registration uses the DSH ToolRegistry and scoped Connection disposal', async () => {
  const tools = [], effects = [], channels = [];
  const ctx = {
    tools: { register: tool => tools.push(tool) },
    inject: (_dependencies, activate) => activate(ctx),
    effect: install => effects.push(install()),
    connection: { rpc: { handle: (channel, handler) => channels.push({ channel, handler }) } },
  };
  registerStudioBrowser(ctx);
  assert.equal(tools[0].name, 'studio_open_browser');
  assert.equal(channels[0].channel, '/agentkit-ui');
  const result = tools[0].execute({ url: 'https://github.com/' }, { agent: { session: { id: 'a' } } });
  const failed = assert.rejects(result, /BROWSER_UNAVAILABLE/);
  effects.forEach(dispose => dispose()); await failed;
});
