import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverviewPage } from '../src/client/pages/overview.mjs';
import { createRuntimeCatalogPage } from '../src/client/pages/runtime-catalog.mjs';
import { createStatusText } from '../src/client/components/status-text.mjs';
import { createOperationalComponents } from '../src/client/components/operational.mjs';
import { createStudioPrimitives } from '../src/client/components/primitives.mjs';

const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : [];
const text = tree => tree && typeof tree === 'object' ? tree.children.map(text).join('') : String(tree ?? '');
const react = values => {
  let cursor = 0;
  return { createElement: h, useEffect() {}, useState: initial => [cursor in values ? values[cursor++] : (cursor++, initial), () => {}] };
};
const ui = values => ({ React: react(values), BRAND: {}, buttonStyle: () => ({}), SectionHeading: 'SectionHeading', EmptyState: 'EmptyState', StartChecks: 'StartChecks', Pill: 'Pill' });

test('overview start cards and workspace use only existing actions and totals', () => {
  const events = [], routes = [];
  const Page = createOverviewPage({ ui: ui([{ status: 'ready', agents: 3, runtimes: 2 }, { status: 'ready', configured: false }]), hostRemote: {}, window: { dispatchEvent: event => events.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } } });
  const tree = Page({ onNavigate: route => routes.push(route) }), all = nodes(tree);
  assert.equal(all.filter(node => node.props.className === 'studio-start-card').length, 3);
  assert.equal(all.filter(node => node.props.className === 'studio-stats studio-panel')[0].children.length, 4);
  for (const label of ['对话创建', '手动配置', '从模板开始', '去配置']) all.find(node => node.type === 'button' && (text(node) === label || node.children.some(child => child.type === 'strong' && text(child) === label))).props.onClick();
  assert.deepEqual(events, ['agentkit-studio:open-authoring', 'agentkit-studio:open-settings']);
  assert.deepEqual(routes, ['agents', 'experts']);
  assert.equal(all.some(node => node.props.onClick && text(node).startsWith('运行时')), false);
});

test('overview empty/loading and error states keep recovery and credential warnings', () => {
  for (const status of ['loading', 'error', 'ready']) {
    const Page = createOverviewPage({ ui: ui([{ status, agents: 0, runtimes: null, error: 'Host offline', warning: 'Runtime unavailable' }, { status: 'ready', configured: true }]), hostRemote: {}, window: {} });
    const all = nodes(Page({}));
    assert.equal(all.some(node => node.type === 'EmptyState'), status !== 'ready');
    assert.equal(all.some(node => text(node) === '去配置'), false);
    assert.ok(all.some(node => node.props.role === 'status' && text(node) === 'Runtime unavailable'));
    if (status === 'error') assert.equal(all.find(node => node.type === 'EmptyState').props.detail, 'Host offline');
  }
});

test('runtime catalog renders disabled Star Harness and existing Codex availability as rows', () => {
  const Page = createRuntimeCatalogPage({ ui: ui(['ready', [{ runtimeType: 'harness' }, { runtimeType: 'codex' }, { runtimeType: 'dsh-native' }], false, '']), hostRemote: {}, window: {} });
  const rows = nodes(Page({})).filter(node => node.props.className === 'studio-row studio-runtime-row');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].props['aria-disabled'], true);
  assert.equal(rows[0].props.title, '该能力暂未开放');
  assert.match(text(rows[0]), /未开放/);
  assert.doesNotMatch(text(rows[0]), /可选/);
  assert.match(text(rows[1]), /Provider 未注册/);
  assert.equal(nodes(rows[0]).some(node => node.type === 'button'), false);
});

test('runtime catalog empty and failed reads keep existing recovery', () => {
  for (const [status, title] of [['ready', '没有可用运行目标'], ['error', '运行目标不可用']]) {
    const Page = createRuntimeCatalogPage({ ui: ui([status, [], false, 'Catalog offline']), hostRemote: {}, window: {} });
    const empty = nodes(Page({})).find(node => node.type === 'EmptyState');
    assert.equal(empty.props.title, title);
    if (status === 'error') assert.equal(empty.props.detail, 'Catalog offline');
  }
});

test('status text preserves labels and attributes without colored pill surfaces', () => {
  const Status = createStatusText(h);
  for (const [tone, expected] of [['accent', 'ok'], ['signal', 'warn'], ['neutral', 'neutral']]) {
    const node = Status({ tone, role: 'status', children: 'Existing label' });
    assert.equal(node.props.className, 'studio-st');
    assert.equal(node.props['data-tone'], expected);
    assert.equal(node.props.role, 'status');
    assert.equal(text(node), 'Existing label');
  }
});

test('operational object rows retain cells and dispatch while time records remain tables', () => {
  const { OperationalTable } = createOperationalComponents({ ui: { React: { createElement: h }, BRAND: {} } });
  const row = { id: 'one', name: 'Example' }, opened = [];
  const props = { columns: [{ id: 'name', label: '名称' }], rows: [row], onRowClick: item => opened.push(item) };
  const list = OperationalTable({ ...props, layout: 'rows' });
  assert.equal(text(list), '◈Example');
  nodes(list).find(node => node.type === 'article').props.onClick();
  assert.deepEqual(opened, [row]);
  assert.ok(nodes(OperationalTable(props)).some(node => node.type === 'table' && node.props.className === 'studio-tbl'));
  assert.equal(OperationalTable({ ...props, rows: [], layout: 'rows' }).children[0].props.className, 'studio-empty');
});

test('operational tables fit the desktop column and toolbar filters share its available width', () => {
  const { OperationalTable, OperationalToolbar } = createOperationalComponents({ ui: { React: { createElement: h }, BRAND: {}, buttonStyle: () => ({}) } });
  for (const rows of [[], [{ id: 'trace-1' }]]) {
    const table = OperationalTable({ columns: Array.from({ length: 7 }, (_, id) => ({ id, label: String(id) })), rows });
    assert.equal(nodes(table).find(node => node.type === 'table').props.style.minWidth, '680px');
  }
  const toolbar = OperationalToolbar({ children: h('input'), onRefresh() {} });
  assert.equal(toolbar.children[0].props.style.flex, 1);
  assert.equal(toolbar.children[0].props.style.minWidth, 0);
});

test('operational headings group multiple actions at the right without losing empty or error help', () => {
  const { OperationalPageHeading } = createStudioPrimitives({ React: react([]) });
  const actions = h('Fragment', null, h('button', null, '新增渠道'), h('span', null, '待配置'));
  const heading = OperationalPageHeading({ title: 'Channels', detail: '连接错误', action: actions });
  assert.equal(heading.children[1].props.className, 'studio-page-actions');
  assert.equal(heading.children[1].children[0], actions);
  assert.ok(nodes(heading).some(node => node.props.title === '连接错误'));
  assert.equal(OperationalPageHeading({ title: '观测' }).children.length, 1);
});
