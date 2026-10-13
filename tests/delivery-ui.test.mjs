import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const cloudSource = await readFile(new URL('../src/client-fragments/05-cloud-deployments.js', import.meta.url), 'utf8');
const workspace = await readFile(new URL('../src/client-fragments/05-resource-workspaces.js', import.meta.url), 'utf8');
const source = cloudSource + workspace.slice(workspace.indexOf('    function DeliveryPage()'));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const preview = request => ({ ...request, agentName: 'Selected Agent', revision: 1, environment: 'pre-online', region: 'test-region',
  runtime: 'harness', image: { version: 'test' }, resourceCounts: { models: 1, mcps: 0, skills: 0, remote: 0 }, identity: { kind: 'subaccount', userName: 'operator' }, warnings: [] });

function harness(name = 'CloudDeploymentPanel', initialProps = { agentId: 'a', selectedBuild: 'build-a' }) {
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
  const names = ['Pill', 'StudioPageTabs', 'SectionHeading', 'EmptyState'];
  const Component = new Function('useState', 'useEffect', 'useRef', 'h', 'hostRemote', 'BRAND', 'React', 'buttonStyle', 'inputStyle', 'window', 'setInterval', 'clearInterval', 'RUNTIME_LABELS', ...names, `${source}; return ${name};`)
    (useState, useEffect, useRef, h, api, {}, { Fragment: 'fragment' }, () => ({}), () => ({}), { __AGENTKIT_STUDIO__: { controlPlane: 'agentengine-server' } }, () => 1, () => {}, {}, ...names);
  const render = () => { cursor = 0; dirty = false; tree = Component(props); for (const effect of effects.splice(0)) effect(); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk), ...walk(node.props.action)] : [];
  const nodes = () => { if (dirty) render(); return walk(tree); };
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  const field = label => nodes().find(node => node.props['aria-label'] === label);
  const settle = async () => { for (let i = 0; i < 30; i++) { if (dirty) render(); await Promise.resolve(); } };
  return { api, calls, rows, nodes, text, button, field, settle, props: async value => { props = value; dirty = true; await settle(); } };
}

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

test('deployment history pages newest first and details retain the cloud identity', async () => {
  const ui = harness();
  for (let i = 0; i < 7; i++) ui.rows.push({ id: `d-${i}`, agentId: 'a', agentName: `Record ${i}`, state: 'READY', cloudAgentId: `ar-cloud-${i}`, createdAt: `2026-10-0${i + 1}T00:00:00Z` });
  await ui.settle();
  let content = ui.nodes().filter(node => node.type === 'strong').map(ui.text).join(' ');
  assert.match(content, /Record 6/); assert.doesNotMatch(content, /Record 0/);
  ui.button('详情').props.onClick(); await ui.settle(); assert.match(ui.nodes().map(ui.text).join(' '), /ar-cloud-6/);
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
