import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModelSettingsSection } from '../src/client/pages/model-settings.mjs';
import { createStudioPrimitives } from '../src/client/components/primitives.mjs';

const settings = await readFile(new URL('../src/client/pages/model-settings.mjs', import.meta.url), 'utf8');
const verification = await readFile(new URL('../scripts/verify-studio-onboarding-ui.mjs', import.meta.url), 'utf8');
const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];

function modelSettingsHarness() {
  const states = [], effects = [];
  let cursor = 0, dirty = true, tree;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], next => { const value = typeof next === 'function' ? next(states[index]) : next; if (!Object.is(value, states[index])) { states[index] = value; dirty = true; } }];
  };
  const useEffect = (effect, deps) => {
    const index = cursor++, previous = states[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      states[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { states[index].cleanup?.(); states[index].cleanup = effect(); });
    }
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const React = { createElement: h, useState, useEffect, useRef };
  const { SecretInput } = createStudioPrimitives({ React });
  let probed = null;
  const hostRemote = {
    settings: async () => ({ modelProfiles: [], cloudAccountConfigured: false, configurationSources: {} }),
    updateSettings: async () => {},
    syncModelCredential: async () => {},
    modelCatalog: async () => ({ items: [] }),
    probeModelEndpoint: async payload => {
      probed = payload;
      return { items: [{ id: 'onboarding-proof', name: 'Onboarding proof', input: ['text'] },
        { id: 'onboarding-proof-secondary', name: 'Onboarding secondary', input: ['text'] }] };
    },
  };
  const dshModel = { describe: async () => ({ namespaces: [] }), credentialStatus: async () => ({ configured: false }), applyProfiles: async () => {} };
  const Component = createModelSettingsSection({
    ui: { React, Pill: 'Pill', SecretInput, buttonStyle: () => ({}), inputStyle: () => ({}), BRAND: {} },
    hostRemote, window: {}, CustomEvent: class {},
  });
  const render = () => { cursor = 0; dirty = false; tree = Component({ dshModel }); for (const effect of effects.splice(0)) effect(); };
  const settle = async () => { render(); for (let i = 0; i < 120; i += 1) { await Promise.resolve(); if (dirty) render(); } return tree; };
  return { settle, nodes: () => walk(tree), probe: () => probed, SecretInput };
}

const field = (view, name) => view.nodes().find(node => node?.props?.['aria-label'] === name);

test('the onboarding acceptance script locates controls by their shipped accessible names', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  view.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '提供商').props.onChange({ target: { value: 'custom' } });
  await view.settle();
  const provider = view.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '提供商');
  assert.equal(provider.props.value, 'custom', 'the provider select keeps an explicit 提供商 name');
  assert.equal(field(view, 'API 地址')?.type, 'input', 'the API address input keeps an explicit API 地址 name');
  assert.equal(field(view, '模型名称')?.type, 'input', 'the manual model input keeps the 模型名称 name the old script used');
  const secret = view.nodes().find(node => node.type === view.SecretInput);
  assert.equal(secret.props.label, 'API Key', 'the API Key field carries its label into the secret input');
  secret.props.onChange({ target: { value: 'onboarding-local-fixture' } });
  await view.settle();
  const secretTree = createStudioPrimitives({ React: { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => [initial, () => {}], useEffect: () => {} } })
    .SecretInput({ label: 'API Key', value: 'fixture' });
  assert.equal(walk(secretTree).find(node => node.type === 'input').props['aria-label'], 'API Key');

  view.nodes().find(node => node.type === 'button' && node.children.includes('读取模型')).props.onClick();
  await view.settle();
  const select = view.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '选择模型');
  assert.ok(select, 'the catalog dropdown must expose the 选择模型 name');
  assert.deepEqual(select.children.map(option => option.props.value), ['onboarding-proof', 'onboarding-proof-secondary', '__custom__']);
  assert.equal(select.props.value, '__custom__', 'an off-catalog model stays on the manual option');
  // The redesigned surface labels this step with a section heading instead of
  // the old bold step numeral; the control names above are the contract.
  assert.ok(view.nodes().some(node => node.type === 'h5' && node.children.includes('模型')), 'the model step keeps a visible section title');
  assert.equal(view.probe().apiKey, 'onboarding-local-fixture', 'reading the catalog probes the entered endpoint with the unsaved key');
  assert.ok(view.probe().modelName, 'the probe carries the current model name');

  select.props.onChange({ target: { value: 'onboarding-proof' } });
  await view.settle();
  const selected = view.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '选择模型');
  assert.equal(selected.props.value, 'onboarding-proof', 'choosing a catalog model writes the value into the model field');
  assert.equal(field(view, '模型名称'), undefined, 'the manual input is replaced once a catalog model is selected');
  assert.ok(view.nodes().some(node => node.type === 'strong' && node.children.includes('onboarding-proof')), 'the profile card reflects the selected model');
});

test('the acceptance script drives the shipped five-step model form and asserts its real constraints', () => {
  for (const locator of [
    "getByRole('combobox',{name:'提供商'",
    "getByLabel('API 地址'",
    "getByLabel('API Key'",
    "getByLabel('模型名称'",
    "getByRole('combobox',{name:'选择模型'",
    "getByRole('button',{name:'读取模型'",
    "getByRole('button',{name:'保存并继续'",
  ]) assert.ok(verification.includes(locator), `the acceptance script must keep using ${locator}`);
  assert.match(verification, /每个模型配置都需要填写模型名称/, 'model name validation is asserted');
  assert.match(verification, /请先填写 API Key/, 'the catalog probe must block without an API key');
  assert.match(verification, /toHaveValue\('onboarding-proof'\)/, 'the selected model value is asserted');
  assert.match(verification, /\[data-onboarding-mode=cloud\]/, 'saving must advance to the cloud step');
  assert.match(verification, /\[data-desktop-onboarding\]/, 'the official first-use surface stays excluded');
  assert.doesNotMatch(verification, /欢迎使用 DeepSeek Harness/, 'the removed welcome-copy branch is gone');
  for (const label of [...verification.matchAll(/getByLabel\('([^']+)'/g)].map(match => match[1])) {
    assert.ok(settings.includes(`'${label}'`), `${label} is not rendered by model settings`);
  }
});
