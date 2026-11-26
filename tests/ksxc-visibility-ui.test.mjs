import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentForm } from '../src/client/pages/agent-form.mjs';
import { createRuntimeCatalogPage } from '../src/client/pages/runtime-catalog.mjs';
import { KSXC_CHANGED } from '../src/client/pages/ksxc-settings.mjs';

const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function hookHarness() {
  const states = [], effects = [], refs = [];
  let stateCursor = 0, effectCursor = 0, refCursor = 0;
  const React = {
    createElement: h,
    Fragment: 'fragment',
    useState(initial) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(fn, deps) {
      const index = effectCursor++;
      const previous = effects[index];
      const changed = !previous || !deps || deps.some((value, position) => !Object.is(value, previous.deps[position]));
      if (changed) {
        previous?.cleanup?.();
        effects[index] = { deps: deps ? [...deps] : undefined, cleanup: fn() };
      }
    },
    useRef(initial) {
      const index = refCursor++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
  };
  return { React, begin() { stateCursor = 0; effectCursor = 0; refCursor = 0; } };
}

function formHarness(status, props = {}) {
  const hooks = hookHarness();
  const listeners = new Set();
  let currentStatus = status;
  const window = {
    addEventListener(type, listener) { if (type === KSXC_CHANGED) listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
  };
  const hostRemote = {
    ksxcStatus: async () => currentStatus,
    ksxcModels: async () => {
      if (!currentStatus.gateway.reachable) throw new Error('gateway offline');
      return { items: [{ resourceId: 'model-ksxc', displayName: 'KSXC model' }], defaultModel: 'model-ksxc' };
    },
    resources: async kind => ({ items: kind === 'model' ? [{ resourceId: 'model-native' }] : [] }),
  };
  const Form = createAgentForm({ ui: { React: hooks.React, BRAND: {}, ALLOWED_RUNTIME_TYPES: ['dsh-native', 'ksxc'],
    RUNTIME_LABELS: { ksxc: 'KSXC' }, buttonStyle: () => ({}), inputStyle: () => ({}), SectionHeading: 'heading', PlatformResourcePicker: 'platform' }, hostRemote, window });
  return {
    render() { hooks.begin(); return walk(Form(props)); },
    changeGateway(next) { currentStatus = next; assert.ok(listeners.size, 'the form subscribes to reachability changes'); listeners.forEach(listener => listener()); },
    flush,
  };
}

const unavailable = { supported: true, release: { ready: true }, gateway: { reachable: false } };
const available = { supported: true, release: { ready: true }, gateway: { reachable: true } };

test('new Agent creation hides KSXC until the model gateway is reachable', async () => {
  for (const [status, expected] of [[unavailable, false], [available, true]]) {
    const form = formHarness(status);
    assert.equal(form.render().some(node => node.props['data-runtime'] === 'ksxc'), false, 'unknown starts hidden');
    await form.flush();
    const radio = form.render().find(node => node.props['data-runtime'] === 'ksxc');
    assert.equal(Boolean(radio), expected);
    if (radio) assert.equal(radio.props.disabled, false);
  }
});

test('editing an existing KSXC Agent keeps its runtime and explains an unreachable gateway', async () => {
  const form = formHarness(unavailable, { initialAgent: {
    source: 'local-studio', metadata: { id: 'ksxc-agent', name: 'KSXC Agent', revision: 2 },
    spec: { runtime: { type: 'ksxc' }, bindings: { modelProfileId: 'model-ksxc', modelProfileIds: ['model-ksxc'], plugins: [] } },
  } });
  form.render(); await form.flush();
  const nodes = form.render();
  const radio = nodes.find(node => node.props['data-runtime'] === 'ksxc');
  assert.equal(radio.props['aria-checked'], true);
  assert.match(JSON.stringify(nodes), /当前无法连接 KSXC 模型网关/);
  nodes.find(node => node.props.className === 'af-step' && node.children.includes('绑定能力')).props.onClick();
  let model = form.render().find(node => node.type === 'select' && node.props['aria-label'] === '默认模型');
  assert.equal(model.props.value, 'model-ksxc', 'a failed catalog read preserves the existing binding');
  assert.match(JSON.stringify(model.children), /当前绑定，目录暂不可用/);

  form.changeGateway(available); form.render(); await form.flush();
  const recovered = form.render();
  model = recovered.find(node => node.type === 'select' && node.props['aria-label'] === '默认模型');
  assert.equal(model.props.value, 'model-ksxc', 'recovery keeps the original selection');
  assert.doesNotMatch(JSON.stringify(recovered), /当前无法连接 KSXC 模型网关/);
  assert.equal(recovered.find(node => node.type === 'button' && node.children.includes('下一步')).props.disabled, false);
});

test('a KSXC creation seed does not silently switch to another runtime offline', async () => {
  const form = formHarness(unavailable, { creationSeed: {
    name: 'Internal template', spec: { runtime: { type: 'ksxc' }, bindings: { modelProfileId: 'model-ksxc' } },
  } });
  form.render(); await form.flush();
  const nodes = form.render();
  assert.equal(nodes.some(node => node.props['data-runtime'] === 'ksxc'), false);
  assert.equal(nodes.find(node => node.props['data-runtime'] === 'dsh-native').props['aria-checked'], false);
  assert.match(JSON.stringify(nodes), /可以选择模板允许的其他运行时/);
});

test('losing the gateway after a manual KSXC selection preserves the choice and shows a warning', async () => {
  const form = formHarness(available);
  form.render(); await form.flush();
  form.render().find(node => node.props['data-runtime'] === 'ksxc').props.onClick();
  assert.equal(form.render().find(node => node.props['data-runtime'] === 'ksxc').props['aria-checked'], true);
  form.changeGateway(unavailable); form.render(); await form.flush();
  const nodes = form.render();
  assert.equal(nodes.some(node => node.props['data-runtime'] === 'ksxc'), false);
  assert.equal(nodes.find(node => node.props['data-runtime'] === 'dsh-native').props['aria-checked'], false);
  assert.match(JSON.stringify(nodes), /已保留你的 KSXC 选择/);
});

test('a KSXC-only creation seed explains why it cannot be created offline', async () => {
  const form = formHarness(unavailable, { creationSeed: {
    name: 'KSXC only', runtimes: ['ksxc'],
    spec: { runtime: { type: 'ksxc' }, bindings: { modelProfileId: 'model-ksxc' } },
  } });
  form.render(); await form.flush();
  const nodes = form.render();
  assert.equal(nodes.some(node => node.props.role === 'radio'), false);
  assert.match(JSON.stringify(nodes), /当前无法连接 KSXC 模型网关/);
  assert.equal(nodes.find(node => node.type === 'button' && node.children.includes('下一步')).props.disabled, true);
});

async function runtimeRows(status) {
  const hooks = hookHarness();
  const window = { addEventListener() {}, removeEventListener() {} };
  const Page = createRuntimeCatalogPage({ ui: { React: hooks.React, BRAND: {}, buttonStyle: () => ({}),
    ALLOWED_RUNTIME_TYPES: ['dsh-native', 'ksxc'], RUNTIME_LABELS: {}, SectionHeading: 'heading', EmptyState: 'empty' },
  hostRemote: { runtimes: async () => ({ items: [] }), dshPlugins: async () => ({ items: [] }), ksxcStatus: async () => status }, window });
  hooks.begin(); Page({});
  await flush();
  hooks.begin();
  return walk(Page({})).filter(node => node.props.className === 'studio-row studio-runtime-row');
}

test('runtime catalog follows the same gateway visibility rule', async () => {
  assert.equal((await runtimeRows(unavailable)).length, 0);
  const rows = await runtimeRows(available);
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(rows[0]), /ksxc/);
});

test('runtime catalog ignores an older reachable response after a newer offline refresh', async () => {
  const hooks = hookHarness(), listeners = new Set();
  let current = available, resolveFirst, runtimeCalls = 0;
  const window = {
    addEventListener(type, listener) { if (type === KSXC_CHANGED) listeners.add(listener); },
    removeEventListener(type, listener) { listeners.delete(listener); },
  };
  const Page = createRuntimeCatalogPage({ ui: { React: hooks.React, BRAND: {}, buttonStyle: () => ({}),
    ALLOWED_RUNTIME_TYPES: ['dsh-native', 'ksxc'], RUNTIME_LABELS: {}, SectionHeading: 'heading', EmptyState: 'empty' },
  hostRemote: {
    runtimes: () => ++runtimeCalls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ items: [] }),
    dshPlugins: async () => ({ items: [] }), ksxcStatus: async () => current,
  }, window });
  hooks.begin(); Page({});
  current = unavailable;
  listeners.forEach(listener => listener());
  await flush();
  hooks.begin();
  assert.equal(walk(Page({})).some(node => node.props['data-runtime'] === 'ksxc' || node.props.className === 'studio-row studio-runtime-row'), false);
  resolveFirst({ items: [] });
  await flush();
  hooks.begin();
  assert.equal(walk(Page({})).some(node => node.props.className === 'studio-row studio-runtime-row'), false, 'the stale response cannot restore KSXC');
});
