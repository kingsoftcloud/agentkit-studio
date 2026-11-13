import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryPages } from '../src/client/pages/delivery.mjs';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const preview = request => ({ ...request, agentName: 'Selected Agent', revision: 1, environment: 'pre-online', region: 'test-region',
  runtime: 'harness', image: { version: 'test' }, resourceCounts: { models: 1, mcps: 0, skills: 0, remote: 0 }, identity: { kind: 'subaccount', userName: 'operator' }, warnings: [] });

function harness(name = 'CloudDeploymentPanel', initialProps = { agentId: 'a', selectedBuild: 'build-a' }, window = { __AGENTKIT_STUDIO__: { controlPlane: 'agentengine-server' } }) {
  const slots = [], effects = [];
  let cursor = 0, dirty = true, tree, props = initialProps;
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }];
  };
  const useRef = initial => useState(() => ({ current: initial }))[0];
  const useEffect = (effect, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      slots[index] = { deps, cleanup: previous?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
    }
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const calls = [], rows = [];
  const api = { deployments: async () => ({ items: rows }), prepareDeployment: async request => { calls.push(['prepare', request]); return preview(request); },
    createDeployment: async (...args) => { calls.push(['create', ...args]); return { id: 'created', agentId: 'a', state: 'CREATING' }; },
    agents: async () => ({ items: [] }), operations: async () => ({ items: [] }), agent: async () => ({ builds: [] }) };
  const names = ['Menu', 'MenuItemButton', 'Pill', 'StudioPageTabs', 'SectionHeading', 'EmptyState'];
  const Component = createDeliveryPages({
    ui: { React: { createElement: h, useState, useEffect, useRef, Fragment: 'fragment' }, BRAND: {}, RUNTIME_LABELS: {}, buttonStyle: () => ({}), inputStyle: () => ({}), ...Object.fromEntries(names.map(name => [name, name])) },
    hostRemote: api, actions: { confirm: async () => true, bindAgent: value => calls.push(['bind', value]) }, window, setInterval: () => 1, clearInterval: () => {},
  })[name];
  const render = () => { cursor = 0; dirty = false; tree = Component(props); for (const effect of effects.splice(0)) effect(); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk), ...walk(node.props.action), ...walk(node.props.anchor)] : [];
  const nodes = () => { if (dirty) render(); return walk(tree); };
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  const menuItem = label => nodes().find(node => node.type === 'MenuItemButton' && text(node) === label);
  const field = label => nodes().find(node => node.props['aria-label'] === label);
  const settle = async () => { for (let i = 0; i < 30; i++) { if (dirty) render(); await Promise.resolve(); } };
  return { api, calls, rows, nodes, text, button, menuItem, field, settle, props: async value => { props = value; dirty = true; await settle(); } };
}

test('Delivery hydrates the preferred Agent, consumes focus and scrolls the requested section after loading', async () => {
  const focus = { tab: 'delivery', agentId: 'b', section: 'deploy' };
  let stored = JSON.stringify(focus), scrolled = 0;
  const window = { localStorage: { getItem: () => stored, removeItem: () => { stored = null; } } };
  const ui = harness('DeliveryPage', { focus }, window);
  ui.api.agents = async () => ({ items: [{ metadata: { id: 'a' } }, { metadata: { id: 'b' } }] });
  const hydrated = [], selectors = [], classes = new Set();
  ui.api.agent = async id => { hydrated.push(id); return { metadata: { id }, builds: [] }; };
  ui.nodes().find(node => node.props['data-studio-delivery']).props.ref.current = { querySelector: selector => { selectors.push(selector); return { scrollIntoView: () => { scrolled++; }, classList: { add: value => classes.add(value), remove: value => classes.delete(value) } }; } };
  await ui.settle();
  assert.equal(ui.field('目标 Agent').props.value, 'b');
  assert.deepEqual(hydrated, ['b']);
  assert.equal(stored, null);
  assert.equal(scrolled, 1);
  assert.deepEqual(selectors, ['[data-delivery-section="deploy"]']);
  assert.ok(classes.has('studio-focus-highlight'));
  await ui.props({ focus: { tab: 'delivery', agentId: 'a', section: 'build' } });
  assert.equal(ui.field('目标 Agent').props.value, 'a');
  assert.deepEqual(hydrated, ['b', 'a']);
  assert.equal(selectors.at(-1), '[data-delivery-section="build"]');
});

test('Delivery handles an empty preferred catalog and retains focus when loading fails', async () => {
  const focus = { tab: 'delivery', agentId: 'missing', section: 'build' };
  let stored = JSON.stringify(focus);
  const window = { localStorage: { getItem: () => stored, removeItem: () => { stored = null; } } };
  const ui = harness('DeliveryPage', { focus }, window);
  await ui.settle();
  assert.equal(ui.field('目标 Agent').props.value, '');
  assert.equal(stored, null);
  stored = JSON.stringify(focus);
  ui.api.agents = async () => { throw Error('catalog offline'); };
  await ui.props({ focus: { ...focus } });
  assert.notEqual(stored, null);
  assert.ok(ui.nodes().some(node => node.props.title === '交付状态不可用' && node.props.detail === 'catalog offline'));
});

test('paired specifications default to 2 cores / 4 GB and checking never submits a create', async () => {
  const ui = harness(); await ui.settle();
  assert.equal(ui.field('实例规格').props.value, '2:2');
  ui.field('实例规格').props.onChange({ target: { value: '1:2' } }); await ui.settle();
  await ui.button('检查部署').props.onClick(); await ui.settle();
  assert.deepEqual(ui.calls[0][1].resources, { cpu: 1, memoryGiB: 2, storageGiB: 20 });
  assert.equal(ui.calls.some(([kind]) => kind === 'create'), false);
  assert.ok(ui.button('确认创建云端实例'));
  ui.field('实例规格').props.onChange({ target: { value: '2:2' } }); await ui.settle();
  assert.equal(ui.button('确认创建云端实例'), undefined, 'changed configuration needs a fresh check');
});

test('delivery groups settings into panels without repeating the active tab heading', async () => {
  const ui = harness('DeliveryPage', {}); await ui.settle();
  assert.equal(ui.nodes().some(node => node.type === 'SectionHeading' && node.props.title === '构建与部署'), false);
  assert.ok(ui.nodes().some(node => node.props.className === 'ad-panel studio-panel'));
  assert.equal(ui.button('构建当前版本').props['data-variant'], 'primary');
  assert.ok(ui.button('构建当前版本').props.className.includes('ad-build-primary'));
  assert.equal(ui.button('构建当前版本').props.disabled, true);
});

test('deployments always use the default persistent volume and never offer a storage choice', async () => {
  const ui = harness(); await ui.settle();
  assert.equal(ui.field('对话存储'), undefined, 'storage is stated, not selected');
  const content = ui.nodes().map(ui.text).join(' ');
  assert.match(content, /20 GiB 持久化云盘/);
  assert.match(content, /挂载 \/home\/node/);
  await ui.button('检查部署').props.onClick(); await ui.settle();
  assert.deepEqual(ui.calls[0][1].resources, { cpu: 2, memoryGiB: 4, storageGiB: 20 });
  assert.equal(ui.calls.some(([kind]) => kind === 'create'), false);
});

test('a late deployment check cannot confirm an obsolete build', async () => {
  const ui = harness(); await ui.settle();
  const pending = deferred(); ui.api.prepareDeployment = () => pending.promise;
  const checking = ui.button('检查部署').props.onClick(); await ui.settle();
  await ui.props({ agentId: 'a', selectedBuild: 'new-build' });
  pending.resolve(preview({ agentId: 'a', buildId: 'old-build', resources: { cpu: 2, memoryGiB: 4 } }));
  await checking; await ui.settle();
  assert.equal(ui.button('确认创建云端实例'), undefined);
});

test('a ready deployment defaults the primary delivery action to updating that instance', async () => {
  const ui = harness();
  ui.rows.push({ id: 'live', agentId: 'a', agentName: 'Existing instance', state: 'READY', cloudAgentId: 'ar-existing', buildId: 'old-build' });
  ui.api.prepareDeploymentUpdate = async request => { ui.calls.push(['update-check', request]); return { ...preview({ agentId: 'a', buildId: 'build-a', resources: {} }), deploymentId: request.deploymentId }; };
  await ui.settle();
  assert.equal(ui.field('部署目标').props.value, 'live');
  await ui.button('检查更新').props.onClick(); await ui.settle();
  assert.deepEqual(ui.calls[0], ['update-check', { deploymentId: 'live', buildId: 'build-a', useRecommendedImage: true }]);
  assert.equal(ui.button('确认创建云端实例'), undefined);
  assert.ok(ui.button('确认升级当前实例'));
});

test('records default to the selected Agent, hide deleted history and keep other unresolved creates discoverable', async () => {
  const ui = harness();
  ui.rows.push({ id: 'a-live', agentId: 'a', agentName: 'Current live', state: 'READY' },
    { id: 'a-deleted', agentId: 'a', agentName: 'Deleted history', state: 'DELETED' },
    { id: 'b-unknown', agentId: 'b', agentName: 'Other unknown', state: 'CREATE_UNKNOWN' });
  await ui.settle();
  let content = ui.nodes().map(ui.text).join(' ');
  assert.match(content, /Current live/); assert.doesNotMatch(content, /Deleted history|Other unknown/);
  assert.match(content, /其他 Agent 有 1 条部署需要处理/);
  ui.button('查看全部').props.onClick(); await ui.settle();
  assert.ok(ui.button('核对创建结果'));
  assert.equal(ui.button('确认创建云端实例'), undefined, 'unknown creation has no retry-create action');
  ui.nodes().find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await ui.settle();
  content = ui.nodes().map(ui.text).join(' '); assert.match(content, /Deleted history/);
});

test('deployment surfaces retain current and frozen target image identities with missing-value fallbacks', async () => {
  for (const populated of [true, false]) {
    const ui = harness();
    const imageVersion = populated ? 'runtime-current' : undefined;
    const imageDigest = populated ? 'sha256:current' : undefined;
    const image = populated ? { version: 'runtime-target', digest: 'sha256:target' } : {};
    ui.rows.push({ id: 'live', agentId: 'a', agentName: 'Existing instance', state: 'READY', cloudAgentId: 'ar-existing', imageVersion, imageDigest });
    ui.api.prepareDeploymentUpdate = async request => ({ ...preview({ resources: {} }), deploymentId: request.deploymentId, image });
    await ui.settle();
    assert.ok(ui.nodes().some(node => node.props.className === 'ad-record-meta' && ui.text(node).includes(`镜像 ${imageVersion || '—'}`)));
    ui.menuItem('详情').props.onSelect(); await ui.settle();
    assert.ok(ui.nodes().some(node => node.type === 'dd' && ui.text(node) === (populated ? 'runtime-current · sha256:current' : '—')));
    await ui.button('检查更新').props.onClick(); await ui.settle();
    const result = ui.text(ui.field('部署检查结果'));
    assert.ok(result.includes(`当前镜像 ${imageVersion || '—'}`));
    assert.ok(result.includes(`目标运行镜像${populated ? 'runtime-target · sha256:target' : '—'}`));
    assert.equal(ui.calls.some(([kind]) => kind === 'create'), false);
  }
});

test('deployment history pages newest first and details retain the cloud identity', async () => {
  const ui = harness();
  for (let i = 0; i < 7; i++) ui.rows.push({ id: `d-${i}`, agentId: 'a', agentName: `Record ${i}`, state: 'READY', cloudAgentId: `ar-cloud-${i}`, createdAt: `2026-10-0${i + 1}T00:00:00Z` });
  await ui.settle();
  let content = ui.nodes().filter(node => node.type === 'strong').map(ui.text).join(' ');
  assert.match(content, /Record 6/); assert.doesNotMatch(content, /Record 0/);
  ui.menuItem('详情').props.onSelect(); await ui.settle(); assert.match(ui.nodes().map(ui.text).join(' '), /ar-cloud-6/);
  ui.button('下一页').props.onClick(); await ui.settle();
  content = ui.nodes().filter(node => node.type === 'strong').map(ui.text).join(' '); assert.match(content, /Record 0/); assert.doesNotMatch(content, /Record 6/);
});

test('fast Agent changes retain the latest target builds even when the earlier response arrives last', async () => {
  const ui = harness('DeliveryPage', {});
  ui.api.agents = async () => ({ items: ['a', 'b', 'c'].map(id => ({ metadata: { id, name: id, local: true } })) });
  ui.api.agent = async id => ({ builds: [{ id: `${id}-build`, revision: 1, status: 'SUCCEEDED' }] });
  await ui.settle();
  const b = deferred(), c = deferred(); ui.api.agent = id => id === 'b' ? b.promise : c.promise;
  ui.field('目标 Agent').props.onChange({ target: { value: 'b' } }); await ui.settle();
  ui.field('目标 Agent').props.onChange({ target: { value: 'c' } }); await ui.settle();
  c.resolve({ builds: [{ id: 'c-build', revision: 3, status: 'SUCCEEDED' }] }); await ui.settle();
  b.resolve({ builds: [{ id: 'b-build', revision: 2, status: 'SUCCEEDED' }] }); await ui.settle();
  assert.equal(ui.field('目标 Agent').props.value, 'c');
  assert.equal(ui.field('构建版本').props.value, 'c-build');
});

test('subject and current-revision build show compact identity, completed step and outline rebuild', async () => {
  const ui = harness('DeliveryPage', {});
  ui.api.agents = async () => ({ items: [{ metadata: { id: 'a', name: 'Research', revision: 2, local: true }, spec: { runtime: { type: 'codex' } } }] });
  ui.api.agent = async () => ({ builds: [{ id: 'build-a', revision: 2, status: 'SUCCEEDED' }] });
  await ui.settle();
  assert.ok(ui.nodes().some(node => node.props.className === 'studio-row-id' && ui.text(node) === 'a'));
  assert.ok(ui.nodes().some(node => node.props.className === 'studio-row-meta' && ui.text(node) === 'codex · 当前配置 r2'));
  assert.ok(ui.field('目标 Agent').props.className.includes('ad-agent-picker'));
  assert.equal(ui.field('目标 Agent').props.value, 'a');
  assert.equal(ui.field('目标 Agent').props.disabled, false);
  assert.equal(ui.button('重新构建').props['data-variant'], 'outline');
  assert.equal(ui.nodes().find(node => node.props.className === 'ad-step-number').props['data-done'], true);
  const history = ui.nodes().find(node => node.type === 'details');
  assert.equal(Boolean(history.props.open), false);
  assert.match(ui.text(history), /构建历史 · 1 个版本/);
  assert.ok(ui.button('在新会话运行'));
  ui.button('在新会话运行').props.onClick();
  assert.deepEqual(ui.calls.at(-1), ['bind', { agentId: 'a', buildId: 'build-a' }]);
  assert.equal(ui.button('下载定义 ZIP'), undefined);
  assert.ok(ui.menuItem('下载定义 ZIP'));
  assert.ok(ui.menuItem('导出运行包'));
  const menu = ui.nodes().find(node => node.type === 'Menu');
  assert.equal(menu.props.open, false);
  ui.field('更多操作 build-a').props.onClick(); await ui.settle();
  assert.equal(ui.nodes().find(node => node.type === 'Menu').props.open, true);
  assert.equal(ui.nodes().find(node => node.type === 'Menu').props.align, 'end');
});

test('a stale revision keeps build primary while an unbuilt deployment stays dimmed with its original disabled controls', async () => {
  const page = harness('DeliveryPage', {});
  page.api.agents = async () => ({ items: [{ metadata: { id: 'a', revision: 3, local: true } }] });
  page.api.agent = async () => ({ builds: [{ id: 'old', revision: 1, status: 'SUCCEEDED' }] });
  await page.settle();
  assert.equal(page.button('构建当前版本').props['data-variant'], 'primary');
  assert.equal(page.nodes().find(node => node.type?.name === 'CloudDeploymentPanel').props.hasCurrentBuild, false);
  const cloud = harness('CloudDeploymentPanel', { agentId: 'a', selectedBuild: '' });
  await cloud.settle();
  const deploy = cloud.nodes().find(node => node.props['data-delivery-section'] === 'deploy');
  assert.match(deploy.props.className, /ad-step-dimmed/);
  assert.match(cloud.text(deploy), /构建成功后可以部署/);
  assert.equal(cloud.button('检查部署').props.disabled, true);
  assert.equal(cloud.button('检查部署').props['data-variant'], 'outline');
  assert.equal(cloud.field('部署目标').props.disabled, false);
  assert.equal(cloud.field('实例规格').props.disabled, false);
});

test('deployment steps keep checks, warnings, records actions and two-stage deletion behind an overflow menu', async () => {
  const ui = harness();
  const record = { id: 'live', agentId: 'a', agentName: 'Current', state: 'READY', cloudAgentId: 'cloud-a', buildId: 'old', resources: { cpu: 2, memoryGiB: 4 } };
  ui.rows.push(record);
  ui.api.deploymentLogs = async id => { ui.calls.push(['logs', id]); return { lines: ['running'] }; };
  ui.api.removeDeployment = async id => { ui.calls.push(['remove', id]); return { ...record, state: 'DELETED' }; };
  await ui.settle();
  assert.equal(ui.button('检查更新').props['data-variant'], 'outline');
  assert.ok(ui.nodes().some(node => node.type === 'table' && node.props.className.includes('studio-tbl')));
  assert.ok(ui.nodes().some(node => node.type === 'StudioPageTabs' && node.props.value === 'current' && node.props.ariaLabel === '部署记录范围'));
  assert.ok(ui.button('开始对话'));
  assert.ok(ui.button('刷新状态'));
  assert.equal(ui.button('日志'), undefined);
  await ui.menuItem('日志').props.onSelect(); await ui.settle();
  assert.deepEqual(ui.calls.at(-1), ['logs', 'live']);
  assert.match(ui.nodes().map(ui.text).join(' '), /running/);
  ui.menuItem('详情').props.onSelect(); await ui.settle();
  await ui.menuItem('删除').props.onSelect(); await ui.settle();
  assert.equal(ui.calls.some(([name]) => name === 'remove'), false);
  await ui.menuItem('确认删除云端实例').props.onSelect(); await ui.settle();
  assert.deepEqual(ui.calls.at(-1), ['remove', 'live']);

  const checked = harness();
  checked.api.prepareDeployment = async request => ({ ...preview(request), warnings: ['配额提醒'] });
  await checked.settle();
  assert.equal(checked.button('检查部署').props['data-variant'], 'primary');
  await checked.button('检查部署').props.onClick(); await checked.settle();
  const result = checked.field('部署检查结果');
  assert.match(checked.text(result), /检查通过/);
  assert.match(checked.text(result), /冻结版本.*资源凭证.*部署位置与配额/);
  assert.match(checked.text(result), /配额提醒/);
  assert.equal(checked.button('检查部署').props['data-variant'], 'outline');
  assert.equal(checked.button('确认创建云端实例').props['data-variant'], 'primary');
  checked.button('取消').props.onClick(); await checked.settle();
  assert.equal(checked.field('部署检查结果'), undefined);
});

test('deployment failure remains a one-line alert without changing retry availability', async () => {
  const ui = harness();
  ui.api.prepareDeployment = async () => { throw Error('quota unavailable'); };
  await ui.settle();
  await ui.button('检查部署').props.onClick(); await ui.settle();
  assert.ok(ui.nodes().some(node => node.props.role === 'alert' && node.props.title === 'quota unavailable'));
  assert.equal(ui.button('检查部署').props.disabled, false);
  assert.equal(ui.field('部署检查结果'), undefined);
});
