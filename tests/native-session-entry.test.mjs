import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSessionBinding } from '../src/client/dsh/session-entry.mjs';
import { registerPanelNavigation } from '../src/client/dsh/panel-navigation.mjs';

function bindingFixture(admit) {
  const calls = [];
  const navCtx = { sessions: { create: async payload => { calls.push(['create', payload]); return 'blank'; } }, uiWorkspace: { openSession: id => calls.push(['open', id]) } };
  const ctx = { remote: { agentPresets: { select: async () => ({ ok: true }) }, session: { selectModel: async payload => { calls.push(['model', payload]); return { ok: true }; } } }, layout: { selectPanel() {} } };
  const binding = createNativeSessionBinding({ navCtx, remote: ctx.remote, layout: ctx.layout, hostRemote: { ensureDshPreset: admit }, writeConversationAgent() {}, actions: { confirm: message => calls.push(['notice', message.detail]) }, console: { warn() {}, error() {} } });
  return { bind: binding.bindAgent, dispose: binding.dispose, calls };
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
  const events = [];
  const navCtx = { sessions: { create: async () => 'new-session' }, modelDirectories: { directoryFor() { throw new Error('no client scope yet'); } }, uiWorkspace: { openSession: id => events.push(['open', id]) } };
  const ctx = { remote: { agentPresets: { select: async () => ({ ok: true }) }, session: { selectModel: async payload => { events.push(['model', payload]); return { ok: true }; } }, commands: { execute: async () => ({ ok: true }) } }, layout: { selectPanel: panel => events.push(['panel', panel]) } };
  const host = { ensureDshPreset: async () => ({ presetId: 'preset-a', modelSelection: { provider: 'codex', model: 'actual-model' } }) };
  const binding = createNativeSessionBinding({ navCtx, remote: ctx.remote, layout: ctx.layout, hostRemote: host, writeConversationAgent() {}, actions: {} });
  await binding.bindAgent('agent-a');
  assert.deepEqual(events, [['model', { sessionId: 'new-session', provider: 'codex', model: 'actual-model', saveDefault: false }], ['open', 'new-session'], ['panel', null]]);
});

test('entering the native session clears the old Studio panel restoration', () => {
  const storage = new Map([['active', 'agents']]); let changed;
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  const ctx = { effect: install => install(), layout: { panelInfo: { subscribe: callback => { changed = callback; return { unsubscribe() {} }; }, getSnapshot: () => ({ activePanelId: null }) }, selectPanel() {} } };
  let ready;
  registerPanelNavigation(ctx, { window, storageKey: 'active', panels: [], setTimeout: callback => { ready = callback; return 1; }, clearTimeout() {} });
  ready();
  changed(); assert.equal(storage.has('active'), false);
});

test('the initial empty layout projection cannot erase the panel saved for reload', () => {
  const storage = new Map([['active', 'resources']]); const selected = [];
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  const ctx = { effect: install => install(), layout: { panelInfo: { subscribe: callback => { callback(); return { unsubscribe() {} }; }, getSnapshot: () => ({ activePanelId: null }) }, selectPanel: id => selected.push(id) } };
  let ready;
  registerPanelNavigation(ctx, { window, storageKey: 'active', panels: [{ id: 'resources' }], setTimeout: callback => { ready = callback; return 1; }, clearTimeout() {} });
  ready(); assert.deepEqual(selected, ['resources']);
});

test('disposed native admission cannot create or navigate; a later owner still binds', async () => {
  const late = Promise.withResolvers();
  const old = bindingFixture(() => late.promise);
  const pending = old.bind('agent-old'); old.dispose();
  late.resolve({ presetId: 'old-preset' }); await pending;
  assert.deepEqual(old.calls, []);
  const next = bindingFixture(async () => ({ presetId: 'new-preset' }));
  await next.bind('agent-new');
  assert.deepEqual(next.calls, [['create', {}], ['open', 'blank']]);
});

test('a saved panel timer and queued subscription stop when their scope closes', () => {
  let close, ready, changed; const selected = [];
  const window = { localStorage: { getItem: () => 'resources', setItem() { assert.fail('disposed scope wrote storage'); }, removeItem() { assert.fail('disposed scope wrote storage'); } } };
  const ctx = { effect: install => { close = install(); }, layout: { panelInfo: { subscribe: callback => { changed = callback; return { unsubscribe() {} }; }, getSnapshot: () => ({ activePanelId: 'agents' }) }, selectPanel: id => selected.push(id) } };
  registerPanelNavigation(ctx, { window, panels: [{ id: 'resources' }], setTimeout: callback => { ready = callback; return 1; }, clearTimeout() {} });
  close(); ready(); changed();
  assert.deepEqual(selected, []);
});
