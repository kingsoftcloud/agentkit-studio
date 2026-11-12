import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourcePages } from '../src/client/pages/resources.mjs';
import { createFormStyles } from '../src/client/components/form-styles.mjs';

const h = (type, props, ...children) => ({ type, props, children });
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flat(Infinity).flatMap(nodes)] : [];
const text = tree => tree && typeof tree === 'object' ? tree.children.flat(Infinity).map(text).join('') : String(tree ?? '');
function render({ resources = [], kind = 'model', status = 'ready', error = '' } = {}) {
  let cursor = 0;
  const changes = [];
  const values = { 0: kind, 1: 'installed', 4: resources, 10: resources.length, 13: status, 15: error };
  const React = { createElement: h, Fragment: 'fragment', useEffect() {}, useRef: () => ({ current: 0 }), useState: initial => {
    const index = cursor++;
    return [Object.hasOwn(values, index) ? values[index] : typeof initial === 'function' ? initial() : initial, value => changes.push([index, value])];
  } };
  const ui = { React, ...createFormStyles() };
  for (const name of ['ContentIntro', 'EmptyState', 'StudioPageTabs', 'StudioSubnav', 'Pill', 'ModelResourceDialog', 'ResourceDialog']) ui[name] = name;
  const { ResourcesPage } = createResourcePages({ ui, hostRemote: {}, window: { localStorage: { getItem() {}, removeItem() {} } } });
  const tree = ResourcesPage();
  return { tree, all: nodes(tree), changes };
}

test('resource rows consolidate metadata, keep status detail and dispatch viewing', () => {
  const resource = { resourceId: 'model-one', displayName: '模型一', source: 'local', version: 'v1', status: 'ready' };
  const { tree, all, changes } = render({ resources: [resource] });
  const row = all.find(node => node.props?.['data-studio-resource-card']);
  assert.equal(row.props.className, 'resource-row');
  assert.equal(row.props.title, '目录状态不代表 Agent 绑定后的实际执行结果。');
  assert.ok(text(row).includes('本地配置 · v1 · model-one'));
  assert.equal(text(row).includes(row.props.title), false);
  assert.equal(all.find(node => node.props?.['data-studio-resource-grid']).props.style.flexDirection, 'column');
  assert.equal(text(tree).includes('Host 已连接'), false);
  all.find(node => node.type === 'button' && text(node) === '查看').props.onClick();
  assert.deepEqual(changes.at(-1), [23, resource]);
  const search = all.find(node => node.props?.['aria-label'] === '搜索资源');
  assert.equal(search.props.style.height, '36px');
  const toolbar = all.find(node => node.props?.className === 'resource-toolbar');
  assert.ok(nodes(toolbar).includes(search));
  assert.ok(nodes(toolbar).some(node => node.props?.['aria-label'] === '资源下一页'));
  const pageSize = nodes(toolbar).find(node => node.props?.['aria-label'] === '每页显示数量');
  assert.equal(pageSize.props.className, 'af-select');
  assert.equal(pageSize.props.style.height, '32px');
  assert.equal(pageSize.props.style.background, undefined);
  pageSize.props.onChange({ target: { value: '50' } });
  assert.deepEqual(changes.at(-1), [7, 50]);
  assert.ok(nodes(toolbar).some(node => node.props?.['aria-label'] === '刷新' && nodes(node).some(child => child.type === 'svg')));
  const add = nodes(toolbar).find(node => node.type === 'button' && text(node) === '添加模型');
  assert.equal(add.props.style.background, 'var(--dsw-alias-button-primary-fill, #0b0b0d)');
});

test('MCP rows retain every local action and a visible error status', () => {
  const { all } = render({ kind: 'mcp', resources: [{ resourceId: 'local-mcp', source: 'local', health: { errorCode: 'unreachable' } }] });
  const row = all.find(node => node.props?.['data-studio-resource-card']);
  assert.equal(row.props.title, 'unreachable');
  assert.ok(text(row).includes('探测失败'));
  assert.deepEqual(nodes(row).filter(node => node.type === 'button').map(text), ['查看', '编辑凭证', '重新探测', '查看工具', '移除配置']);
});

test('empty and unavailable catalogs preserve their existing recovery surfaces', () => {
  const empty = render();
  assert.ok(empty.all.some(node => node.type === 'EmptyState' && node.props.title === '暂无模型'));
  assert.equal(empty.all.some(node => node.props?.['data-studio-resource-card']), false);
  const failed = render({ status: 'error', error: '目录离线' });
  const recovery = failed.all.find(node => node.type === 'EmptyState' && node.props.title === '资源目录不可用');
  assert.equal(recovery.props.detail, '目录离线');
  assert.equal(text(recovery.props.action), '重新读取');
});
