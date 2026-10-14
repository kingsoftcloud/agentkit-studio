import test from 'node:test';
import assert from 'node:assert/strict';
import { readStartChecks as readChecks } from '../src/client/state/start-checks.mjs';
import { createStartChecks } from '../src/client/pages/start-checks.mjs';
const good = { settings: async () => ({ profile: 'default' }), modelCredentialStatus: async () => ({ configured: true }), runtimes: async () => ({ items: [{ runtimeType: 'dsh-native' }] }) };

test('checks expose only redacted configuration facts, not execution readiness', async () => {
  const rows = await readChecks({ ...good, settings: async () => ({ apiKey: 'private-value-do-not-display' }),
    modelCredentialStatus: async () => ({ configured: true, value: 'private-value-do-not-display' }),
    runtimes: async () => ({ items: [{ runtimeType: 'harness' }, { runtimeType: 'harness' }, { runtimeType: 'unsupported' }] }) });
  assert.deepEqual(rows.map(row => row.status), ['confirmed', 'confirmed', 'confirmed']);
  assert.equal(rows[2].detail, 'AgentKit Harness');
  assert.doesNotMatch(JSON.stringify(rows), /private-value|apiKey|unsupported/);
  assert.match(rows[1].detail, /实际运行结果/);
});
test('missing credentials offer configuration; failed reads remain unknown', async () => {
  const rows = await readChecks({ ...good, settings: async () => { throw Error('private Host log'); }, modelCredentialStatus: async () => ({ configured: false }), runtimes: async () => ({ items: [] }) });
  assert.deepEqual(rows.map(row => row.status), ['unknown', 'missing', 'missing']);
  assert.equal(rows[1].action, 'credentials');
  assert.doesNotMatch(JSON.stringify(rows), /private Host log/);
  const unknown = await readChecks({ ...good, modelCredentialStatus: async () => ({}), runtimes: async () => ({}) });
  assert.deepEqual(unknown.map(row => row.status), ['confirmed', 'unknown', 'unknown']);
});
test('a stalled Host cannot keep all checks pending indefinitely', async () => {
  const rows = await readChecks({ ...good, settings: () => new Promise(() => {}) }, { timeoutMs: 5 });
  assert.deepEqual(rows.map(row => row.status), ['unknown', 'confirmed', 'confirmed']);
});
test('the legacy default native entry is not proof of a runtime catalog', async () => {
  const rows = await readChecks({ ...good, runtimes: async () => ({ source: 'dsh', items: [{ runtimeType: 'dsh-native' }] }) });
  assert.equal(rows[2].status, 'unknown');
  assert.match(rows[2].detail, /未提供运行目标目录/);
});

function ui(remote) {
  const states = [], effects = [], cleanups = [], listeners = new Map();
  let cursor = 0, dirty = true, tree;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const useState = value => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; dirty = true; }]; };
  const useRef = value => useState({ current: value })[0];
  const useEffect = callback => { const i = cursor++; if (!(i in states)) { states[i] = true; effects.push(callback); } };
  const window = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name), dispatchEvent() {} };
  const { StartChecks: Component } = createStartChecks({ ui: { React: { createElement: h, useState, useRef, useEffect }, buttonStyle: () => ({}) }, hostRemote: remote, window });
  const render = () => { cursor = 0; dirty = false; tree = Component(); effects.splice(0).forEach(callback => cleanups.push(callback())); };
  const settle = async () => { if (dirty) render(); for (let i = 0; i < 40; i++) { await Promise.resolve(); if (dirty) render(); } };
  return { settle, state: () => states[0], tree: () => tree, toggle: () => tree.children[0].children[0].props.onClick(), change: () => listeners.get('agentkit-studio:model-credential-changed')(), dispose: () => cleanups.forEach(callback => callback?.()), listeners };
}
test('checks stay collapsed and make no requests until explicitly opened', async () => {
  let calls = 0;
  const view = ui({ ...good, settings: async () => { calls++; return {}; } });
  await view.settle(); view.change(); await view.settle();
  assert.equal(calls, 0);
  assert.equal(view.tree().children[0].children[0].props['aria-expanded'], false);
  assert.equal(view.tree().children[1], null);
  view.toggle(); await view.settle();
  assert.equal(calls, 1);
  assert.equal(view.tree().children[1].type, 'section');
  view.toggle(); await view.settle(); view.change(); await view.settle();
  assert.equal(view.tree().children[1], null);
  assert.equal(calls, 1);
  view.dispose();
});
test('credential changes refresh checks and late previous reads cannot overwrite them', async () => {
  const first = Promise.withResolvers(); let calls = 0, credentialCalls = 0;
  const view = ui({ ...good, settings: () => ++calls === 1 ? first.promise : Promise.resolve({}), modelCredentialStatus: async () => ({ configured: ++credentialCalls === 1 }) });
  await view.settle(); view.toggle(); await view.settle(); view.change(); await view.settle();
  assert.equal(view.state().rows[1].status, 'missing');
  first.resolve({}); await view.settle();
  assert.equal(view.state().rows[1].status, 'missing');
  view.dispose(); assert.equal(view.listeners.size, 0);
});
test('unmount ignores an in-flight result and removes refresh listeners', async () => {
  const host = Promise.withResolvers(); const view = ui({ ...good, settings: () => host.promise });
  await view.settle(); view.toggle(); await view.settle(); view.dispose(); host.resolve({}); await view.settle();
  assert.equal(view.state().phase, 'checking');
  assert.equal(view.listeners.size, 0);
});
