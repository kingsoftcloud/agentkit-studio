import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const fragment = await readFile(new URL('../src/client-fragments/08-settings-and-entry.js', import.meta.url), 'utf8');
const source = fragment.slice(0, fragment.indexOf('    function apply(ctx)'));
function settingsHarness(remote, updates) {
  const states = [], effects = [], cleanups = [];
  let cursor = 0, dirty = true, tree;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; dirty = true; }];
  };
  const useRef = initial => useState({ current: initial })[0];
  const useEffect = callback => {
    const index = cursor++;
    if (!(index in states)) { states[index] = true; effects.push(callback); }
  };
  const window = { dshDesktop: updates ? { protocolVersion: 1, updates } : undefined };
  const Component = new Function('h','useState','useEffect','useRef','window','hostRemote','BRAND','SectionHeading','SettingsRow','STUDIO_VERSION','DSH_VERSION',source+'; return StudioSettingsSection;')(h, useState, useEffect, useRef, window, remote, {}, 'heading', 'row', '0.0.1', '0.2.0-rc.2');
  const render = () => { cursor = 0; dirty = false; tree = Component(); for (const callback of effects.splice(0)) cleanups.push(callback()); };
  const settle = async () => { render(); for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); } return tree; };
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
  return { settle, text: () => JSON.stringify(tree), updateButton: () => walk(tree).find(node => node.type === 'button' && node.props.onClick?.name === 'checkDesktopUpdate'), dispose: () => cleanups.forEach(cleanup => cleanup?.()) };
}
async function renderSettings(remote) {
  const ui = settingsHarness(remote);
  await ui.settle();
  return ui.text();
}
test('Studio settings report a successful Host RPC as connected', async () => {
  const output = await renderSettings({ settings: async () => ({ defaultProfileId: 'profile-a' }) });
  assert.match(output,/已连接/); assert.doesNotMatch(output,/尚未连接|尚未接入|保持只读|开启结构化/);
});
test('Studio settings show an actual Host error without claiming readiness', async () => {
  const output = await renderSettings({ settings: async () => { throw new Error('E2E Host unreachable'); } });
  assert.match(output,/E2E Host unreachable/); assert.doesNotMatch(output,/已连接/);
});

test('manual update opens native confirmation once and returns from checking after closing it', async () => {
  let listener, opens = 0, off = 0;
  const prompt = Promise.withResolvers();
  const ui = settingsHarness({ settings: async () => ({}) }, {
    status: async () => ({ phase: 'idle' }),
    subscribe: callback => { listener = callback; return () => { off++; }; },
    open: () => { opens++; return prompt.promise; },
  });
  await ui.settle();
  const click = ui.updateButton().props.onClick;
  const pending = click();
  await click();
  await ui.settle();
  assert.equal(opens, 1);
  assert.equal(ui.updateButton().props.disabled, true);
  prompt.resolve();
  await pending;
  await ui.settle();
  assert.equal(ui.updateButton().children[0], '检查更新');
  assert.equal(ui.updateButton().props.disabled, false);
  listener({ phase: 'ready', version: '1.0.1' });
  await ui.settle();
  assert.equal(ui.updateButton().children[0], '安装 1.0.1');
  ui.dispose();
  assert.equal(off, 1);
});

test('live updater state wins over a late initial status response', async () => {
  const initial = Promise.withResolvers();
  let listener;
  const ui = settingsHarness({ settings: async () => ({}) }, {
    status: () => initial.promise, open: async () => {},
    subscribe: callback => { listener = callback; return () => {}; },
  });
  await ui.settle();
  listener({ phase: 'available', version: '1.0.2' });
  initial.resolve({ phase: 'idle' });
  await ui.settle();
  assert.equal(ui.updateButton().children[0], '发现 1.0.2');
  ui.dispose();
});

test('unavailable desktop and failed update remain actionable without exposing native diagnostics', async () => {
  const web = settingsHarness({ settings: async () => ({}) });
  await web.settle();
  assert.equal(web.updateButton().props.disabled, true);
  assert.match(web.text(), /桌面应用中检查更新/);
  const ui = settingsHarness({ settings: async () => ({}) }, {
    status: async () => ({ phase: 'idle' }), subscribe: () => () => {},
    open: async () => { throw Error('private native diagnostic'); },
  });
  await ui.settle();
  await ui.updateButton().props.onClick();
  await ui.settle();
  assert.equal(ui.updateButton().children[0], '重试检查更新');
  assert.doesNotMatch(ui.text(), /private native diagnostic/);
  ui.dispose();
});
