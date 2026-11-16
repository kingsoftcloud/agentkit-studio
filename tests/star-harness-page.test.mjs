import assert from 'node:assert/strict';
import test from 'node:test';
import { createStarHarnessPage, STAR_HARNESS_CHANGED } from '../src/client/pages/star-harness.mjs';

function render(status, hostRemote, events = []) {
  const states = [status];
  const page = createStarHarnessPage({
    ui: { React: {
      createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity) }),
      useState: initial => [states.length ? states.shift() : initial, () => {}],
      useEffect() {},
      useRef: current => ({ current }),
    }, BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}) },
    hostRemote, window: { Event, dispatchEvent: event => events.push(event.type) },
  });
  return page({ view: 'page' });
}

function descendants(node) {
  return node?.children ? [node, ...node.children.flatMap(descendants)] : [];
}

const state = { version: '0.0.24', availableUpgrade: '0.0.25', enabled: false,
  models: [], workspaces: [{ workspace: '/tmp/previous-workspace', missing: true }] };

test('the Star Harness card applies an upgrade once and marks stale bindings', async () => {
  const installed = Promise.withResolvers();
  const requests = [], events = [];
  const view = render(state, {
    installStarHarness(version) { requests.push(version); return installed.promise; },
  }, events);
  const elements = descendants(view);
  const upgrade = elements.find(node => node.type === 'button' && node.children.includes('升级'));
  const enable = elements.find(node => node.type === 'button' && node.children.includes('启用'));
  assert.equal(enable.props.disabled, true);
  assert.ok(elements.some(node => node.type === 'p' && node.children.some(child => typeof child === 'string' && child.includes('目录已失效'))));
  const pending = upgrade.props.onClick();
  await upgrade.props.onClick();
  assert.deepEqual(requests, ['0.0.25']);
  installed.resolve({ ...state, version: '0.0.25' });
  await pending;
  assert.deepEqual(events, [STAR_HARNESS_CHANGED]);
});
