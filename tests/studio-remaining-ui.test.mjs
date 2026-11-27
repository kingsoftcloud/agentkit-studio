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
  return { createElement: h, useEffect() {}, useRef: initial => ({ current: initial }), useState: initial => [cursor in values ? values[cursor++] : (cursor++, initial), () => {}] };
};
const ui = values => ({ React: react(values), BRAND: {}, buttonStyle: () => ({}), SectionHeading: 'SectionHeading', EmptyState: 'EmptyState', StartChecks: 'StartChecks', Pill: 'Pill' });

test('overview populated workspace renders real agents, activity and creation actions', () => {
  const events = [], routes = [], bound = [];
  const agents = [
    { metadata: { id: 'agent-code', name: '代码助手', revision: 2, createdAt: '2026-11-26T08:00:00Z' }, spec: { runtime: { type: 'codex' } }, builds: [{ status: 'SUCCEEDED', revision: 2 }] },
    { metadata: { id: 'agent-doc', name: '文档助手', revision: 1, createdAt: '2026-11-25T08:00:00Z' }, spec: { runtime: { type: 'dsh-native' } } },
  ];
  const connection = {
    status: 'ready', agents: 3, runtimes: 2, agentItems: agents,
    traceOverview: { total: 12, successRate: 0.75 },
    traces: [{ traceId: 'trace-1', agentId: 'agent-code', status: 'SUCCEEDED', durationMs: 1200, startedAt: '2026-11-26T09:00:00Z' }],
    schedules: [{ taskId: 'task-1', displayName: '每日总结', target: { agentId: 'agent-code' }, enabled: true, nextRunAt: '2026-11-27T09:00:00Z' }],
  };
  const Page = createOverviewPage({ ui: ui([connection, { status: 'ready', configured: false }, '']), actions: { bindAgent: async agentId => { bound.push(agentId); } }, hostRemote: {}, window: { dispatchEvent: event => events.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } } });
  const tree = Page({ onNavigate: route => routes.push(route) }), all = nodes(tree);
  assert.equal(all.filter(node => node.props.className === 'studio-start-card').length, 0);
  assert.equal(all.filter(node => node.props['data-overview-agent']).length, 2);
  assert.equal(all.filter(node => node.props.className === 'studio-overview-activity-row').length, 2);
  const metrics = all.find(node => node.props.className === 'studio-overview-metrics');
  assert.deepEqual(metrics.children.map(cell => cell.children.map(text)), [
    ['Agent', '3', '本地与云端 Agent'], ['可用运行时', '2', '当前 Host 可创建的运行目标'],
    ['24 小时运行', '12', 'Trace 运行记录'], ['运行完成率', '75%', '近 24 小时已完成运行'],
  ]);
  for (const label of ['对话创建', '手动配置', '从模板开始', '去配置']) all.find(node => node.type === 'button' && text(node).includes(label)).props.onClick();
  assert.deepEqual(events, ['agentkit-studio:open-authoring', 'agentkit-studio:create-manual-agent', 'agentkit-studio:open-settings']);
  assert.deepEqual(routes, ['agents', 'experts']);
  all.find(node => node.type === 'button' && text(node) === '对话').props.onClick();
  assert.deepEqual(bound, ['agent-code']);
  assert.equal(all.some(node => node.type === 'EmptyState'), false);
});

test('overview explains DSH runtimes and an empty activity sample without placeholder dashes', () => {
  const connection = {
    status: 'ready', agents: 1, runtimes: null,
    agentItems: [{ metadata: { id: 'agent-one', name: '示例 Agent', revision: 1 }, spec: { runtime: { type: 'dsh-native' } } }],
    traceOverview: { total: 0 }, traces: [], schedules: [],
  };
  const Page = createOverviewPage({ ui: ui([connection, { status: 'ready', configured: true }, '']), hostRemote: {}, window: {} });
  const all = nodes(Page({}));
  const metrics = all.find(node => node.props.className === 'studio-overview-metrics');
  assert.deepEqual(metrics.children[1].children.map(text), ['可用运行时', '1', 'DSH Native Harness']);
  assert.deepEqual(metrics.children[3].children.map(text), ['运行完成率', '暂无', '还没有运行记录']);
  assert.equal(metrics.children.some(cell => cell.children.some(child => text(child) === '—')), false);
});

test('overview offers model settings when credentials exist but no model is usable', () => {
  const events = [];
  const connection = { status: 'ready', agents: 1, runtimes: null, agentItems: [{ metadata: { id: 'agent-one', name: '示例 Agent' }, spec: {} }], traceOverview: { total: 0 }, traces: [], schedules: [] };
  const Page = createOverviewPage({ ui: ui([connection, { status: 'ready', configured: true, modelConfigured: false }, '']), hostRemote: {}, window: { dispatchEvent: event => events.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } } });
  const all = nodes(Page({}));
  assert.ok(all.some(node => node.props.role === 'status' && text(node).includes('还没有可用的模型')));
  const action = all.find(node => node.type === 'button' && text(node) === '无可用模型 · 去配置');
  action.props.onClick();
  assert.deepEqual(events, ['agentkit-studio:open-settings']);
});

test('overview zero-agent onboarding avoids empty workspace widgets and keeps recovery states', () => {
  for (const status of ['loading', 'error', 'ready']) {
    const Page = createOverviewPage({ ui: ui([{ status, agents: 0, runtimes: null, agentItems: [], traces: [], schedules: [], error: 'Host offline', warning: 'Runtime unavailable' }, { status: 'ready', configured: true }, '']), hostRemote: {}, window: {} });
    const all = nodes(Page({}));
    assert.equal(all.some(node => node.props.className === 'studio-overview-metrics'), false);
    assert.equal(all.some(node => node.props.className === 'studio-overview-grid-secondary'), false);
    assert.equal(all.some(node => node.type === 'EmptyState'), status !== 'ready');
    assert.equal(all.some(node => text(node) === '去配置'), false);
    assert.ok(all.some(node => node.props.role === 'status' && text(node) === 'Runtime unavailable'));
    if (status === 'ready') {
      assert.equal(all.filter(node => node.props.className === 'studio-start-card').length, 3);
      assert.equal(all.filter(node => node.props.className === 'studio-overview-guide-number').length, 3);
      assert.equal(all.some(node => text(node) === '最近 Agent'), false);
      assert.equal(all.some(node => text(node) === '最近运行'), false);
    } else {
      assert.equal(all.filter(node => node.props.className === 'studio-start-card').length, 0);
    }
    if (status === 'error') assert.equal(all.find(node => node.type === 'EmptyState').props.detail, 'Host offline');
  }
});

test('runtime catalog renders disabled Star Harness and existing Codex availability as rows', () => {
  const Page = createRuntimeCatalogPage({ ui: ui(['ready', [{ runtimeType: 'harness' }, { runtimeType: 'codex' }, { runtimeType: 'dsh-native' }], false, false, '']), hostRemote: {}, window: {} });
  const rows = nodes(Page({})).filter(node => node.props.className === 'studio-row studio-runtime-row');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].props['aria-disabled'], true);
  assert.equal(rows[0].props.title, '在插件页安装并启用 Star Harness');
  assert.match(text(rows[0]), /未启用/);
  assert.doesNotMatch(text(rows[0]), /可选/);
  assert.match(text(rows[1]), /Provider 未注册/);
  assert.ok(nodes(rows[0]).some(node => node.type === 'button' && text(node) === '打开插件中心'));
});

test('runtime catalog empty and failed reads keep existing recovery', () => {
  for (const [status, title] of [['ready', '没有可用运行目标'], ['error', '运行目标不可用']]) {
    const Page = createRuntimeCatalogPage({ ui: ui([status, [], false, false, 'Catalog offline']), hostRemote: {}, window: {} });
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
  const group = nodes(heading).find(node => node.props.className === 'studio-page-actions');
  assert.ok(group);
  assert.equal(group.children[0], actions);
  assert.ok(nodes(heading).some(node => node.props.title === '连接错误'));
  assert.equal(OperationalPageHeading({ title: '观测' }).children.length, 1);
});

test('manual Agent create intent survives the panel switch and is consumed once', async () => {
  const { MANUAL_AGENT_CREATE_EVENT, consumeManualAgentCreate, requestManualAgentCreate } = await import('../src/client/state/agent-create-intent.mjs');
  const events = [];
  const window = { dispatchEvent: event => events.push(event.type) };
  requestManualAgentCreate(window);
  assert.deepEqual(events, [MANUAL_AGENT_CREATE_EVENT]);
  // A workspace that mounts after the click consumes the pending intent once.
  assert.equal(consumeManualAgentCreate(), true);
  assert.equal(consumeManualAgentCreate(), false);
  // A workspace that is already mounted takes the announced event instead.
  requestManualAgentCreate(window);
  assert.deepEqual(events, [MANUAL_AGENT_CREATE_EVENT, MANUAL_AGENT_CREATE_EVENT]);
  assert.equal(consumeManualAgentCreate(), true);
  assert.equal(consumeManualAgentCreate(), false);
});
