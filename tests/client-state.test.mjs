import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionOwner } from '../src/client/state/connection.mjs';
import { createConversationAgentState } from '../src/client/state/conversation-agent.mjs';
import { createNativeAuthoring } from '../src/client/state/native-authoring.mjs';

test('late cleanup cannot disconnect a remounted renderer or another renderer', () => {
  const a = createConnectionOwner(), b = createConnectionOwner();
  const old = a.bind({ rpc: 'old' }), current = a.bind({ rpc: 'current' });
  const other = b.bind({ rpc: 'other' });
  old(); old();
  assert.equal(a.connection.rpc, 'current');
  current(); current();
  assert.equal(a.connection.rpc, undefined);
  assert.equal(b.connection.rpc, 'other');
  other();
});

test('display storage keeps session identities separate and emits without a window global', () => {
  const values = new Map(), emitted = [];
  const state = createConversationAgentState({
    storage: () => ({ getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }),
    events: { dispatchEvent: event => emitted.push(event) },
    createEvent: (type, detail) => ({ type, detail }), now: () => 7,
  });
  state.writeConversationAgent('A', 'same-id');
  state.writeConversationAgent('B', 'other-id');
  assert.equal(state.readConversationAgent('same-id'), 'A');
  assert.equal(state.readConversationAgent('other-id'), 'B');
  assert.equal(state.readConversationAgent(), null);
  assert.deepEqual(emitted[0], { type: 'agentkit-studio:conversation-context-change', detail: { agentId: 'A', updatedAt: 7 } });
  values.set('agentkit-studio:conversation-agent:malformed', 'broken');
  assert.equal(state.readConversationAgent('malformed'), null);
});

test('unavailable private-mode storage still emits the current display change', () => {
  const emitted = [];
  const state = createConversationAgentState({ storage: () => { throw new Error('blocked'); }, events: { dispatchEvent: event => emitted.push(event) }, createEvent: (type, detail) => ({ type, detail }) });
  state.writeConversationAgent(null, 'session');
  assert.equal(state.readConversationAgent('session'), null);
  assert.equal(emitted[0].detail.agentId, null);
});

function authoringHarness() {
  const events = new EventTarget(), bindings = [], dispatched = [];
  const state = createNativeAuthoring({ events, createEvent: type => { dispatched.push(type); return new Event(type); }, writeConversationAgent: (...value) => bindings.push(value) });
  return { state, bindings, dispatched, events };
}

test('late native navigation after disposal cannot publish a draft binding or seed', async () => {
  const { state, bindings, dispatched } = authoringHarness();
  const ready = Promise.withResolvers();
  let beforeOpen;
  const dispose = state.mount();
  const opening = state.openAgentAuthoring({ openWorkspace: (_directory, prepare) => { beforeOpen = prepare; return ready.promise; } });
  dispose(); beforeOpen('late'); ready.resolve(); await opening;
  assert.deepEqual(bindings, []); assert.deepEqual(dispatched, []);
  assert.equal(state.pending(), false);
});

test('superseded navigation cannot seed over the current native draft', async () => {
  const { state, bindings, dispatched } = authoringHarness();
  let late;
  const ready = Promise.withResolvers();
  const first = state.openAgentAuthoring({ openWorkspace: (_dir, prepare) => { late = prepare; return ready.promise; } });
  await state.openAgentAuthoring({ openWorkspace: async (_dir, prepare) => prepare('current') });
  late('old'); ready.resolve(); await first;
  assert.deepEqual(bindings, [['', 'current']]);
  assert.deepEqual(dispatched, ['agentkit-studio:seed-authoring']);
});

test('scope disposal releases prompt subscriptions and old disposer cannot close a new scope', async () => {
  const { state, events } = authoringHarness();
  const old = state.mount();
  const current = state.mount(); old();
  await state.openAgentAuthoring({ openWorkspace: async (_dir, prepare) => prepare('current') });
  let inserted = 0;
  const off = state.subscribe({ captureInsertion: () => ({}), insertText: () => { inserted++; return false; } });
  assert.equal(inserted, 1);
  current(); events.dispatchEvent(new Event('agentkit-studio:seed-authoring'));
  assert.equal(inserted, 1); off(); off();
});

test('failed navigation after preparation clears the pending prompt', async () => {
  const { state } = authoringHarness();
  await assert.rejects(state.openAgentAuthoring({ openWorkspace: async (_dir, prepare) => { prepare('prepared'); throw new Error('failed'); } }), /failed/);
  assert.equal(state.pending(), false);
});
