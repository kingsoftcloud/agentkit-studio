import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client-fragments/05-resource-workspaces.js', import.meta.url), 'utf8');
const source = fragment.slice(fragment.indexOf('function MarketplacePage()'), fragment.indexOf('function UnsupportedStudioPage'));

// Exercise the shipped page's event handlers and state without a DOM/browser.
function page(hostRemote) {
  const values = [], effects = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const Page = new Function('useState', 'useEffect', 'h', 'React', 'hostRemote', 'BRAND', 'buttonStyle', 'inputStyle', 'Pill', 'EmptyState', 'ResourceDialog', `${source}; return MarketplacePage;`)(useState, effect => { if (!effects.length) effects.push(effect); }, h, { Fragment: 'fragment' }, hostRemote, {}, () => ({}), () => ({}), 'pill', 'empty', 'dialog');
  const render = () => { cursor = 0; return Page(); };
  function walk(node) { return node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : []; }
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const find = (type, label) => walk(render()).find(node => node.type === type && (node.props['aria-label'] === label || text(node) === label));
  const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  render();
  return { render, find, text, walk, settle, load: async () => { await effects[0](); } };
}

test('marketplace Codex install button forwards the complete plugin id', async () => {
  const calls = [];
  let installed = false;
  const host = { dshPlugins: async () => ({ items: [] }), codexPlugins: async () => ({ items: [{ pluginId: 'sample@market', name: 'sample', installed, marketplaceName: 'market' }] }), installCodexPlugin: async (...args) => { calls.push(args); installed = true; return { note: '新会话生效' }; } };
  const ui = page(host);
  await ui.load();
  ui.find('button', 'Codex 插件').props.onClick();
  ui.find('button', '安装 sample').props.onClick();
  await ui.settle();
  assert.deepEqual(calls, [['sample@market', 'market']]);
  assert.match(ui.text(ui.render()), /新会话生效/);
  assert.ok(ui.find('button', '管理 sample'));
});

test('marketplace enable refreshes selected detail and keeps restart guidance', async () => {
  let enabled = false;
  const host = { dshPlugins: async () => ({ items: [{ pluginId: 'addon', name: 'addon', installed: true, enabled, source: 'bundled', status: enabled ? 'selected' : 'disabled' }] }), codexPlugins: async () => ({ items: [] }), enableDshPlugin: async () => { enabled = true; return { note: '需要重启 Host 后生效。' }; } };
  const ui = page(host);
  await ui.load();
  ui.find('button', '管理 addon').props.onClick();
  ui.find('button', '启用').props.onClick({ stopPropagation() {} });
  await ui.settle();
  assert.equal(ui.find('button', '启用'), undefined);
  assert.ok(ui.find('button', '停用'));
  assert.match(ui.text(ui.render()), /需要重启 Host/);
});

test('marketplace adds plugins from the plus dialog and surfaces real install failures', async () => {
  const host = { dshPlugins: async () => ({ items: [] }), codexPlugins: async () => ({ items: [] }), installDshPlugin: async () => { throw new Error('插件源检查失败：not-a-bundle'); } };
  const ui = page(host);
  await ui.load();
  ui.find('button', '添加插件').props.onClick();
  ui.find('input', '插件安装源').props.onChange({ target: { value: 'plain-package' } });
  const form = ui.walk(ui.render()).find(node => node.type === 'form');
  await form.props.onSubmit({ preventDefault() {} });
  assert.match(ui.text(ui.render()), /not-a-bundle/);
  assert.match(ui.text(ui.walk(ui.render()).find(node => node.type === 'dialog')), /not-a-bundle/);
  assert.ok(ui.find('input', '插件安装源'));
  assert.doesNotMatch(ui.text(ui.render()), /plain-package：已安装/);
});

test('marketplace never offers destructive lifecycle controls for protected bundles', async () => {
  const ui = page({ dshPlugins: async () => ({ items: [{ pluginId: 'studio', name: 'studio', installed: true, enabled: true, removable: false, readOnlyReason: 'management-required' }] }), codexPlugins: async () => ({ items: [] }) });
  await ui.load();
  ui.find('button', '管理 studio').props.onClick();
  assert.equal(ui.find('button', '卸载'), undefined);
  assert.equal(ui.find('button', '停用'), undefined);
});
