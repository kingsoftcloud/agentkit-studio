import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentForm } from '../src/client/pages/agent-form.mjs';
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function formHarness() {
  const states = []; let cursor = 0;
  const useState = initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const Form = createAgentForm({ React: { createElement: h, useState, useEffect() {}, Fragment: 'fragment' }, BRAND: {}, hostRemote: {}, ALLOWED_RUNTIME_TYPES: ['dsh-native', 'harness', 'codex'], RUNTIME_LABELS: {}, buttonStyle: () => ({}), inputStyle: () => ({}), SectionHeading: 'heading', PlatformResourcePicker: 'platform', Pill: 'pill' });
  const render = () => { cursor = 0; return walk(Form({})); };
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

test('research template fills an actual research Prompt', () => {
  const form = formHarness(); form.chooseResearch();
  assert.match(form.prompt().props.value, /研究助手/);
  assert.match(form.prompt().props.value, /来源/);
});

test('switching a template preserves a user-written Prompt', () => {
  const form = formHarness(); form.prompt().props.onChange({ target: { value: 'CUSTOM-PERSONA' } });
  form.chooseResearch(); assert.equal(form.prompt().props.value, 'CUSTOM-PERSONA');
});
