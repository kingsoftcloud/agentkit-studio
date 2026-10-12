import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const overview = await readFile(new URL('../src/client-fragments/02-overview-and-selector.js', import.meta.url), 'utf8');
const onboarding = await readFile(new URL('../src/client-fragments/02-credential-onboarding.js', import.meta.url), 'utf8');

function onboardingHarness({ statuses, localStorage = {}, props = {} } = {}) {
  const states = [];
  let cursor = 0;
  let dirty = true;
  let effects = [];
  const listeners = new Map();
  const dispatched = [];
  const window = {
    localStorage,
    addEventListener: (name, fn) => { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    dispatchEvent: event => { dispatched.push(event.type); for (const fn of listeners.get(event.type) || []) fn(event); return true; },
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { const value = typeof next === 'function' ? next(states[index]) : next; if (!Object.is(value, states[index])) { states[index] = value; dirty = true; } }];
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (effect, deps) => {
    const index = cursor++, previous = states[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      states[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { states[index].cleanup?.(); states[index].cleanup = effect(); });
    }
  };
  let statusIndex = 0;
  const hostRemote = { modelCredentialStatus: async () => statuses[Math.min(statusIndex++, statuses.length - 1)] };
  class CustomEvent { constructor(type) { this.type = type; } }
  const Component = new Function('h', 'useState', 'useEffect', 'useRef', 'hostRemote', 'window', 'CustomEvent', 'Modal', 'buttonStyle', 'BRAND', `${onboarding}; return CredentialOnboarding;`)(h, useState, useEffect, useRef, hostRemote, window, CustomEvent, 'Modal', () => ({ type: 'button' }), { danger: 'red', ink: 'black', inkMuted: 'gray', surface: 'white', primaryFill: 'teal' });
  let tree;
  const render = () => { cursor = 0; dirty = false; tree = Component(props); for (const effect of effects.splice(0)) effect(); return tree; };
  const settle = async () => { render(); for (let i = 0; i < 20; i += 1) { await Promise.resolve(); if (dirty) render(); } return tree; };
  const modal = () => tree?.type === 'Modal' ? tree : null;
  const footerButtons = () => (modal()?.props.footer?.children || []).filter(node => node?.type === 'button');
  return { settle, modal, footerButtons, window, dispatched, get statusCalls() { return statusIndex; }, render };
}
const settings = await readFile(new URL('../src/client-fragments/08-settings-and-entry.js', import.meta.url), 'utf8');
const hostEntry = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');

test('first Studio overview checks the redacted Host credential status and offers one guided action', () => {
  assert.match(overview, /modelCredentialStatus\(\)/);
  assert.match(overview, /!credential\.configured/);
  assert.match(overview, /先配置一个模型凭证/);
  assert.match(overview, /agentkit-studio:open-settings/);
  assert.doesNotMatch(overview, /localStorage\.setItem\([^\n]*apiKey/i);
});

test('credential guide opens the official DSH settings surface', () => {
  assert.match(settings, /agentkit-studio:open-settings/);
  assert.match(settings, /openSettings\?\.\(\)/);
});

test('credential guide is a DSH settings onboarding step with retry and deferred entry', () => {
  assert.match(settings, /openOnboarding\?\.\('agentkit-studio-credential'\)/);
  assert.match(onboarding, /稍后设置/);
  assert.match(onboarding, /重试/);
  assert.match(settings, /重新打开凭证引导/);
  assert.match(settings, /settings\.onboarding/);
  assert.doesNotMatch(onboarding, /localStorage/);
  assert.match(onboarding, /agentkitCredentialOnboardingIn/);
  assert.match(onboarding, /prefers-reduced-motion/);
});

test('Studio settings exposes the DSH desktop update action', () => {
  assert.match(settings, /dshDesktop\?\.updates/);
  assert.match(settings, /检查更新/);
  assert.match(settings, /bridge\.open\(\)/);
});

test('credential filesystem inspection stays in the Host-only dynamic graph', () => {
  assert.doesNotMatch(hostEntry, /^import .*model-credential-sync/m);
  assert.match(hostEntry, /await import\('\.\/model-credential-sync\.mjs'\)/);
});

test('first missing credential opens the guide, configured readiness stays quiet, and saved readiness closes it', async () => {
  const missing = onboardingHarness({ statuses: [{ configured: false, source: 'missing' }, { configured: true, source: 'env' }] });
  await missing.settle();
  assert.ok(missing.modal(), 'first missing status should open the guide');
  missing.window.dispatchEvent({ type: 'agentkit-studio:model-credential-changed' });
  await missing.settle();
  assert.equal(missing.modal(), null, 'a save/recheck with a configured credential closes the guide');

  const ready = onboardingHarness({ statuses: [{ configured: true, source: 'dsh' }] });
  await ready.settle();
  assert.equal(ready.modal(), null, 'an existing DSH credential must not show onboarding');
});

test('the DSH onboarding coordinator owns completion and model settings navigation', () => {
  assert.match(onboarding, /complete\(\)/);
  assert.match(onboarding, /openSection\('agentkit-models'\)/);
  assert.match(settings, /id: 'agentkit-studio-credential'/);
});

test('coordinator navigation completes the guide and explicit reopening works when configured', async () => {
  const actions = [];
  const props = { explicit: true, complete: () => actions.push('complete'), openSection: id => actions.push(id) };
  const ui = onboardingHarness({ statuses: [{ configured: false }], props });
  await ui.settle();
  assert.ok(ui.modal());
  ui.footerButtons()[3].props.onClick();
  await ui.settle();
  assert.equal(ui.modal(), null);
  assert.deepEqual(actions, ['complete', 'agentkit-models']);

  // DSH unmounts completed steps. The launcher requests a new mounted step.
  const reopened = onboardingHarness({ statuses: [{ configured: true }], props });
  await reopened.settle();
  assert.equal(reopened.modal().props.title, '模型凭证已就绪');
  reopened.footerButtons()[0].props.onClick();
  await reopened.settle();
  assert.equal(reopened.modal(), null);
  assert.equal(actions.filter(action => action === 'complete').length, 2);
});

test('explicit onboarding shows a retryable Host error', async () => {
  const ui = onboardingHarness({ statuses: [Promise.reject(new Error('offline'))], props: { explicit: true } });
  await ui.settle();
  assert.ok(ui.modal());
  assert.ok(ui.footerButtons().some(button => button.children.includes('重试')));
});

test('configuration guide includes a playable three-step demonstration', async () => {
  const ui = onboardingHarness({ statuses: [{ configured: false }] });
  await ui.settle();
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
  let nodes = walk(ui.modal());
  assert.equal(nodes.filter(node => node.type === 'li').length, 3);
  const pause = nodes.find(node => node.type === 'button' && node.children.includes('暂停演示'));
  pause.props.onClick();
  await ui.settle();
  nodes = walk(ui.modal());
  assert.equal(nodes.find(node => node.props.className === 'agentkit-credential-guide').props['data-paused'], 'true');
  assert.ok(nodes.some(node => node.children.includes('播放演示')));
});

test('a Host reconnect rechecks readiness instead of treating transport failure as missing', async () => {
  const ui = onboardingHarness({ statuses: [Promise.reject(new Error('offline')), { configured: false, source: 'missing' }] });
  await ui.settle();
  assert.equal(ui.modal(), null, 'transport error must not trigger a missing-credential dialog');
  ui.window.dispatchEvent({ type: 'agentkit-studio:credential-recheck' });
  await ui.settle();
  assert.ok(ui.modal(), 'reconnect recheck can then show the actual missing state');
});
