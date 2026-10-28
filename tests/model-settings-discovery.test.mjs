import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelService } from '../src/model-service.mjs';
import { createModelSettingsSection } from '../src/client/pages/model-settings.mjs';

function ui(metadata, input, runtimeOptions = {}) {
  const values = { modelProfiles: [{ id: 'configured', provider: 'custom', modelName: 'vision', baseUrl: 'https://gateway.test/v1', credentialName: 'KEY', enabled: true, default: true, input, ...runtimeOptions }] };
  const config = {
    resolve: async () => ({ values }), describe: async () => ({ modelProfiles: values.modelProfiles }),
    update: async patch => Object.assign(values, patch),
  };
  const service = createModelService({ configuration: config, credentials: { resolve: async () => ({ value: 'test-key', source: 'env' }), set: async () => {} },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: Array.isArray(metadata) ? metadata : [metadata] }) }) });
  const states = [], effects = [];
  let cursor = 0, dirty = true, tree, applied;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
  const useState = initial => {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; dirty = true; }];
  };
  const useEffect = callback => { const index = cursor++; if (!(index in states)) { states[index] = true; effects.push(callback); } };
  const host = { settings: service.settings, updateSettings: service.save, modelCatalog: service.catalog, syncModelCredential: service.sync };
  const dshModel = { describe: async () => ({ namespaces: [] }), credentialStatus: async () => ({ configured: true }), applyProfiles: async payload => { applied = payload; } };
  const Component = createModelSettingsSection({
    ui: { React: { createElement: h, useState, useEffect }, BRAND: {}, Pill: 'pill', inputStyle: () => ({}), buttonStyle: () => ({}), SecretInput: 'SecretInput' },
    hostRemote: host, window: { dispatchEvent() {} }, CustomEvent: class {},
  });
  const render = () => { cursor = 0; dirty = false; tree = Component({ dshModel }); for (const callback of effects.splice(0)) callback(); };
  const settle = async () => { render(); for (let i = 0; i < 120; i++) { await Promise.resolve(); if (dirty) render(); } };
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
  return { settle, nodes: () => walk(tree), text: () => JSON.stringify(tree), values, applied: () => applied,
    save: () => walk(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }) };
}

test('model settings auto-discover image capability, persist it and show it after reread without a checkbox', async () => {
  const view = ui({ id: 'vision', architecture: { input_modalities: ['文字', '图片'] } });
  await view.settle();
  assert.equal(view.nodes().some(node => node.type === 'input' && node.props.type === 'checkbox'), false);
  assert.match(view.text(), /图片/);
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].input, ['text', 'image']);
  assert.deepEqual(view.applied().profiles[0].input, ['text', 'image']);
  assert.match(view.text(), /图片/);
});

test('a catalog without capabilities displays unknown and retains the last known profile input', async () => {
  const view = ui({ id: 'vision' }, ['text', 'image']);
  await view.settle();
  assert.match(view.text(), /未提供能力信息/);
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].input, ['text', 'image']);
});

test('changing the model drops its previous image capability until the new model is discovered', async () => {
  const view = ui([{ id: 'vision', input: ['text', 'image'] }, { id: 'text', input: ['text'] }], ['text', 'image']);
  await view.settle();
  view.nodes().find(node => node.type === 'input' && node.props.value === 'vision').props.onChange({ target: { value: 'text' } });
  await view.settle();
  assert.match(view.text(), /保存后自动识别/);
  await view.save();
  await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].input, ['text']);
  assert.deepEqual(view.applied().profiles[0].input, ['text']);
});

test('saving the model form preserves Native thinking, protocol and resource limits through both projections', async () => {
  const runtime = { displayName: 'Native validation', protocol: 'openai-chat', contextWindow: 128000,
    maxOutputTokens: 8192, requestTimeoutMs: 180000,
    parameters: { stream: true, thinking: { type: 'enabled' }, provider_thinking_display: true } };
  const view = ui({ id: 'vision', input: ['text'] }, ['text'], runtime);
  await view.settle(); await view.save(); await view.settle();
  for (const [key, value] of Object.entries(runtime)) {
    assert.deepEqual(view.values.modelProfiles[0][key], value, key);
    assert.deepEqual(view.applied().profiles[0][key], value, key);
  }
});

test('the Native thinking control changes only its declared option and preserves other model parameters', async () => {
  const view = ui({ id: 'vision', input: ['text'] }, ['text'], { parameters: { stream: true, temperature: 0.2 } });
  await view.settle();
  view.nodes().find(node => node.type === 'select' && node.props.value === 'default').props.onChange({ target: { value: 'enabled' } });
  await view.settle(); await view.save(); await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].parameters, { stream: true, temperature: 0.2, thinking: { type: 'enabled' } });
  view.nodes().find(node => node.type === 'select' && node.props.value === 'enabled').props.onChange({ target: { value: 'default' } });
  await view.settle(); await view.save(); await view.settle();
  assert.deepEqual(view.values.modelProfiles[0].parameters, { stream: true, temperature: 0.2 });
});
