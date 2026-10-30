import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudPermissionPresentation, selectCloudPermissionPresentation } from '../src/client/dsh/cloud-permission.mjs';
import { UNATTENDED_EXECUTION_POLICY as policy } from '../src/execution-policy.mjs';

const preset = id => `agentkit-studio-agent-${id}-r1-version`;
const target = id => selectCloudPermissionPresentation({ agentPreset: preset(id) });
function fixture() {
  const state = [], effects = [], pending = [], listeners = new Map(), calls = [];
  let stateAt = 0, effectAt = 0;
  const Component = createCloudPermissionPresentation({ ui: { buttonStyle: () => ({}), React: {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => { const i = stateAt++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
    useEffect: (run, deps) => { const i = effectAt++, previous = effects[i]; if (previous && deps.every((value, j) => value === previous.deps[j])) return;
      pending.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: run() }; }); },
  } }, window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
  hostRemote: { agentExecutionPolicy: id => { const result = Promise.withResolvers(); calls.push({ id, ...result }); return result.promise; } } });
  return { calls, listeners, render: matched => { stateAt = 0; effectAt = 0; const node = Component({ matched }); pending.splice(0).forEach(run => run()); return node; },
    close: () => effects.forEach(effect => effect.cleanup?.()) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('only cloud preset presentation is elected; native and local Agent controls fall through', () => {
  for (const agentPreset of [undefined, '', 'official-preset', preset('ar-local-test')]) assert.equal(selectCloudPermissionPresentation({ agentPreset }), null);
  assert.deepEqual(target('ar-20261019105049-0f164abe'), { agentId: 'ar-20261019105049-0f164abe', agentPreset: preset('ar-20261019105049-0f164abe') });
});

test('missing, failed or future policy stays unknown and never displays local full access', async () => {
  const f = fixture(), a = target('ar-owned');
  assert.equal(f.render(a).children[0], '正在核验云端权限');
  f.calls[0].resolve({ agentId: 'ar-owned' }); await settle();
  let view = f.render(a); assert.equal(view.children[0], '云端权限未知');
  assert.match(view.props.title, /本机权限设置不会改变云端权限/);
  view.props.onClick(); f.render(a); f.calls[1].resolve({ agentId: 'ar-owned', executionPolicy: { ...policy, format: 'future' } }); await settle();
  assert.equal(f.render(a).children[0], '云端权限未知');
  f.render(a).props.onClick(); f.render(a); f.calls[2].reject(new Error('offline')); await settle();
  assert.equal(f.render(a).children[0], '云端权限未知'); f.close();
});

test('a verified receipt displays cloud policy and stale responses cannot cross a session or connection', async () => {
  const f = fixture(), a = target('ar-first'), b = target('ar-second');
  f.render(a); f.render(b);
  f.calls[0].resolve({ agentId: 'ar-first', executionPolicy: policy }); await settle();
  assert.equal(f.render(b).children[0], '正在核验云端权限');
  f.calls[1].resolve({ agentId: 'ar-second', executionPolicy: policy }); await settle();
  assert.equal(f.render(b).children[0], '云端 · 只读');
  f.listeners.get('agentkit-studio:connection-reset')();
  assert.equal(f.render(b).children[0], '正在核验云端权限');
  f.calls[2].resolve({ agentId: 'different-agent', executionPolicy: policy }); await settle();
  assert.equal(f.render(b).children[0], '云端权限未知');
  f.render(b).props.onClick(); f.render(b); f.close();
  f.calls[3].resolve({ agentId: 'ar-second', executionPolicy: policy }); await settle();
  assert.equal(f.listeners.size, 0); assert.equal(f.render(b).children[0], '正在核验云端权限');
});

function dropdownFixture() {
  const Menu = (props, ...children) => ({ type: 'Menu', props, children });
  const MenuItemButton = (props, ...children) => ({ type: 'MenuItemButton', props, children });
  const state = [], effects = [], pending = [], listeners = new Map(), reads = [], writes = [];
  let stateAt = 0, effectAt = 0;
  const Component = createCloudPermissionPresentation({ ui: {
    buttonStyle: () => ({}), BRAND: {},
    React: {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: initial => { const i = stateAt++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
      useEffect: (run, deps) => { const i = effectAt++, previous = effects[i]; if (previous && deps.every((value, j) => value === previous.deps[j])) return;
        pending.push(() => { previous?.cleanup?.(); effects[i] = { deps, cleanup: run() }; }); },
    },
    Menu, MenuItemButton,
    IconChevronDownOutlineRegular: props => ({ type: 'Icon', props }),
  }, window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
  hostRemote: {
    agentExecutionPolicy: id => { const result = Promise.withResolvers(); reads.push({ id, ...result }); return result.promise; },
    setAgentExecutionMode: (id, mode) => { const result = Promise.withResolvers(); writes.push({ id, mode, ...result }); return result.promise; },
  } });
  return { reads, writes, listeners, Menu, MenuItemButton, render: matched => { stateAt = 0; effectAt = 0; const node = Component({ matched }); pending.splice(0).forEach(run => run()); return node; },
    close: () => effects.forEach(effect => effect.cleanup?.()) };
}

test('a switching cloud image presents the Local picker modes and persists the chosen mode', async () => {
  const f = dropdownFixture(), a = target('ar-owned'), modes = ['read-only', 'workspace-write', 'danger-full-access'];
  assert.equal(f.render(a).type, 'button');
  f.reads[0].resolve({ agentId: 'ar-owned', executionPolicy: { ...policy, permissionMode: 'workspace-write' }, allowedPermissionModes: modes, executionModeSwitching: true, selectedPermissionMode: null });
  await settle();
  let view = f.render(a);
  assert.equal(view.type, 'span');
  const menu = view.children[0];
  assert.equal(menu.type, f.Menu); assert.equal(menu.props.anchor.props.disabled, false);
  assert.equal(menu.props.anchor.children[0].children[0], '云端 · 工作区内修改');
  menu.props.anchor.props.onClick();
  assert.equal(f.render(a).children[0].props.open, true);
  const items = f.render(a).children[0].children.filter(child => child?.type === f.MenuItemButton);
  assert.deepEqual(items.map(item => item.props.key), modes);
  items[2].props.onSelect();
  assert.equal(f.writes[0].id, 'ar-owned'); assert.equal(f.writes[0].mode, 'danger-full-access');
  assert.equal(f.render(a).children[0].props.anchor.children[0].children[0], '正在切换…');
  f.writes[0].resolve({ agentId: 'ar-owned', selectedPermissionMode: 'danger-full-access', allowedPermissionModes: modes, executionPolicy: policy });
  await settle();
  view = f.render(a);
  assert.equal(view.children[0].props.anchor.children[0].children[0], '云端 · 完全权限');
  assert.equal(view.children[0].props.open, false);
  assert.equal(f.render(a).children.some(child => child?.type === f.MenuItemButton), false, 'closed Menu renders no items');
  f.close();
});

test('a clamped or failed switch never claims the broader mode', async () => {
  const f = dropdownFixture(), a = target('ar-owned'), modes = ['read-only', 'workspace-write'];
  f.render(a); f.reads[0].resolve({ agentId: 'ar-owned', executionPolicy: { ...policy, permissionMode: 'workspace-write' }, allowedPermissionModes: modes, executionModeSwitching: true, selectedPermissionMode: 'workspace-write' });
  await settle();
  const items = f.render(a).children[0].children.filter(child => child?.type === f.MenuItemButton);
  items[0].props.onSelect();
  f.writes[0].resolve({ agentId: 'ar-owned', selectedPermissionMode: 'read-only', allowedPermissionModes: modes });
  await settle();
  let view = f.render(a);
  assert.equal(view.children[0].props.anchor.children[0].children[0], '云端 · 仅可查看');
  f.render(a).children[0].children.filter(child => child?.type === f.MenuItemButton)[1].props.onSelect();
  f.writes[1].reject(new Error('云端执行权限切换失败'));
  await settle();
  view = f.render(a);
  assert.equal(view.children[0].props.anchor.children[0].children[0], '云端 · 仅可查看');
  assert.equal(view.children.at(-1).children[0], '云端执行权限切换失败');
  f.close();
});
