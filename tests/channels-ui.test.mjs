import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fragment = await readFile(new URL('../src/client-fragments/07-channels-and-shell.js', import.meta.url), 'utf8');
const source = fragment.slice(0, fragment.indexOf('    function OperationalPage('));
function harness() {
  const state = [], calls = [];
  let cursor = 0, fail = false;
  const useState = initial => {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  };
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) });
  const host = {
    channelConnection: async () => ({ configured: true, tokenConfigured: true, serverUrl: 'http://localhost', accountId: 'test' }),
    updateChannelConnection: async value => value,
    channelAction: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'CreateChannel' && fail) throw new Error('create failed');
      return { Code: 0, Data: { Items: action === 'ListChannels' ? [{ Id: 'channel-1', AgentId: 'agent', Channel: 'feishu', ChannelAccountId: 'account', Enabled: true }] : [] } };
    },
  };
  const names = ['OperationalPageHeading', 'Pill', 'EmptyState', 'Metric', 'OperationalToolbar', 'ResourceDialog', 'StudioPageTabs', 'OperationalTable', 'OperationalPager'];
  const Page = new Function('useState', 'useEffect', 'h', 'hostRemote', 'BRAND', 'React', 'buttonStyle', 'inputStyle', 'operationalCollection', 'operationalId', 'operationalStatus', 'operationalDate', ...names, `${source}; return ChannelsPage;`)(useState, () => {}, h, host, {}, { Fragment: 'fragment' }, () => ({}), () => ({}), data => data.Items || [], row => row.Id, value => value, value => value, ...names);
  const render = () => { cursor = 0; return Page(); };
  const walk = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(walk)] : [];
  const nodes = () => walk(render());
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || '';
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label);
  const field = label => nodes().find(node => node.type === 'label' && node.children[0] === label)?.children.find(node => node?.type === 'input');
  const fill = (label, value) => field(label).props.onChange({ target: { value } });
  const submit = () => walk(nodes().find(node => node.type === 'ResourceDialog')).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const ready = async () => { await nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); };
  return { calls, ready, nodes, button, fill, field, submit, fail: value => { fail = value; } };
}

test('channel creation includes required credentials, keeps failure visible, and clears successful secret', async () => {
  const ui = harness(); await ui.ready();
  ui.button('新增渠道').props.onClick();
  ui.fill('Agent ID', ' agent '); ui.fill('渠道账号 ID', ' account ');
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
