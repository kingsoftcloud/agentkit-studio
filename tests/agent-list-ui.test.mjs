import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client-fragments/03-agents-and-authoring.js', import.meta.url), 'utf8');
const source = fragment.slice(fragment.indexOf('function AgentsPage'), fragment.indexOf('const PLATFORM_RESOURCE_META'));
const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
function render(agents, query = '') {
  const states = [agents, 'ready', '', [], query, 'all', 1, 20, agents.length];
  let cursor = 0;
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const Page = new Function('useState', 'useEffect', 'useRef', 'h', 'React', 'window', 'BRAND', 'hostRemote', 'inputStyle', 'buttonStyle', 'pagerButtonStyle', 'StudioSubnav', 'RuntimeCatalogPage', 'EmptyState', 'Pill', 'RUNTIME_LABELS', `${source}; return AgentsPage;`)(
    () => [states[cursor++], () => {}], () => {}, () => ({ current: 0 }), h, { Fragment: 'fragment' }, {}, {}, {}, () => ({}), () => ({}), () => ({}), 'nav', 'runtime', 'empty', 'pill', {},
  );
  return walk(Page({}));
}

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
