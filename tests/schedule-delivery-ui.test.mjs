import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleDeliveryTargets } from '../src/cloud-schedule-targets.mjs';
import { createScheduleDelivery } from '../src/client/components/schedule-delivery.mjs';
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item != null && item !== false) });
const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [];
const content = node => typeof node === 'string' ? node : node?.children?.map(content).join('') || '';

test('only supported cloud bots with an observed conversation can be recipients', () => {
  const channel = { Id: 'config', AgentId: 'agent', Channel: 'wps-xiezuo', ChannelAccountId: 'bot', Enabled: true };
  const binding = { Id: 'binding', AgentId: 'agent', Channel: 'wps-xiezuo', ChannelAccountId: 'bot', ChatType: 'dm', PeerId: 'person', ChatId: 'chat' };
  for (const patch of [{ Enabled: false }, { ConnectorWorkspaceId: 'desktop' }, { AgentId: 'other' }, { Channel: 'wecom' }]) {
    assert.deepEqual(scheduleDeliveryTargets('agent', [{ ...channel, ...patch }], [binding]), []);
  }
  for (const patch of [{ ChatId: '' }, { AgentId: 'other' }, { ChannelAccountId: 'other' }]) {
    assert.deepEqual(scheduleDeliveryTargets('agent', [channel], [{ ...binding, ...patch }]), []);
  }
  assert.deepEqual(scheduleDeliveryTargets('agent', [channel], [binding]), [{ channelConfigId: 'config', bindingId: 'binding', label: 'WPS · bot · 私聊 chat' }]);
});

test('picker never selects a recipient automatically; disabled delivery preserves record mode', async () => {
  const states = [], effects = [], changes = [];
  let cursor = 0;
  const useState = initial => { const index = cursor++; states[index] ??= initial; return [states[index], next => { states[index] = next; }]; };
  const host = { scheduleDeliveryTargets: async () => ({ items: [{ channelConfigId: 'c', bindingId: 'b', label: 'Test chat' }] }) };
  const { ScheduleDeliveryPicker: Picker } = createScheduleDelivery({ ui: { React: { createElement: h, useState, useEffect: effect => effects.push(effect), Fragment: 'fragment' }, BRAND: {}, inputStyle: () => ({}) }, hostRemote: host });
  const render = props => { cursor = 0; return Picker({ agentId: 'a', mode: 'record', target: null, supported: true, onChange: (...args) => changes.push(args), ...props }); };
  let tree = render({ supported: false });
  assert.equal(walk(tree).filter(node => node.type === 'input')[1].props.disabled, true);
  tree = render({ mode: 'channel' });
  effects.at(-1)(); await new Promise(resolve => setImmediate(resolve));
  tree = render({ mode: 'channel' });
  assert.deepEqual(changes, []);
  const select = walk(tree).find(node => node.type === 'select');
  assert.equal(select.props.value, '');
  select.props.onChange({ target: { value: 'c/b' } });
  assert.deepEqual(changes, [['channel', { channelConfigId: 'c', bindingId: 'b' }]]);
});

test('result view shows delivery uncertainty without hiding the completed result', () => {
  const { ScheduleDeliveryResult: Result } = createScheduleDelivery({ ui: { React: { createElement: h }, Pill: 'Pill', BRAND: {} } });
  const tree = Result({ item: { deliveryState: 'unknown', resultText: 'saved report' } });
  assert.match(content(tree), /送达结果待确认/);
  assert.match(content(tree), /不会自动重复发送/);
  assert.match(content(tree), /saved report/);
  assert.equal(walk(tree).some(node => node.type === 'details'), true);
});
