import test from 'node:test';
import assert from 'node:assert/strict';
import { clearModelSettingsDrafts, createModelSettingsSection } from '../src/client/pages/model-settings.mjs';

const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];

/** Minimal mount of the shipped component with a fake Host, mirroring
 * model-settings-drafts' harness but with an injectable DSH applyProfiles. */
function harness({ applyProfiles }) {
  const values = { modelProfiles: [{ id: 'alpha', provider: 'custom', modelName: 'alpha-model', baseUrl: 'https://alpha.test/v1', credentialName: 'ALPHA_KEY', enabled: true, default: true, input: ['text'] }] };
  const writes = [];
  const hostRemote = {
    settings: async () => structuredClone(values),
    updateSettings: async patch => { writes.push(structuredClone(patch)); Object.assign(values, structuredClone(patch)); return {}; },
    syncModelCredential: async () => {},
    modelCatalog: async () => ({ items: [] }),
  };
  const dshModel = { describe: async () => ({ namespaces: [] }), credentialStatus: async () => ({ configured: true }), applyProfiles };
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
    settle, values, writes, nodes: () => walk(tree), text: () => JSON.stringify(tree),
    openEditor: async () => {
      walk(tree).find(node => node.type === 'button' && node.props['data-model-connection']).props.onClick();
      await settle();
      walk(tree).find(node => node.type === 'button' && node.props['data-model-row']).props.onClick();
      await settle();
    },
    save: async () => { await walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
  };
}

test('a failed DSH sync rolls the Host config back to the pre-save state', async () => {
  clearModelSettingsDrafts();
  const view = harness({ applyProfiles: async () => { throw new Error('DSH unreachable'); } });
  await view.settle();
  await view.openEditor();
  // Rename the model, then save. The save writes the new name to the Host, the
  // DSH sync fails, and the Host must be restored to `before`.
  const input = view.nodes().find(node => node.props?.['aria-label'] === '模型名称');
  input.props.onChange({ target: { value: 'renamed-model' } });
  await view.settle();
  await view.save();
  await view.settle();
  // The rollback restores the pre-save model name; without it the renamed
  // profile would remain in the Host even though the DSH sync failed.
  assert.equal(view.values.modelProfiles[0].modelName, 'alpha-model', 'Host config is rolled back');
  assert.ok(view.text().includes('回滚'), 'the failure message mentions the rollback');
  // The last Host write is the rollback, not the renamed profile.
  const last = view.writes.at(-1);
  assert.equal(last.modelProfiles[0].modelName, 'alpha-model');
});

test('a successful DSH sync keeps the saved config (no rollback)', async () => {
  clearModelSettingsDrafts();
  const applied = [];
  const view = harness({ applyProfiles: async ({ profiles }) => { applied.push(profiles); } });
  await view.settle();
  await view.openEditor();
  const input = view.nodes().find(node => node.props?.['aria-label'] === '模型名称');
  input.props.onChange({ target: { value: 'renamed-model' } });
  await view.settle();
  await view.save();
  await view.settle();
  assert.equal(applied.length, 1);
  assert.equal(view.values.modelProfiles[0].modelName, 'renamed-model');
  assert.ok(!view.text().includes('回滚'));
});
