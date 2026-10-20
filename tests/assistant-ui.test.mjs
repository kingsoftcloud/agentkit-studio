import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantNativeComposer } from '../src/client/components/assistant-native-composer.mjs';
import { createAssistantPage } from '../src/client/pages/assistant.mjs';
import { createAssistantSettings } from '../src/client/pages/assistant-settings.mjs';

function render(factory, states = {}, props = {}, additions = {}) {
  let index = 0;
  const ui = {
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
      useState(initial) { const id = index++; return [Object.hasOwn(states, id) ? states[id] : typeof initial === 'function' ? initial() : initial, () => {}]; },
      useRef: value => ({ current: value }), useEffect() {} },
    BRAND: { border: '#ddd', surface: '#fff', ink: '#111', inkMuted: '#777' }, buttonStyle: () => ({}), inputStyle: () => ({}),
    ComputerConnection: 'computer-connection', AssistantTranscript: 'assistant-transcript', StudioSubnav: 'subnav', Modal: 'modal',
  };
  Object.assign(ui, additions);
  const window = { localStorage: { getItem: () => null }, crypto: { randomUUID: () => 'fixture-request' } };
  return factory({ ui, hostRemote: {}, actions: {}, window })(props);
}
const nodes = root => typeof root === 'object' && root !== null ? [root, ...root.children.flatMap(nodes)] : [];
const text = root => typeof root === 'string' ? root : root?.children?.map(text).join('') || '';
const catalog = [{ metadata: { id: 'cloud-agent', name: 'Assistant' } }];
const session = (patch = {}) => ({ agentId: 'cloud-agent', draft: '', attachments: [], attachmentError: '', busy: false, pending: null, pendingInvalid: false,
  notice: '', olderHasMore: null, loadingOlder: false, cancelPhase: null, accepted: [], older: [], olderEvents: [], view: { status: 'idle', messages: [], events: [] }, ...patch });

function diagnostics(view) {
  const tree = render(createAssistantSettings, { 0: catalog, 1: 'cloud-agent', 3: view });
  return nodes(tree).find(node => node.props['data-assistant-connection-diagnostics']);
}
const rowValue = (tree, label) => {
  const row = nodes(tree).find(node => node.type === 'div' && node.children.some(child => child?.type === 'dt' && text(child) === label));
  return text(row?.children.find(child => child?.type === 'dd'));
};

test('connection capabilities are collapsed and report the actual permission snapshot', () => {
  const detail = diagnostics({ capabilities: { composer: { nativeComposer: true }, input: { attachments: true }, execution: {
    location: 'cloud', permission: 'workspace-write', approval: 'ask', durableQueue: true, scopedCancel: true,
  }, approval: { interactive: true }, localHandoff: false } });
  assert.ok(detail);
  assert.equal(detail.type, 'details');
  assert.equal(detail.props.open, undefined);
  assert.equal(text(detail.children[0]), '连接诊断');
  for (const [label, value] of [['输入', '原生输入'], ['工作区权限', '工作区读写'], ['审批策略', '需要时询问'], ['附件', '可用'], ['本机执行', '不可用']]) {
    assert.equal(rowValue(detail, label), value);
  }
});

test('connection diagnostics never infer a grant from an absent capability', () => {
  const detail = diagnostics({});
  for (const label of ['输入', '附件', '工作区权限', '审批策略', '本机执行', '实时审批']) assert.equal(rowValue(detail, label), '未确认');
  const legacy = diagnostics({ capabilities: { execution: { permission: 'read-only', approval: 'never' } } });
  assert.equal(rowValue(legacy, '工作区权限'), '只读');
  assert.equal(rowValue(legacy, '审批策略'), '不支持询问');
});

test('native composer wrapper has no parallel attachment picker or persistent technical footer', () => {
  const tree = render(createAssistantNativeComposer, { 1: { loading: false, error: '', pending: null, busy: false } }, { agentId: 'cloud-agent' });
  assert.equal(nodes(tree).filter(node => node.type === 'input' || node.type === 'button').length, 0);
  assert.equal(text(tree), '');
  assert.equal(nodes(tree).filter(node => node.props.ref && node.type === 'div').length, 1);
});

test('conversation is quiet at rest but retains actionable unknown-save notices', () => {
  const tree = render(createAssistantPage, { 0: catalog, 1: 'cloud-agent', 3: session(), 4: true });
  const copy = text(tree);
  for (const unnecessary of ['离开也没关系', '关闭 Studio', '原生输入已绑定', 'Shift + Enter']) assert.equal(copy.includes(unnecessary), false);
  assert.equal(nodes(tree).filter(node => node.props.role === 'status').length, 0, 'no empty permanent status line');
  const pending = render(createAssistantPage, { 0: catalog, 1: 'cloud-agent', 3: session({ pending: { requestId: 'unknown', observed: true } }), 4: true });
  assert.ok(text(pending).includes('消息已收到，保存待确认。'));
  assert.ok(text(pending).includes('确认提交'));
});


test('assistant browser wraps only the conversation and is keyed to the selected assistant', () => {
  const tree = render(createAssistantPage, { 0: catalog, 1: 'cloud-agent', 3: session(), 4: true }, {}, { AssistantBrowser: 'assistant-browser' });
  assert.equal(tree.type, 'assistant-browser');
  assert.equal(tree.props.key, 'cloud-agent');
  assert.equal(tree.props.agentId, 'cloud-agent');
  assert.equal(tree.children[0].props['data-studio-assistant'], true);
  const setup = render(createAssistantPage, { 0: [], 4: true }, {}, { AssistantBrowser: 'assistant-browser' });
  assert.equal(setup.props['data-studio-assistant-setup'], true);
  assert.equal(nodes(setup).some(node => node.type === 'assistant-browser'), false);
});
