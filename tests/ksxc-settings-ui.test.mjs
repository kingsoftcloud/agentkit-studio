import test from 'node:test';
import assert from 'node:assert/strict';
import { createKsxcSettings } from '../src/client/pages/ksxc-settings.mjs';

const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];

/**
 * Minimal positional-hooks harness. The KsxcSettings root returns
 * Section(SettingsControls); the simplified renderer only executes the root,
 * so SettingsControls (the component that reads Host status) is taken out of
 * the tree and mounted on its own with a clean hook array.
 */
function ksxcHarness({ host }) {
  const states = [], effects = [];
  let cursor = 0, dirty = true;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { const value = typeof next === 'function' ? next(states[index]) : next; if (!Object.is(value, states[index])) { states[index] = value; dirty = true; } }];
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (fn, deps) => {
    const index = cursor++, previous = states[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      states[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { states[index].cleanup?.(); states[index].cleanup = fn(); });
    }
  };
  const React = { createElement: h, useState, useRef, useEffect, Fragment: 'Fragment' };
  const window = { setTimeout: fn => { queueMicrotask(fn); return 0; }, clearTimeout() {}, dispatchEvent() {}, CustomEvent: class {} };
  const Root = createKsxcSettings({ React, hostRemote: host, window });
  const controls = walk(Root()).find(node => typeof node.type === 'function' && node.props && 'managed' in node.props);
  assert.ok(controls, 'SettingsControls element is present');
  states.length = 0; // drop the root's own hook so the child mounts cleanly
  let tree;
  const render = () => { cursor = 0; dirty = false; tree = controls.type(controls.props); for (const effect of effects.splice(0)) effect(); };
  const settle = async () => { render(); for (let i = 0; i < 200; i += 1) { await Promise.resolve(); if (dirty) render(); } return tree; };
  return { settle, nodes: () => walk(tree), text: () => JSON.stringify(tree) };
}

const status = () => ({ supported: true, release: { versions: ['1.0.0'], active: '1.0.0', ready: true }, connection: { connected: false } });

test('KSXC settings renders before the Host status arrives (release is undefined)', async () => {
  let resolveStatus;
  const host = { ksxcStatus: () => new Promise(resolve => { resolveStatus = resolve; }) };
  const view = ksxcHarness({ host });
  // The first render happens with status === null: release?.active must not throw.
  const tree = await view.settle();
  assert.ok(tree, 'renders without throwing while status is pending');
  resolveStatus(status());
  await view.settle();
  assert.ok(view.text().includes('1.0.0'));
});

test('KSXC status is read once, not on every render (no effect loop)', async () => {
  let calls = 0;
  const host = { ksxcStatus: async () => { calls += 1; return status(); } };
  const view = ksxcHarness({ host });
  await view.settle();
  const settled = calls;
  assert.ok(settled >= 1 && settled <= 2, `expected a single mount-time read, got ${settled}`);
  // Extra microtask rounds must not schedule more Host reads.
  await view.settle();
  await view.settle();
  assert.equal(calls, settled, 'status reads stay flat across re-renders');
});
