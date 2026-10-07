import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client-fragments/04-create-edit-and-resources.js', import.meta.url), 'utf8');
const source = fragment.slice(fragment.indexOf('function AgentCreatePage'), fragment.indexOf('function inputStyle'));
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function formHarness() {
  const states = []; let cursor = 0;
  const useState = initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const Form = new Function('useState', 'useEffect', 'h', 'React', 'BRAND', 'hostRemote', 'ALLOWED_RUNTIME_TYPES', 'RUNTIME_LABELS', 'buttonStyle', 'inputStyle', 'SectionHeading', 'PlatformResourcePicker', 'Pill', `${source}; return AgentCreatePage;`)(useState, () => {}, h, { Fragment: 'fragment' }, {}, {}, ['dsh-native', 'harness', 'codex'], {}, () => ({}), () => ({}), 'heading', 'platform', 'pill');
  const render = () => { cursor = 0; return walk(Form({ mode: 'one-click' })); };
  const chooseResearch = () => render().find(node => node.type === 'button' && JSON.stringify(node.children).includes('研究助手')).props.onClick();
  const prompt = () => render().find(node => node.type === 'textarea' && node.props.placeholder === '描述 Agent 的身份、边界和回答方式');
  return { chooseResearch, prompt };
}

test('research template fills an actual research Prompt', () => {
  const form = formHarness(); form.chooseResearch();
  assert.match(form.prompt().props.value, /研究助手/);
  assert.match(form.prompt().props.value, /来源/);
});

test('switching a template preserves a user-written Prompt', () => {
  const form = formHarness(); form.prompt().props.onChange({ target: { value: 'CUSTOM-PERSONA' } });
  form.chooseResearch(); assert.equal(form.prompt().props.value, 'CUSTOM-PERSONA');
});
