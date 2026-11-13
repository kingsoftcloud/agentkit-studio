import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentForm } from '../src/client/pages/agent-form.mjs';
import { createExpertCatalog } from '../packages/expert-catalog/src/catalog.mjs';
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function formHarness(props = {}) {
  const states = []; let cursor = 0;
  const useState = initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const Form = createAgentForm({ ui: { React: { createElement: h, useState, useEffect() {}, Fragment: 'fragment' }, BRAND: {}, ALLOWED_RUNTIME_TYPES: ['dsh-native', 'harness', 'codex'], RUNTIME_LABELS: {}, buttonStyle: () => ({}), inputStyle: () => ({}), SectionHeading: 'heading', PlatformResourcePicker: 'platform', Pill: 'pill' }, hostRemote: {} });
  const render = () => { cursor = 0; return walk(Form(props)); };
  const chooseResearch = () => render().find(node => node.type === 'button' && JSON.stringify(node.children).includes('研究助手')).props.onClick();
  const prompt = () => render().find(node => node.type === 'textarea' && node.props.placeholder === '描述 Agent 的身份、边界和回答方式');
  return { chooseResearch, prompt, render };
}

test('manual configuration treats templates as an optional collapsed section', () => {
  const nodes = formHarness().render();
  const templates = nodes.find(node => node.type === 'details');
  assert.ok(templates);
  assert.equal(Boolean(templates.props.open), false);
  assert.ok(walk(templates).some(node => node.type === 'summary' && node.children.includes('使用提示词模板（可选）')));
  assert.ok(nodes.some(node => node.type === 'heading' && node.props.title === '手动配置 Agent'));
});

test('manual form places the back link above the heading without changing navigation', () => {
  let returned = false;
  const nodes = formHarness({ onBack: () => { returned = true; } }).render();
  const header = nodes.find(node => node.props.className === 'af-page-heading');
  const back = nodes.find(node => node.props['aria-label'] === '返回 Agents');
  assert.ok(back.children.includes('‹ 智能体'));
  assert.equal(header.children[0].props.title, '手动配置 Agent');
  assert.ok(nodes.indexOf(back) < nodes.indexOf(header));
  back.props.onClick();
  assert.equal(returned, true);
});

test('research template fills an actual research Prompt', () => {
  const form = formHarness(); form.chooseResearch();
  assert.match(form.prompt().props.value, /研究助手/);
  assert.match(form.prompt().props.value, /来源/);
});

test('runtime radios skip the unavailable Star Harness with arrow keys and cannot select it', () => {
  const form = formHarness();
  const radios = form.render().filter(node => node.props.role === 'radio');
  const native = radios.find(node => node.props['data-runtime'] === 'dsh-native');
  const harness = radios.find(node => node.props['data-runtime'] === 'harness');
  assert.equal(harness.props.disabled, true);
  assert.equal(harness.props.title, '该能力暂未开放');
  assert.match(JSON.stringify(harness.children), /未开放/);
  harness.props.onClick();
  assert.equal(form.render().find(node => node.props['data-runtime'] === 'dsh-native').props['aria-checked'], true);
  let focused = false;
  native.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, currentTarget: { parentElement: { querySelectorAll: () => [{ disabled: false, focus() {} }, { disabled: true }, { disabled: false, focus() { focused = true; } }] } } });
  assert.equal(form.render().find(node => node.props['data-runtime'] === 'codex').props['aria-checked'], true);
  assert.equal(focused, true);
});

test('cloud editing retains the selected server runtime and disables every runtime card', () => {
  const nodes = formHarness({ initialAgent: { metadata: { id: 'cloud-a' }, source: 'agentengine-server', spec: { runtime: { type: 'langgraph' } } } }).render();
  assert.equal(nodes.find(node => node.props['data-runtime'] === 'langgraph').props['aria-checked'], true);
  assert.ok(nodes.filter(node => node.props.role === 'radio').every(node => node.props.disabled));
});

test('switching a template preserves a user-written Prompt', () => {
  const form = formHarness(); form.prompt().props.onChange({ target: { value: 'CUSTOM-PERSONA' } });
  form.chooseResearch(); assert.equal(form.prompt().props.value, 'CUSTOM-PERSONA');
});

test('catalog creation seeds the ordinary create form without turning it into an edit', () => {
  const draft = createExpertCatalog().prepare('knowledge-assistant');
  draft.spec.instructions.task = 'Reusable task method';
  const form = formHarness({ creationSeed: draft }), nodes = form.render();
  assert.ok(nodes.some(node => node.type === 'heading' && node.props.title === '配置你的专家'));
  assert.ok(nodes.some(node => node.type === 'input' && node.props.value === draft.name));
  assert.ok(nodes.some(node => ['input', 'textarea'].includes(node.type) && node.props.value === draft.description));
  assert.ok(nodes.some(node => node.type === 'textarea' && node.props.value === 'Reusable task method'));
  assert.equal(form.prompt().props.value, draft.spec.instructions.system);
  assert.ok(!nodes.some(node => node.type === 'details'));
  form.prompt().props.onChange({ target: { value: 'My custom role' } });
  assert.equal(form.prompt().props.value, 'My custom role');
  assert.notEqual(draft.spec.instructions.system, 'My custom role');
});
