import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPages } from '../src/client/pages/agents.mjs';
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk), ...walk(node.props.anchor)] : [];
function render(agents, query = '', props = {}, changes = [], menuOpen = false, status = 'ready', window = {}) {
  const states = [agents, status, '', [], query, 'all', 1, 20, agents.length, '', menuOpen];
  let cursor = 0;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const { AgentsPage: Page } = createAgentPages({ ui: { React: { Fragment: 'fragment', createElement: h, useState: () => { const index = cursor++; return [states[index], value => changes.push([index, value])]; }, useEffect() {}, useRef: () => ({ current: 0 }) }, Menu: 'menu', MenuItemButton: 'menuitem', BRAND: {}, inputStyle: () => ({}), buttonStyle: () => ({}), pagerButtonStyle: () => ({}), StudioSubnav: 'nav', RuntimeCatalogPage: 'runtime', EmptyState: 'empty', Pill: 'pill', RUNTIME_LABELS: {}, DEPLOYMENT_LABELS: {} }, window, hostRemote: {}, actions: {} });
  return walk(Page(props));
}

test('clicking the active Agent tab keeps its list, query and page', () => {
  const changes = [], navigation = [];
  const nodes = render([{ metadata: { id: 'local-a' } }], 'local', { tab: 'local', onTabChange: value => navigation.push(value) }, changes);
  const tabs = nodes.find(node => node.type === 'nav');
  tabs.props.onChange('local');
  assert.deepEqual(changes, []);
  assert.deepEqual(navigation, []);
  tabs.props.onChange('cloud');
  assert.deepEqual(navigation, ['cloud']);
  assert.ok(changes.some(([index, value]) => index === 1 && value === 'loading'));
});

test('zero search results retain the search input and do not claim there are no Agents', () => {
  const nodes = render([], 'missing-agent');
  assert.ok(nodes.find(node => node.props['aria-label'] === '搜索 Agent'));
  assert.ok(nodes.find(node => node.props.title === '没有匹配的 Agent'));
  assert.equal(nodes.some(node => node.props.title === '还没有 Agent'), false);
});

test('Agent chips, search and refresh share one toolbar while pagination stays below the list', () => {
  const nodes = render([{ metadata: { id: 'local-a' } }]);
  const toolbar = nodes.find(node => node.props.className === 'ak-agents-toolbar');
  const controls = walk(toolbar);
  assert.ok(controls.some(node => node.type === 'nav'));
  assert.equal(controls.find(node => node.props['aria-label'] === '搜索 Agent').props.style.width, '220px');
  assert.ok(controls.some(node => node.props['aria-label'] === '刷新 Agent'));
  assert.equal(controls.some(node => node.props['data-studio-pager']), false);
  assert.ok(nodes.find(node => node.props['data-studio-pager']));
  assert.ok(controls.find(node => node.props['aria-label'] === '筛选 Agent 状态').props.className.includes('studio-pick-quiet'));
});

test('a previous revision Build is shown as historical, not a built current revision', () => {
  const nodes = render([{ metadata: { id: 'local-a', revision: 2 }, builds: [{ revision: 1, status: 'SUCCEEDED' }] }]);
  assert.ok(nodes.find(node => node.props.className === 'studio-st' && node.children.includes('有历史构建')));
  assert.equal(nodes.some(node => node.type === 'pill' && node.children.includes('已构建')), false);
});

test('Agent creation offers conversation first and secondary paths in an attached menu', () => {
  const routes = [], changes = [];
  const props = { onCreate: route => routes.push(route), onNavigate: route => routes.push(route) };
  let nodes = render([], '', props, changes);
  const buttons = nodes.filter(node => node.type === 'button');
  buttons.find(node => node.children.includes('对话创建')).props.onClick();
  assert.equal(nodes.find(node => node.type === 'menu').props.open, false);
  assert.equal(nodes.find(node => node.type === 'menu').props.align, 'end');
  buttons.find(node => node.props['aria-label'] === '更多创建方式').props.onClick();
  assert.equal(changes.at(-1)[1](false), true);
  nodes = render([], '', props, changes, true);
  assert.equal(nodes.find(node => node.type === 'menu').props.open, true);
  nodes.find(node => node.type === 'menuitem' && node.children.includes('手动配置')).props.onSelect();
  assert.deepEqual(routes, ['conversation', 'manual']);
  nodes.find(node => node.type === 'menuitem' && node.children.includes('从专家模板创建')).props.onSelect();
  assert.equal(routes.at(-1), 'experts');
  nodes.find(node => node.type === 'menu').props.onClose();
  assert.deepEqual(changes.at(-1), [10, false]);
  assert.equal(buttons.some(node => node.children.includes('快速创建') || node.children.includes('一键创建')), false);
});

test('API-created ManagedRuntime cards expose separate management and deletion actions', () => {
  const nodes = render([{ metadata: { id: 'ar-managed', name: '托管 Agent', local: false }, managedRuntime: true,
    source: 'agentengine-managed-runtime', deployment: { available: true }, spec: { runtime: { type: 'dsh-native' } } }], '', { tab: 'cloud' });
  assert.ok(nodes.find(node => node.type === 'button' && node.children.includes('管理')));
  assert.ok(nodes.find(node => node.type === 'menuitem' && node.children.includes('删除')));
  assert.equal(nodes.some(node => node.type === 'button' && node.children.includes('管理 / 删除')), false);
});

test('the split create group preserves unavailable manual and conversation rules', () => {
  for (const status of ['loading', 'error']) {
    const nodes = render([], '', {}, [], true, status);
    assert.equal(nodes.find(node => node.type === 'button' && node.children.includes('对话创建')).props.disabled, true);
    assert.equal(nodes.find(node => node.type === 'menuitem' && node.children.includes('手动配置')).props.disabled, true);
    assert.equal(nodes.find(node => node.type === 'menuitem' && node.children.includes('从专家模板创建')).props.disabled, undefined);
    assert.equal(nodes.find(node => node.props['aria-label'] === '更多创建方式').props.disabled, undefined);
  }
});

test('Agent rows consolidate metadata while retaining keyboard and action dispatch', () => {
  const edited = [];
  const agent = { metadata: { id: 'local-row', name: '助手', revision: 2 }, spec: { runtime: { type: 'codex' } } };
  const nodes = render([agent], '', { onEdit: value => edited.push(value) });
  const row = nodes.find(node => node.props['data-studio-agent-card'] === 'local-row');
  assert.equal(row.props.tabIndex, 0);
  assert.ok(nodes.some(node => node.props.className === 'studio-tile'));
  assert.ok(nodes.some(node => node.props.className === 'studio-row-meta' && node.children.includes('codex · r2')));
  assert.ok(nodes.some(node => node.props.className === 'studio-row-id' && node.children.includes('local-row')));
  assert.equal(nodes.find(node => node.props['data-studio-agent-grid']).props.style.flexDirection, 'column');
  row.props.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(edited, [agent]);
});

test('local rows expose one build or deploy next step and keep conversation binding', async () => {
  for (const built of [false, true]) {
    const routes = [], events = [], stored = [], bound = [];
    const agent = { metadata: { id: 'a', local: true, revision: 2 }, builds: built ? [{ status: 'SUCCEEDED', revision: 2 }] : [] };
    const window = { localStorage: { setItem: (...args) => stored.push(args) }, dispatchEvent: event => events.push(event) };
    const nodes = render([agent], '', { onNavigate: route => routes.push(route), onBindAgent: value => bound.push(value) }, [], false, 'ready', window);
    const next = nodes.find(node => node.type === 'button' && node.children.includes(built ? '部署' : '构建'));
    assert.equal(next.props['data-variant'], 'outline');
    next.props.onClick({ stopPropagation() {} });
    assert.equal(JSON.parse(stored[0][1]).section, built ? 'deploy' : 'build');
    assert.equal(events[0].type, 'agentkit-studio:operations-focus');
    assert.deepEqual(routes, ['studio-operations']);
    const chat = nodes.find(node => node.type === 'button' && node.children.includes('对话'));
    assert.equal(chat.props['data-variant'], 'ghost');
    await chat.props.onClick({ stopPropagation() {} });
    assert.deepEqual(bound, [agent]);
    assert.ok(nodes.some(node => node.type === 'menuitem' && node.children.includes('编辑 Agent')));
    assert.ok(nodes.some(node => node.type === 'menuitem' && node.children.includes('删除')));
  }
  const nodes = render([{ metadata: { id: 'blocked' }, deployment: { available: false } }]);
  assert.equal(nodes.find(node => node.type === 'button' && node.children.includes('对话')).props.disabled, true);
});
