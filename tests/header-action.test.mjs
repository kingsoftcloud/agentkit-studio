import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeaderAction } from '../src/client/components/header-action.mjs';

const h = (type, props, ...children) => ({ type, props, children });
test('header actions move into their own page header and update without copying handlers', () => {
  const target = {};
  let effect, selected;
  const anchor = { current: { closest: () => ({ querySelector: () => target }) } };
  const HeaderAction = createHeaderAction({
    React: { createElement: h, useRef: () => anchor, useState: () => [selected, value => { selected = value; }], useEffect: callback => { effect = callback; } },
    ReactDOM: { createPortal: (children, container) => ({ children, container }) },
  });
  const action = h('button', { onClick() {} }, '添加模型');
  assert.equal(HeaderAction({ children: action }).children[0], action);
  effect();
  const portal = HeaderAction({ children: action }).children[0];
  assert.equal(portal.container, target);
  assert.equal(portal.children, action);
  assert.equal(HeaderAction({ children: null }).children[0].children, null);
});

test('header actions retain inline fallback outside a page frame', () => {
  let selected;
  const HeaderAction = createHeaderAction({ React: { createElement: h, useRef: () => ({ current: { closest: () => null } }), useState: () => [selected, value => { selected = value; }], useEffect: callback => callback() } });
  const action = h('button', null, '重试');
  assert.equal(HeaderAction({ children: action }).children[0], action);
  assert.equal(selected, null);
});
