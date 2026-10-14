import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeAuthoring } from '../src/client/state/native-authoring.mjs';
import { createNativeAuthoringButton } from '../src/client/dsh/native-authoring.mjs';

function harness() {
  const events = [], bindings = [];
  const window = { dispatchEvent: event => events.push(event.type) };
  const api = createNativeAuthoring({ events: window, createEvent: type => ({ type }), writeConversationAgent: (agent, session) => bindings.push({ agent, session }) });
  return { ...api, events, bindings };
}

test('conversation creation opens a fresh ungrouped native session before seeding', async () => {
  const ui = harness();
  await ui.openAgentAuthoring({ openWorkspace: async (directory, beforeOpen) => {
    assert.equal(directory, null);
    assert.deepEqual(ui.events, []);
    beforeOpen('new-native-session');
    assert.deepEqual(ui.bindings, [{ agent: '', session: 'new-native-session' }]);
    assert.deepEqual(ui.events, []);
  } });
  assert.equal(ui.pending(), true);
  assert.deepEqual(ui.events, ['agentkit-studio:seed-authoring']);
  const insertion = {};
  let prompt;
  assert.equal(ui.seedAgentAuthoring({ captureInsertion: () => insertion, insertText: (text, target) => { prompt = text; assert.equal(target, insertion); return true; } }), true);
  assert.match(prompt, /信息不足时逐步澄清/);
  assert.match(prompt, /持续更新草稿/);
  assert.match(prompt, /明确确认草稿后再创建/);
});

test('cancelled native navigation cannot seed or unbind the previous conversation', async () => {
  const ui = harness();
  await ui.openAgentAuthoring({ openWorkspace: async () => {} });
  assert.equal(ui.pending(), false);
  assert.deepEqual(ui.events, []);
  assert.deepEqual(ui.bindings, []);
});

test('failed native navigation cannot seed the previous conversation', async () => {
  const ui = harness();
  await assert.rejects(ui.openAgentAuthoring({ openWorkspace: async () => { throw new Error('navigation failed'); } }), /navigation failed/);
  assert.equal(ui.pending(), false);
  assert.deepEqual(ui.events, []);
  assert.deepEqual(ui.bindings, []);
});

test('a busy native composer does not report a successful insertion', () => {
  const ui = harness();
  assert.equal(ui.seedAgentAuthoring(), false);
  assert.equal(ui.seedAgentAuthoring({ captureInsertion: () => ({}), insertText: () => false }), false);
});

test('the native hero authoring entry also requests a fresh session', () => {
  const events = [];
  const h = (type, props) => ({ type, props });
  const authoring = createNativeAuthoring({ events: { dispatchEvent: event => events.push(event.type) }, createEvent: type => ({ type }), writeConversationAgent() {} });
  const Button = createNativeAuthoringButton({ React: { createElement: h, useEffect() {} }, authoring, buttonStyle: () => ({}) });
  const button = Button({ inputActions: {} });
  button.props.onClick();
  assert.deepEqual(events, ['agentkit-studio:open-authoring']);
});
