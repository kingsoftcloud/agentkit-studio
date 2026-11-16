import test from 'node:test';
import assert from 'node:assert/strict';
import { clearModelSettingsDrafts, createModelSettingsSection, modelSettingsDraftKeys } from '../src/client/pages/model-settings.mjs';

const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];

const savedProfiles = () => [
  { id: 'alpha', provider: 'custom', modelName: 'alpha-model', baseUrl: 'https://alpha.test/v1', credentialName: 'ALPHA_KEY', enabled: true, default: true, input: ['text'] },
  { id: 'beta', provider: 'custom', modelName: 'beta-model', baseUrl: 'https://beta.test/v1', credentialName: 'BETA_KEY', enabled: true, default: false, input: ['text'] },
];

/**
 * 方案 C harness: a real mount of the shipped component with a fake Host.
 * State/effects are positional like React; effects honour deps so `load()` runs
 * once, and calling `settle()` again models a brand new mount of the sheet.
 */
function modelSettingsHarness({ profiles = savedProfiles() } = {}) {
  const values = { modelProfiles: structuredClone(profiles) };
  const writes = [];
  const events = [];
  const hostRemote = {
    settings: async () => structuredClone(values),
    updateSettings: async patch => { writes.push(structuredClone(patch)); Object.assign(values, structuredClone(patch)); return {}; },
    syncModelCredential: async () => {},
    modelCatalog: async () => ({ items: [] }),
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
    hostRemote, window: { dispatchEvent: event => events.push(event.type) }, CustomEvent,
  });
  const render = () => { cursor = 0; dirty = false; tree = Component({ dshModel }); for (const effect of effects.splice(0)) effect(); };
  const settle = async () => { render(); for (let i = 0; i < 200; i += 1) { await Promise.resolve(); if (dirty) render(); } return tree; };
  return {
    settle, values, writes, events, nodes: () => walk(tree), text: () => JSON.stringify(tree),
    save: async () => { await walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
  };
}

const modelName = view => view.nodes().find(node => node.props?.['aria-label'] === '模型名称');
const apiKey = view => view.nodes().find(node => node.type === 'SecretInput');
const railItems = view => view.nodes().filter(node => node.type === 'button' && node.props.className === 'ms-rail-item');
const selectModel = (view, index) => railItems(view)[index].props.onClick();
const button = (view, label) => view.nodes().find(node => node.type === 'button' && (node.children || []).includes(label));
const saveButton = view => view.nodes().find(node => node.type === 'button' && node.props.type === 'submit' && node.props['data-variant'] === 'primary');
const unsavedChip = view => view.nodes().find(node => node.props?.['data-unsaved'] === 'true' && (node.children || []).includes('未保存'));
const draftNote = view => view.nodes().find(node => node.props?.className === 'ms-footer-note' && node.props?.['data-tone'] === 'draft');

test.beforeEach(() => clearModelSettingsDrafts());
test.afterEach(() => clearModelSettingsDrafts());

test('switching A → B → A keeps A’s unsaved edits and never prompts', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  assert.equal(modelName(view).props.value, 'alpha-model');
  assert.equal(unsavedChip(view), undefined);

  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();
  apiKey(view).props.onChange({ target: { value: 'sk-draft-alpha' } });
  await view.settle();
  assert.ok(unsavedChip(view), 'the edited model shows the 未保存 chip');
  assert.equal(saveButton(view).props['data-dirty'], 'true');
  assert.ok(draftNote(view), 'the footer explains the draft is memory-only');
  assert.match(draftNote(view).children.join(''), /刷新后丢失/);

  selectModel(view, 1);
  await view.settle();
  assert.equal(modelName(view).props.value, 'beta-model', 'B shows its own saved values');
  assert.equal(apiKey(view).props.value, '');
  assert.equal(unsavedChip(view), undefined, 'B itself is clean');
  assert.equal(saveButton(view).props['data-dirty'], 'true', 'the form still has an unsaved draft');
  assert.equal(railItems(view).filter(node => node.props['data-draft'] === 'true').length, 1, 'the rail marks the drafted model');

  selectModel(view, 0);
  await view.settle();
  assert.equal(modelName(view).props.value, 'alpha-edited', 'A’s unsaved model name is restored');
  assert.equal(apiKey(view).props.value, 'sk-draft-alpha', 'A’s unsaved key is restored');
  assert.ok(unsavedChip(view));
  assert.deepEqual(modelSettingsDraftKeys(), ['alpha']);
  assert.deepEqual(view.values.modelProfiles.find(profile => profile.id === 'alpha').modelName, 'alpha-model', 'switching never writes to the Host');
  assert.deepEqual(view.writes, []);
});

test('saving persists the drafts, then clears the chip and the promoted save button', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();
  assert.ok(unsavedChip(view));

  await view.save();
  await view.settle();
  assert.equal(view.values.modelProfiles.find(profile => profile.id === 'alpha').modelName, 'alpha-edited');
  assert.equal(unsavedChip(view), undefined, 'the saved model is no longer a draft');
  assert.equal(saveButton(view).props['data-dirty'], 'false');
  assert.equal(draftNote(view), undefined);
  assert.deepEqual(modelSettingsDraftKeys(), [], 'saving clears the memory draft table');

  const reopened = modelSettingsHarness({ profiles: view.values.modelProfiles });
  await reopened.settle();
  assert.equal(unsavedChip(reopened), undefined, 'a later mount does not resurrect a saved draft');
});

test('a new model is a draft and cancelling it drops the draft', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  button(view, '＋ 添加模型').props.onClick();
  await view.settle();
  assert.equal(railItems(view).length, 3);
  assert.match(view.text(), /新模型/);
  assert.ok(unsavedChip(view), 'the empty new model is an unsaved draft');
  assert.ok(button(view, '取消'), 'a never-saved model offers 取消');
  assert.deepEqual(modelSettingsDraftKeys().length, 1);
  assert.ok(!['alpha', 'beta'].includes(modelSettingsDraftKeys()[0]));

  modelName(view).props.onChange({ target: { value: 'gamma-model' } });
  await view.settle();
  button(view, '取消').props.onClick();
  await view.settle();
  assert.equal(railItems(view).length, 2, 'cancelling removes the new model again');
  assert.equal(unsavedChip(view), undefined);
  assert.equal(modelName(view).props.value, 'alpha-model', 'cancelling returns to the model that was selected before');
  assert.deepEqual(modelSettingsDraftKeys(), [], 'cancelling discards the new draft');

  const reopened = modelSettingsHarness();
  await reopened.settle();
  assert.equal(railItems(reopened).length, 2, 'the cancelled model never reaches a later mount');
  assert.match(reopened.text(), /alpha-model/);
});

test('closing and reopening the sheet restores the same draft from the memory table', async () => {
  const first = modelSettingsHarness();
  await first.settle();
  modelName(first).props.onChange({ target: { value: 'alpha-edited' } });
  await first.settle();
  apiKey(first).props.onChange({ target: { value: 'sk-kept-in-memory' } });
  await first.settle();

  // A fresh mount is what closing and reopening the settings sheet does.
  const second = modelSettingsHarness();
  await second.settle();
  assert.equal(modelName(second).props.value, 'alpha-edited');
  assert.equal(apiKey(second).props.value, 'sk-kept-in-memory');
  assert.ok(unsavedChip(second));
  assert.equal(second.values.modelProfiles.find(profile => profile.id === 'alpha').modelName, 'alpha-model', 'the draft was never persisted');

  // The in-memory draft is all there is: a new page starts from storage.
  clearModelSettingsDrafts();
  const third = modelSettingsHarness();
  await third.settle();
  assert.equal(modelName(third).props.value, 'alpha-model');
  assert.equal(unsavedChip(third), undefined);
});

test('「重新读取」discards drafts, restores a pending removal and says so', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();

  selectModel(view, 1);
  await view.settle();
  button(view, '移除').props.onClick();
  await view.settle();
  assert.equal(railItems(view).length, 1, 'removing B only edits the in-memory list');
  assert.deepEqual(modelSettingsDraftKeys(), ['alpha', 'beta'], 'the pending removal is a draft too');

  await button(view, '重新读取').props.onClick();
  await view.settle();
  assert.equal(railItems(view).length, 2, 'reload brings the unsaved removal back');
  assert.equal(modelName(view).props.value, 'alpha-model', 'reload discards the unsaved edit');
  assert.equal(unsavedChip(view), undefined);
  assert.deepEqual(modelSettingsDraftKeys(), []);
  assert.match(view.text(), /已丢弃未保存的草稿/, 'discarding drafts is announced, not silent');
});

test('「撤销修改」drops only the selected model draft', async () => {
  const view = modelSettingsHarness();
  await view.settle();
  modelName(view).props.onChange({ target: { value: 'alpha-edited' } });
  await view.settle();
  assert.ok(button(view, '撤销修改'));
  button(view, '撤销修改').props.onClick();
  await view.settle();
  assert.equal(modelName(view).props.value, 'alpha-model');
  assert.equal(unsavedChip(view), undefined);
  assert.deepEqual(modelSettingsDraftKeys(), []);
  assert.deepEqual(view.writes, []);
});
