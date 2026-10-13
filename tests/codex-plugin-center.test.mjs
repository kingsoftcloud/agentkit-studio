import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client-fragments/05-resource-workspaces.js', import.meta.url), 'utf8');
const source = fragment.slice(fragment.indexOf('function CodexPluginMarketItem'), fragment.indexOf('function UnsupportedStudioPage'));

function page(hostRemote) {
  const values = [], effects = [];
  let cursor = 0;
  const useState = initial => {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) });
  const Page = new Function('useState', 'useEffect', 'h', 'React', 'hostRemote', 'BRAND', 'buttonStyle', 'inputStyle', 'Pill', 'EmptyState', 'CodexPluginCapabilities', 'ResourceDialog', `${source}; return CodexPluginMarketItem;`)(useState, effect => { effects.push(effect); }, h, { Fragment: 'fragment' }, hostRemote, { ink: '#111', inkMuted: '#777', border: '#ddd', surface: '#fff', canvas: '#f4f4f4', accentStrong: '#111', primaryFill: '#111', danger: '#b00', signal: '#946200' }, () => ({}), () => ({}), 'pill', 'empty', 'codex-capabilities', 'dialog');
  const render = (view = 'page') => { cursor = 0; return Page({ view }); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const find = (type, label) => walk(render()).find(node => node.type === type && (node.props['aria-label'] === label || text(node) === label));
  const buttonContaining = label => walk(render()).find(node => node.type === 'button' && text(node).includes(label));
  const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  return { render, find, buttonContaining, text, walk, effects, settle };
}

test('Codex plugin center keeps the marketplace-qualified id and lifecycle actions', async () => {
  const calls = [];
  let installed = false;
  const host = {
    codexPlugins: async () => ({ items: [{ pluginId: 'sample@market', name: 'sample', displayName: 'Sample', description: 'A Codex plugin', marketplaceName: 'market', installed, status: installed ? 'enabled' : 'available', lifecycleAvailable: true }] }),
    installCodexPlugin: async (...args) => { calls.push(['install', ...args]); installed = true; return { note: '新会话生效', warnings: ['需要重新加载'], appsNeedingAuth: [{ id: 'app', name: 'App', installUrl: 'https://example.com/auth' }] }; },
    uninstallCodexPlugin: async (...args) => { calls.push(['uninstall', ...args]); installed = false; return { note: '已卸载' }; },
  };
  const ui = page(host);
  ui.render();
  await ui.effects[0]();
  await ui.settle();
  ui.find('button', '安装').props.onClick();
  await ui.settle();
  assert.deepEqual(calls, [['install', 'sample@market', 'market']]);
  assert.match(ui.text(ui.render()), /新会话生效/);
  assert.match(ui.text(ui.render()), /需要重新加载/);
  assert.equal(ui.find('a', 'App').props.href, 'https://example.com/auth');
  assert.equal(ui.walk(ui.render()).find(node => node.type === 'codex-capabilities').props.pluginId, 'sample@market');
  assert.ok(ui.find('button', '卸载'));
  ui.find('button', '卸载').props.onClick();
  await ui.settle();
  assert.deepEqual(calls[1], ['uninstall', 'sample@market']);
  assert.ok(ui.find('button', '安装'));
  assert.equal(ui.walk(ui.render()).find(node => node.type === 'codex-capabilities'), undefined);
});

test('Codex detail keeps operation failures visible without changing installed state', async () => {
  const ui = page({
    codexPlugins: async () => ({ items: [{ pluginId: 'sample@market', displayName: 'Sample', installed: true }] }),
    uninstallCodexPlugin: async () => { throw new Error('卸载失败，请检查 Codex 配置'); },
  });
  ui.render(); await ui.effects[0](); await ui.settle();
  ui.buttonContaining('Sample').props.onClick();
  ui.find('button', '卸载').props.onClick(); await ui.settle();
  assert.match(ui.text(ui.render()), /卸载失败，请检查 Codex 配置/);
  assert.ok(ui.find('button', '卸载'));
  assert.doesNotMatch(ui.text(ui.render()), /已卸载/);
});

test('Codex manual install preserves qualified ids and displays errors in its dialog', async () => {
  const calls = [];
  const ui = page({
    codexPlugins: async () => ({ items: [] }),
    installCodexPlugin: async (...args) => { calls.push(args); throw new Error('插件市场未配置'); },
  });
  ui.render(); await ui.effects[0](); await ui.settle();
  ui.find('button', '添加 Codex 插件').props.onClick();
  ui.find('input', 'Codex 插件标识').props.onChange({ target: { value: ' sample@market ' } });
  const form = ui.walk(ui.render()).find(node => node.type === 'form');
  await form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, [['sample@market', undefined]]);
  const dialog = ui.walk(ui.render()).find(node => node.type === 'dialog');
  assert.match(ui.text(dialog), /插件市场未配置/);
  assert.doesNotMatch(ui.text(ui.render()), /已安装/);
});

test('Codex cached or restricted plugins remain discoverable with no lifecycle controls', async () => {
  for (const restriction of [{ status: 'cached', lifecycleAvailable: false }, { readOnlyReason: 'codex-install-confirmation' }, { readOnlyReason: 'codex-unavailable' }]) {
    const ui = page({ codexPlugins: async () => ({ items: [{ pluginId: 'sample@market', displayName: 'Sample', installed: false, ...restriction }], error: { message: '部分市场不可用' } }) });
    ui.render(); await ui.effects[0](); await ui.settle();
    assert.match(ui.text(ui.render()), /部分市场不可用/);
    assert.ok(ui.buttonContaining('Sample'));
    assert.equal(ui.find('button', '安装'), undefined);
    ui.buttonContaining('Sample').props.onClick();
    assert.equal(ui.find('button', '安装'), undefined);
    assert.equal(ui.find('button', '卸载'), undefined);
  }
});

test('Codex plugin center does not render a second DSH market in the Studio resource workspace', async () => {
  const operations = await readFile(new URL('../src/client-fragments/06-automation-and-operations.js', import.meta.url), 'utf8');
  assert.match(operations, /items: \[\{ id: 'models', label: '模型与工具' \}, \{ id: 'runtime-resources', label: '运行资源' \}\]/);
  assert.doesNotMatch(operations, /id: 'marketplace', label: '插件市场'/);
  assert.doesNotMatch(fragment, /function MarketplacePage/);
});
