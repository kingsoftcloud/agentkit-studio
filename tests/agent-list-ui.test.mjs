import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client-fragments/03-agents-and-authoring.js', import.meta.url), 'utf8');
const source = fragment.slice(fragment.indexOf('function AgentsPage'), fragment.indexOf('const PLATFORM_RESOURCE_META'));
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function render(agents, query = '', props = {}, changes = []) {
  const states = [agents, 'ready', '', [], query, 'all', 1, 20, agents.length];
  let cursor = 0;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const Page = new Function('useState', 'useEffect', 'useRef', 'h', 'React', 'window', 'BRAND', 'hostRemote', 'inputStyle', 'buttonStyle', 'pagerButtonStyle', 'StudioSubnav', 'RuntimeCatalogPage', 'EmptyState', 'Pill', 'RUNTIME_LABELS', `${source}; return AgentsPage;`)(
    () => { const index = cursor++; return [states[index], value => changes.push([index, value])]; }, () => {}, () => ({ current: 0 }), h, { Fragment: 'fragment' }, {}, {}, {}, () => ({}), () => ({}), () => ({}), 'nav', 'runtime', 'empty', 'pill', {},
  );
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

test('a previous revision Build is shown as historical, not a built current revision', () => {
  const nodes = render([{ metadata: { id: 'local-a', revision: 2 }, builds: [{ revision: 1, status: 'SUCCEEDED' }] }]);
  assert.ok(nodes.find(node => node.type === 'pill' && node.children.includes('有历史构建')));
  assert.equal(nodes.some(node => node.type === 'pill' && node.children.includes('已构建')), false);
});

test('Agent creation offers conversation and manual configuration as separate actions', () => {
  const routes = [];
  const nodes = render([], '', { onCreate: route => routes.push(route) });
  const buttons = nodes.filter(node => node.type === 'button');
  buttons.find(node => node.children.includes('对话创建')).props.onClick();
  buttons.find(node => node.children.includes('手动配置')).props.onClick();
  assert.deepEqual(routes, ['conversation', 'manual']);
  assert.equal(buttons.some(node => node.children.includes('快速创建') || node.children.includes('一键创建')), false);
});
