import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioApp } from '../src/client/app.mjs';
import { createStudioActions } from '../src/client/state/actions.mjs';
import { createConfirmation } from '../src/client/components/confirmation.mjs';
import { createModelBridge } from '../src/client/dsh/model-bridge.mjs';
import { createProductDocumentEffects } from '../src/client/dsh/product-document.mjs';
import { leaseDocumentResource } from '../src/client/dsh/document-resource.mjs';

test('late command cleanup cannot erase its replacement or another mounted Studio', async () => {
  const notices = [];
  const first = createStudioActions({ confirm: async options => notices.push(options) });
  const second = createStudioActions({ confirm: async () => false });
  const old = first.registerBinding(async () => 'old');
  first.registerBinding(async () => 'replacement');
  second.registerBinding(async () => 'other-Host');
  old(); old();
  assert.equal(await first.bindAgent('same-agent'), 'replacement');
  first.dispose();
  assert.equal(await second.bindAgent('same-agent'), 'other-Host');
  assert.equal(await first.confirm({ title: 'late' }), false);
  assert.deepEqual(notices, []);
});

function documentFixture() {
  const listeners = new Map();
  const element = () => ({
    children: [], style: {}, parent: null,
    append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; },
    setAttribute() {}, addEventListener() {}, focus() {},
  });
  return {
    body: element(), createElement: element, listeners,
    addEventListener(type, listener) { const set = listeners.get(type) || new Set(); set.add(listener); listeners.set(type, set); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
}

test('closing one scope cancels its dialog and key listener while another remains open', async () => {
  const document = documentFixture();
  const first = createConfirmation({ document }), second = createConfirmation({ document });
  const a = first.confirm({ title: 'first' }), b = second.confirm({ title: 'second' });
  assert.equal(document.body.children.length, 2);
  assert.equal(document.listeners.get('keydown').size, 2);
  first.dispose(); first.dispose();
  assert.equal(await a, false);
  assert.equal(document.body.children.length, 1);
  assert.equal(document.listeners.get('keydown').size, 1);
  second.dispose();
  assert.equal(await b, false);
  assert.equal(document.body.children.length, 0);
  assert.equal(document.listeners.get('keydown').size, 0);
  assert.equal(await first.confirm({ title: 'late' }), false);
});

test('actual page composition owns independent connections, commands and authoring subscriptions', async () => {
  const listeners = new Map();
  const window = { __AGENTKIT_STUDIO__: {}, location: { origin: 'http://localhost', hash: '' }, localStorage: { getItem() { return null; }, setItem() {} },
    addEventListener(type, listener) { const set = listeners.get(type) || new Set(); set.add(listener); listeners.set(type, set); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); }, dispatchEvent() {},
  };
  const React = { createElement() {}, Fragment: 'fragment' };
  const runtime = { React, primitives: {} };
  const options = { window, CustomEvent: class { constructor(type) { this.type = type; } } };
  const first = createStudioApp(runtime, options), second = createStudioApp(runtime, options);
  assert.notEqual(first.ui, second.ui);
  assert.notEqual(first.ui.AgentWorkspace, second.ui.AgentWorkspace);
  assert.equal(first.ui.React, React); assert.equal(second.ui.React, React);
  first.connectionOwner.bind({ rpc: { call: async () => ({ ok: true, value: { host: 'first' } }) } });
  second.connectionOwner.bind({ rpc: { call: async () => ({ ok: true, value: { host: 'second' } }) } });
  assert.equal((await first.hostRemote.settings()).host, 'first');
  assert.equal((await second.hostRemote.settings()).host, 'second');
  first.authoring.subscribe({}); second.authoring.subscribe({});
  first.actions.registerBinding(async () => 'first'); second.actions.registerBinding(async () => 'second');
  assert.equal(listeners.get('agentkit-studio:seed-authoring').size, 2);
  first.dispose(); first.dispose();
  assert.equal(first.connectionOwner.connection.rpc, undefined);
  assert.equal(listeners.get('agentkit-studio:seed-authoring').size, 1);
  assert.equal(await second.actions.bindAgent('agent'), 'second');
  assert.equal((await second.hostRemote.settings()).host, 'second');
  assert.deepEqual(Object.keys(window).filter(key => /^__AGENTKIT_/.test(key)), ['__AGENTKIT_STUDIO__']);
  second.dispose(); assert.equal(listeners.get('agentkit-studio:seed-authoring').size, 0);
});

test('late model catalog completion cannot publish providers after its owner closes', async () => {
  const catalog = Promise.withResolvers(), changes = [];
  let active = true;
  const ctx = { remote: { settings: {
    describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', value: { providers: {} }, revision: 0 }, { ns: 'agent-default-model', revision: 0 }] } }),
    mutate: async (...args) => { changes.push(args); return { ok: true }; },
  }, credentials: { set() { assert.fail('unexpected credential write'); } } } };
  const { createDshModelBridge } = createModelBridge({ hostRemote: { modelCatalog: () => catalog.promise } });
  const bridge = createDshModelBridge(ctx, { isActive: () => active });
  const pending = bridge.applyProfiles({ profiles: [{ id: 'profile', provider: 'custom', modelName: 'fixture', baseUrl: 'https://gateway.test/v1' }] });
  await new Promise(resolve => setImmediate(resolve)); active = false;
  const rejected = assert.rejects(pending, { code: 'STUDIO_SCOPE_DISPOSED' });
  catalog.resolve({ items: [{ id: 'fixture', input: ['text'] }] });
  await rejected;
  assert.deepEqual(changes, []);
});

test('overlapping document effects keep styles and favicon until their last scope releases', () => {
  const head = { children: [], append(node) { this.children.push(node); node.isConnected = true; }, appendChild(node) { this.append(node); } };
  const document = { head,
    createElement(kind) {
      const attributes = new Map();
      return { kind, attributes, rel: '', type: '', href: '', setAttribute: (key, value) => attributes.set(key, value), remove() { head.children = head.children.filter(node => node !== this); this.isConnected = false; } };
    },
    querySelector(selector) { return head.children.find(node => node.kind === 'style' && [...node.attributes.keys()].some(key => selector.includes(`[${key}]`))); },
    querySelectorAll() { return head.children.filter(node => node.kind === 'link' && node.rel === 'icon'); },
  };
  const original = document.createElement('link'); original.rel = 'icon'; original.href = '/original.svg'; head.append(original);
  const window = {}; window.parent = window;
  const first = createProductDocumentEffects({ window, document }), second = createProductDocumentEffects({ window, document });
  const styleA = first.installResponsiveStyles(), styleB = second.installResponsiveStyles();
  const iconA = first.adoptProductDocumentBrand(), iconB = second.adoptProductDocumentBrand();
  assert.equal(head.children.filter(node => node.kind === 'style').length, 1);
  styleA(); iconA(); styleA(); iconA();
  assert.equal(head.children.filter(node => node.kind === 'style').length, 1);
  assert.match(original.href, /^data:image\/svg\+xml,/);
  styleB(); iconB();
  assert.equal(head.children.filter(node => node.kind === 'style').length, 0);
  assert.equal(original.href, '/original.svg');
  const styleNext = second.installResponsiveStyles(); styleA();
  assert.equal(head.children.filter(node => node.kind === 'style').length, 1);
  styleNext();
});

test('replacement bundle evaluation shares document leases without retaining an old global registry', async () => {
  const { leaseDocumentResource: reloadedLease } = await import('../src/client/dsh/document-resource.mjs?replacement');
  const document = {}; let restored = 0;
  const old = leaseDocumentResource(document, 'favicon', () => () => { restored++; });
  const next = reloadedLease(document, 'favicon', () => { assert.fail('a replacement must retain the current asset'); });
  old(); assert.equal(restored, 0);
  next(); assert.equal(restored, 1);
  assert.equal(Object.getOwnPropertySymbols(document).length, 0);
});
