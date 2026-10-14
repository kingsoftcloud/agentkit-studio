import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelsPage } from '../src/client/pages/channels.mjs';
function harness() {
  const state = [], calls = [];
  let cursor = 0, fail = false;
  const useState = initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const connection = { configured: true, tokenConfigured: true, serverUrl: 'http://localhost', accountId: 'test', workspaceId: 'logical-workspace', cloudAgents: [{ id: 'agent', name: 'Cloud Agent' }], localAgents: [{ id: 'local-a', name: 'Local A' }, { id: 'local-b', name: 'Local B' }], agentConnections: [] };
  const host = {
    channelConnection: async () => connection,
    updateAgentChannelConnection: async (agentId, patch) => { calls.push({ action: 'connector', agentId, payload: patch }); connection.agentConnections = [{ agentId, enabled: patch.enabled, state: patch.enabled ? 'connected' : 'stopped', tokenConfigured: true }]; return connection; },
    updateChannelConnection: async value => value,
    channelAction: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'CreateChannel' && fail) throw new Error('create failed');
      return { Code: 0, Data: { Items: action === 'ListChannels' ? [{ Id: 'channel-1', AgentId: 'agent', Channel: 'feishu', ChannelAccountId: 'account', Enabled: true }] : [] } };
    },
  };
  const names = ['OperationalPageHeading', 'Pill', 'EmptyState', 'Metric', 'OperationalToolbar', 'ResourceDialog', 'StudioPageTabs', 'OperationalTable', 'OperationalPager'];
  const Page = createChannelsPage({
    ui: { React: { createElement: h, useState, useEffect: () => {}, Fragment: 'fragment' }, BRAND: {}, buttonStyle: () => ({}), inputStyle: () => ({}), operationalStatus: value => value, ...Object.fromEntries(names.map(name => [name, name])) },
    hostRemote: host, actions: { confirm: async () => true },
  });
  const render = () => { cursor = 0; return Page(); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  const nodes = () => walk(render());
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  const field = label => nodes().find(node => node.type === 'label' && node.children[0] === label)?.children.find(node => node?.type === 'input');
  const fill = (label, value) => field(label).props.onChange({ target: { value } });
  const select = (label, value) => nodes().find(node => node.type === 'label' && node.children[0] === label).children.find(node => node?.type === 'select').props.onChange({ target: { value } });
  const submit = () => walk(nodes().find(node => node.type === 'ResourceDialog')).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const ready = async () => { await nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); };
  return { calls, ready, nodes, button, fill, field, select, submit, fail: value => { fail = value; } };
}

test('channel creation includes required credentials, keeps failure visible, and clears successful secret', async () => {
  const ui = harness(); await ui.ready();
  ui.button('新增渠道').props.onClick();
  ui.select('绑定 Agent', 'agent'); ui.fill('渠道账号 ID', ' account ');
  await ui.submit();
  assert.equal(ui.calls.filter(call => call.action === 'CreateChannel').length, 0);
  ui.fill('应用 App ID', 'app-id'); ui.fill('应用 App Secret', 'test-secret');
  assert.equal(ui.field('应用 App Secret').props.type, 'password');
  ui.fail(true); await ui.submit();
  assert.ok(ui.nodes().some(node => node.props.role === 'alert' && node.children.includes('create failed')));
  ui.fail(false); await ui.submit();
  const { payload } = ui.calls.find(call => call.action === 'CreateChannel');
  assert.equal(payload.AppId, 'app-id'); assert.equal(payload.AppSecret, 'test-secret');
  assert.equal(payload.AgentId, 'agent'); assert.equal(payload.ChannelAccountId, 'account');
  assert.equal('Enabled' in payload, false, 'CreateChannel does not support Enabled');
  assert.equal(ui.nodes().some(node => node.type === 'ResourceDialog'), false);
  ui.button('新增渠道').props.onClick();
  assert.equal(ui.field('应用 App Secret').props.value, '');
});

test('channel edit preserves credentials on blank inputs and locks immutable identity fields', async () => {
  const ui = harness(); await ui.ready();
  const table = ui.nodes().find(node => node.type === 'OperationalTable');
  const actions = table.props.columns.find(col => col.id === 'action').cell(table.props.rows[0]);
  actions.children.find(node => node.children.includes('编辑')).props.onClick({ stopPropagation() {} });
  assert.equal(ui.field('渠道账号 ID').props.disabled, true);
  assert.equal(ui.field('应用 App ID').props.required, false);
  await ui.submit();
  const { payload } = ui.calls.find(call => call.action === 'UpdateChannel');
  assert.equal(payload.Id, 'channel-1');
  for (const key of ['AppId', 'AppSecret', 'Channel', 'ChannelAccountId']) assert.equal(key in payload, false);
});


test('local Agent selection updates channel identity and connector secrets never follow another Agent', async () => {
  const ui = harness(); await ui.ready();
  ui.select('本地 Agent', 'local-a'); ui.fill('Agent 连接凭证', 'a-private-token');
  ui.select('本地 Agent', 'local-b');
  assert.equal(ui.field('Agent 连接凭证').props.value, '');
  ui.fill('Agent 连接凭证', 'b-private-token');
  await ui.nodes().find(node => node.type === 'form' && node.children.some(child => child?.type === 'button' && child.children.includes('启用连接'))).props.onSubmit({ preventDefault() {} });
  assert.deepEqual(ui.calls.find(call => call.action === 'connector'), { action: 'connector', agentId: 'local-b', payload: { enabled: true, token: 'b-private-token' } });
  assert.equal(ui.field('Agent 连接凭证').props.value, '');
  await ui.button('停用连接').props.onClick();
  assert.deepEqual(ui.calls.filter(call => call.action === 'connector').at(-1).payload, { enabled: false });
  ui.button('新增渠道').props.onClick();
  ui.select('绑定 Agent', 'local-b');
  ui.fill('渠道账号 ID', 'account'); ui.fill('应用 App ID', 'id'); ui.fill('应用 App Secret', 'secret');
  await ui.submit();
  assert.equal(ui.calls.find(call => call.action === 'CreateChannel').payload.AgentId, 'local-b');
  ui.button('新增渠道').props.onClick();
  ui.select('绑定 Agent', '');
  assert.equal(ui.nodes().some(node => node.type === 'input' && node.props.value === 'local-b'), false);
});
