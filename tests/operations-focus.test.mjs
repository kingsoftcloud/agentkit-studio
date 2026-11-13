import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONS_FOCUS_KEY, readOperationsFocus, focusOperations, consumeOperationsFocus } from '../src/client/operations-focus.mjs';
import { createOperationsWorkspace } from '../src/client/pages/operations.mjs';

function browser() {
  const values = new Map(), events = [];
  return { events, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }, dispatchEvent: event => events.push(event) };
}

test('Operations focus writes storage, dispatches the focus, then navigates', () => {
  const window = browser(), routes = [];
  focusOperations({ window, agentId: 'built-agent', section: 'deploy', onNavigate: route => { assert.equal(window.events.length, 1); routes.push(route); } });
  const focus = { tab: 'delivery', agentId: 'built-agent', section: 'deploy' };
  assert.deepEqual(readOperationsFocus(window), focus);
  assert.equal(window.events[0].type, OPERATIONS_FOCUS_KEY);
  assert.deepEqual(window.events[0].detail, focus);
  assert.deepEqual(routes, ['studio-operations']);
  consumeOperationsFocus(window, { ...focus, agentId: 'other' });
  assert.deepEqual(readOperationsFocus(window), focus);
  consumeOperationsFocus(window, focus);
  assert.equal(readOperationsFocus(window), null);
});

test('missing, malformed or unavailable storage does not prevent navigation', () => {
  const window = browser();
  assert.equal(readOperationsFocus(window), null);
  for (const value of ['{', 'null', '{}', '{"tab":"delivery","agentId":"a","section":"unknown"}']) {
    window.localStorage.setItem(OPERATIONS_FOCUS_KEY, value);
    assert.equal(readOperationsFocus(window), null);
  }
  window.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  let route;
  focusOperations({ window, agentId: 'a', section: 'build', onNavigate: value => { route = value; } });
  assert.equal(route, 'studio-operations');
  assert.equal(window.events[0].detail.section, 'build');
  assert.equal(readOperationsFocus(window), null);
});

test('Operations receives initial focus and switches back from another tab for live focus', () => {
  const window = browser(), slots = [], cleanups = [];
  const listeners = new Map();
  window.addEventListener = (key, listener) => listeners.set(key, listener);
  window.removeEventListener = key => listeners.delete(key);
  window.localStorage.setItem(OPERATIONS_FOCUS_KEY, JSON.stringify({ tab: 'delivery', agentId: 'a', section: 'build' }));
  let cursor = 0;
  const h = (type, props, ...children) => ({ type, props, children });
  const { OperationsWorkspace } = createOperationsWorkspace({ window, ui: { React: { createElement: h,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = value; }]; },
    useEffect(effect) { if (!cleanups.length) cleanups.push(effect()); } }, StudioSubnav: 'tabs', DeliveryPage: 'delivery', AutomationPage: 'automation' } });
  const render = () => { cursor = 0; return OperationsWorkspace({}); };
  let tree = render();
  assert.equal(tree.children[1].props.focus.agentId, 'a');
  tree.children[0].props.onChange('automation');
  assert.equal(render().children[1].type, 'automation');
  listeners.get(OPERATIONS_FOCUS_KEY)({ detail: { tab: 'delivery', agentId: 'b', section: 'deploy' } });
  tree = render();
  assert.equal(tree.children[1].type, 'delivery');
  assert.equal(tree.children[1].props.focus.agentId, 'b');
  cleanups[0]();
  assert.equal(listeners.size, 0);
});
