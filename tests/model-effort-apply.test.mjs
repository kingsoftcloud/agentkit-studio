import test from 'node:test';
import assert from 'node:assert/strict';
import { clearModelSettingsDrafts, createModelSettingsSection } from '../src/client/pages/model-settings.mjs';

const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];

function harness() {
  const values = { modelProfiles: [{ id: 'alpha', provider: 'custom', modelName: 'alpha-model', baseUrl: 'https://alpha.test/v1', credentialName: 'ALPHA_KEY', enabled: true, default: true, input: ['text'] }] };
  const hostRemote = {
    settings: async () => structuredClone(values),
    updateSettings: async patch => { Object.assign(values, structuredClone(patch)); return {}; },
    syncModelCredential: async () => {},
    modelCatalog: async () => ({ items: [] }),
    probeModelEfforts: async () => ({ control: 'rejected', wire: 'openai-chat', outcomes: [
      { level: 'low', outcome: 'accepted' }, { level: 'high', outcome: 'accepted' }, { level: 'max', outcome: 'rejected' },
    ] }),
  };
  const dshModel = { describe: async () => ({ namespaces: [] }), credentialStatus: async () => ({ configured: true }), applyProfiles: async () => {} };
  const states = [], effects = [];
  let cursor = 0, dirty = true, tree;
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
  class CustomEvent { constructor(type) { this.type = type; } }
  const Component = createModelSettingsSection({
    ui: { React: { createElement: h, useState, useEffect, useRef }, SecretInput: 'SecretInput', BRAND: {} },
    hostRemote, window: { dispatchEvent() {} }, CustomEvent,
  });
  const render = () => { cursor = 0; dirty = false; tree = Component({ dshModel }); for (const effect of effects.splice(0)) effect(); };
  const settle = async () => { render(); for (let i = 0; i < 200; i += 1) { await Promise.resolve(); if (dirty) render(); } return tree; };
  return {
    settle, values, nodes: () => walk(tree), text: () => JSON.stringify(tree),
    openEditor: async () => {
      walk(tree).find(node => node.type === 'button' && node.props['data-model-connection']).props.onClick();
      await settle();
      walk(tree).find(node => node.type === 'button' && node.props['data-model-row']).props.onClick();
      await settle();
    },
    click: async predicate => { walk(tree).find(predicate).props.onClick(); await settle(); },
    save: async () => { await walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle(); },
  };
}

test('probing then applying writes the usable levels into the saved profile', async () => {
  clearModelSettingsDrafts();
  const view = harness();
  await view.settle();
  await view.openEditor();
  // Run the probe, then apply the levels it found (low/high accepted, max rejected).
  await view.click(node => node.type === 'button' && (node.children || []).includes('探测档位'));
  const applyButton = view.nodes().find(node => node.props?.['data-apply-probe']);
  assert.ok(applyButton, 'the apply button appears once usable levels are reported');
  assert.ok(applyButton.children.join('').includes('2'), 'two usable levels');
  await view.click(node => node.props?.['data-apply-probe']);
  assert.ok(view.text().includes('已应用探测到的 2 个档位'));
  await view.save();
  assert.deepEqual(view.values.modelProfiles[0].reasoningLevels, ['low', 'high']);
  assert.equal(view.values.modelProfiles[0].reasoningEfforts, true);
  assert.equal(view.values.modelProfiles[0].defaultReasoningEffort, 'high');
});
