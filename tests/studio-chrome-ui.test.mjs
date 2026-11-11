import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioPrimitives } from '../src/client/components/primitives.mjs';
import { createNavigation } from '../src/client/components/navigation.mjs';
import { createStudioShell } from '../src/client/components/shell.mjs';
import { createFormStyles } from '../src/client/components/form-styles.mjs';
import { createOperationalComponents } from '../src/client/components/operational.mjs';

const h = (type, props, ...children) => ({ type, props, children });
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flat(Infinity).flatMap(nodes)] : [];
const primitives = createStudioPrimitives({ React: { createElement: h } });

test('operational refresh is an accessible icon with the same busy and dispatch semantics', () => {
  const { OperationalToolbar } = createOperationalComponents({ ui: { React: { createElement: h }, buttonStyle: () => ({}) } });
  let refreshed = 0;
  for (const busy of [false, true]) {
    const tree = OperationalToolbar({ busy, onRefresh: () => refreshed++ });
    const button = nodes(tree).find(node => node.type === 'button');
    assert.equal(button.props['aria-label'], busy ? '读取中…' : '刷新');
    assert.equal(button.props.disabled, busy);
    assert.ok(nodes(button).some(node => node.type === 'svg'));
    if (!busy) button.props.onClick();
  }
  assert.equal(refreshed, 1);
});

test('headings and intros keep details in compact accessible help', () => {
  for (const name of ['SectionHeading', 'OperationalPageHeading', 'ContentIntro']) {
    const action = h('button', {}, '操作');
    const tree = primitives[name]({ title: '标题', detail: '使用说明', action });
    assert.equal(nodes(tree).some(node => node.type === 'p'), false);
    assert.ok(nodes(tree).some(node => node.props?.title === '使用说明' && node.props['aria-label'] === '使用说明'));
    assert.ok(nodes(tree).includes(action));
    assert.equal(nodes(primitives[name]({ title: '标题' })).some(node => node.type === 'i'), false);
  }
});

test('chip navigation preserves selection, drag markers and dispatch', () => {
  const { StudioPageTabs, StudioSubnav } = createNavigation({ ui: { React: { createElement: h } } });
  for (const Component of [StudioPageTabs, StudioSubnav]) {
    let selected;
    const tree = Component({ items: [{ id: 'one', label: '一' }, { id: 'two', label: '二' }], value: 'one', onChange: value => { selected = value; } });
    assert.equal(tree.props.className, 'studio-tabs');
    assert.equal(tree.props['data-window-drag'], 'true');
    const buttons = nodes(tree).filter(node => node.type === 'button');
    assert.ok(buttons[0].props['aria-selected'] || buttons[0].props['aria-current']);
    buttons[1].props.onClick();
    assert.equal(selected, 'two');
    assert.equal(nodes(Component({ items: [], onChange() {} })).filter(node => node.type === 'button').length, 0);
  }
});

test('host status keeps loading, ready and error copy without pill chrome', () => {
  for (const [status, copy] of [['loading', '读取 Host'], ['ready', 'Host 已连接'], ['error', 'Host 待接入']]) {
    const { HostStatusPill } = createStudioShell({ ui: { React: { createElement: h, useState: () => [status, () => {}], useEffect() {} } } });
    const tree = HostStatusPill();
    assert.equal(tree.props.className, 'studio-host-status');
    assert.ok(tree.children.includes(copy));
  }
});

test('shared controls and surfaces use lightweight DSH dimensions', () => {
  const { buttonStyle, pagerButtonStyle } = createFormStyles();
  assert.equal(buttonStyle().minHeight, '32px');
  assert.equal(buttonStyle().borderRadius, '16px');
  assert.equal(pagerButtonStyle(true).background, 'transparent');
  assert.equal(pagerButtonStyle(true).opacity, 0.4);
  assert.equal(pagerButtonStyle(false).opacity, 1);
  assert.equal(primitives.EmptyState({ title: '暂无内容' }).props.style.border, 0);
  assert.equal(primitives.Metric({ label: '数量', value: 0 }).props.style.boxShadow, undefined);
});
