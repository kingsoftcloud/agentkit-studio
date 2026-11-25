import assert from 'node:assert/strict';
import test from 'node:test';
import { createStarHarnessPage, STAR_HARNESS_CHANGED } from '../src/client/pages/star-harness.mjs';

function render(status, hostRemote, events = [], view = 'page') {
  const states = [status];
  const page = createStarHarnessPage({
    ui: { React: {
      createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
      useState: initial => [states.length ? states.shift() : initial, () => {}],
      useEffect() {},
      useRef: current => ({ current }),
    }, MarkdownText: 'native-markdown', BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}) },
    Switch: 'native-switch', hostRemote, window: { Event, dispatchEvent: event => events.push(event.type) },
  });
  return page({ view });
}

function descendants(node) {
  return node?.children ? [node, ...node.children.flatMap(descendants)] : [];
}

const state = { version: '0.0.24', availableUpgrade: '0.0.25', enabled: false,
  models: [], workspaces: [{ workspace: '/tmp/external-workspace', external: true, running: true }] };

test('the Star Harness card applies an upgrade once and explains automatic workspace selection', async () => {
  const installed = Promise.withResolvers();
  const requests = [], events = [];
  const view = render({ ...state, releaseVersions: [{ version: '0.0.25', action: 'upgrade' }] }, {
    installStarHarness(version) { requests.push(version); return installed.promise; },
  }, events);
  const elements = descendants(view);
  assert.doesNotMatch(JSON.stringify(view), /external-workspace/);
  const upgrade = elements.find(node => node.type === 'button' && node.children.includes('升级到 0.0.25'));
  assert.match(elements.find(node => node.type === 'native-markdown').props.text, /会话在 Studio 中选择的工作区/);
  const pending = upgrade.props.onClick();
  await upgrade.props.onClick();
  assert.deepEqual(requests, ['0.0.25']);
  installed.resolve({ ...state, version: '0.0.25' });
  await pending;
  assert.deepEqual(events, [STAR_HARNESS_CHANGED]);
});

test('the Star Harness details show components and allow rollback to the locally available version while offline', async () => {
  const requests = [];
  const status = { ...state, previousVersion: '0.0.23', rollbackVersion: '0.0.23', registryUnavailable: true,
    releaseVersions: [{ version: '0.0.22', action: 'history', publishedAt: '2026-11-20T10:02:13.000Z' }] };
  const elements = descendants(render(status, { async installStarHarness(version) { requests.push(version); return status; } }));
  const buttons = elements.filter(node => node.type === 'button');
  assert.ok(elements.some(node => node.children.includes('包含的组件')));
  assert.equal(elements.filter(node => node.type === 'code').length, 3);
  assert.ok(elements.some(node => node.type === 'time' && node.props.dateTime === '2026-11-20T10:02:13.000Z'));
  assert.ok(!buttons.some(node => node.children.some(label => label.includes('0.0.22'))));
  await buttons.find(node => node.children.includes('回退到 0.0.23')).props.onClick();
  assert.deepEqual(requests, ['0.0.23']);
  const busy = descendants(render({ ...status, busy: true }, {}));
  assert.equal(busy.find(node => node.children.includes('回退到 0.0.23')).props.disabled, true);
});


test('the Star Harness summary toggles activation without a workspace binding', async () => {
  const updates = [], events = [];
  const view = render(state, {
    async enableStarHarness(enabled) {
      updates.push(enabled);
      return { ...state, enabled };
    },
  }, events, 'summary');
  const toggle = descendants(view).find(node => node.type === 'native-switch');
  assert.equal(toggle.props.checked, false);
  assert.equal(toggle.props.disabled, false);
  await toggle.props.onChange(true);
  assert.deepEqual(updates, [true]);
  assert.deepEqual(events, [STAR_HARNESS_CHANGED]);
});
