import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/client-fragments/08-settings-and-entry.js', import.meta.url), 'utf8');

function bindingFixture(admit) {
  const start = source.indexOf('window.__AGENTKIT_STUDIO_BIND_AGENT__ = async');
  const body = source.slice(start, source.indexOf('        return () =>', start));
  const calls = [];
  const window = { __AGENTKIT_CONFIRM__: message => calls.push(['notice', message.detail]) };
  const navCtx = { sessions: { create: async payload => { calls.push(['create', payload]); return 'blank'; } }, uiWorkspace: { openSession: id => calls.push(['open', id]) } };
  const ctx = { remote: { agentPresets: { select: async () => ({ ok: true }) }, session: { selectModel: async payload => { calls.push(['model', payload]); return { ok: true }; } } }, layout: { selectPanel() {} } };
  new Function('window', 'navCtx', 'ctx', 'hostRemote', 'writeConversationAgent', 'console', body)(window, navCtx, ctx, { ensureDshPreset: admit }, () => {}, { warn() {}, error() {} });
  return { bind: window.__AGENTKIT_STUDIO_BIND_AGENT__, calls };
}

test('resource admission failure leaves no orphan Session or navigation', async () => {
  const f = bindingFixture(async () => { throw new Error('MCP certificate refused'); });
  await f.bind('agent-with-unreachable-mcp');
  assert.deepEqual(f.calls, [['notice', 'MCP certificate refused']]);
});

test('workspace-free native entry needs no Agent and retains the session model without changing the default', async () => {
  const f = bindingFixture(async () => { assert.fail('native entry must not admit an Agent'); });
  await f.bind({ workspaceFree: true, modelSelection: { provider: 'gateway', model: 'chosen' } });
  assert.deepEqual(f.calls, [['create', {}], ['model', { sessionId: 'blank', provider: 'gateway', model: 'chosen', saveDefault: false }], ['open', 'blank']]);
});

test('new Agent binding selects its model through the public Remote before a client scope exists', async () => {
  const start = source.indexOf('window.__AGENTKIT_STUDIO_BIND_AGENT__ = async');
  const body = source.slice(start, source.indexOf('        return () =>', start));
  const events = [], window = {};
  const navCtx = { sessions: { create: async () => 'new-session' }, modelDirectories: { directoryFor() { throw new Error('no client scope yet'); } }, uiWorkspace: { openSession: id => events.push(['open', id]) } };
  const ctx = { remote: { agentPresets: { select: async () => ({ ok: true }) }, session: { selectModel: async payload => { events.push(['model', payload]); return { ok: true }; } }, commands: { execute: async () => ({ ok: true }) } }, layout: { selectPanel: panel => events.push(['panel', panel]) } };
  const host = { ensureDshPreset: async () => ({ presetId: 'preset-a', modelSelection: { provider: 'codex', model: 'actual-model' } }) };
  new Function('window', 'navCtx', 'ctx', 'hostRemote', 'writeConversationAgent', body)(window, navCtx, ctx, host, () => {});
  await window.__AGENTKIT_STUDIO_BIND_AGENT__('agent-a');
  assert.deepEqual(events, [['model', { sessionId: 'new-session', provider: 'codex', model: 'actual-model', saveDefault: false }], ['open', 'new-session'], ['panel', null]]);
});

test('entering the native session clears the old Studio panel restoration', () => {
  const start = source.indexOf('      ctx.effect(() => {\n        let restoring = true;\n        const subscription = ctx.layout.panelInfo');
  const end = source.indexOf("      }, 'agentkit-studio:active-panel-restore');", start) + "      }, 'agentkit-studio:active-panel-restore');".length;
  const storage = new Map([['active', 'agents']]); let changed;
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  const ctx = { effect: install => install(), layout: { panelInfo: { subscribe: callback => { changed = callback; return { unsubscribe() {} }; }, getSnapshot: () => ({ activePanelId: null }) }, selectPanel() {} } };
  let ready;
  new Function('ctx', 'window', 'ACTIVE_PANEL_KEY', 'PANELS', 'setTimeout', 'clearTimeout', source.slice(start, end))(ctx, window, 'active', [], callback => { ready = callback; return 1; }, () => {});
  ready();
  changed(); assert.equal(storage.has('active'), false);
});

test('the initial empty layout projection cannot erase the panel saved for reload', () => {
  const start = source.indexOf('      ctx.effect(() => {\n        let restoring = true;\n        const subscription = ctx.layout.panelInfo');
  const end = source.indexOf("      }, 'agentkit-studio:active-panel-restore');", start) + "      }, 'agentkit-studio:active-panel-restore');".length;
  const storage = new Map([['active', 'resources']]); const selected = [];
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  const ctx = { effect: install => install(), layout: { panelInfo: { subscribe: callback => { callback(); return { unsubscribe() {} }; }, getSnapshot: () => ({ activePanelId: null }) }, selectPanel: id => selected.push(id) } };
  let ready;
  new Function('ctx', 'window', 'ACTIVE_PANEL_KEY', 'PANELS', 'setTimeout', 'clearTimeout', source.slice(start, end))(ctx, window, 'active', [{ id: 'resources' }], callback => { ready = callback; return 1; }, () => {});
  ready(); assert.deepEqual(selected, ['resources']);
});
