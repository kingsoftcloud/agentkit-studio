import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantNativeCommandUi } from '../src/client/dsh/assistant-native-graph.mjs';

const createSnapshotStore = initial => {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, set(next) { value = next; for (const listener of listeners) listener(); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
};
function fixture() {
  const scope = {}, session = { sessionId: 'cloud-session' };
  let binding = { session };
  const scopes = new Map([[scope, session]]);
  const sessions = { sessionOf: key => scopes.get(key), binding: id => id === 'cloud-session' ? binding : undefined };
  return { ...createAssistantNativeCommandUi({ sessionId: session.sessionId, sessions, createSnapshotStore }), scope, session, scopes,
    release() { binding = undefined; }, replace() { binding = { session: { sessionId: session.sessionId } }; } };
}

test('cloud native command face supports Send and Escape dismissal within the retained session', () => {
  const f = fixture();
  const popup = f.commandUi.popupFor(f.scope);
  assert.equal(f.commandUi.popupFor(f.scope), popup, 'one stable popup face per retained scope');
  assert.doesNotThrow(() => popup.dismiss());
  assert.doesNotThrow(() => popup.dismiss());
  assert.deepEqual(Object.keys(popup), ['dismiss'], 'no popup action or Host authority is exposed');
});

test('cloud native popup dismissal rejects foreign, unretained, and superseded scopes', () => {
  const f = fixture(), foreign = {};
  f.scopes.set(foreign, { sessionId: 'local-session' });
  assert.throws(() => f.commandUi.popupFor({}), /retained cloud Session/);
  assert.throws(() => f.commandUi.popupFor(foreign), /retained cloud Session/);
  f.replace();
  assert.throws(() => f.commandUi.popupFor(f.scope), /retained cloud Session/);
  f.release();
  assert.throws(() => f.commandUi.popupFor(f.scope), /retained cloud Session/);
});

test('the paperclip uses one native file registration and cleanup cannot remove its replacement', () => {
  const f = fixture(), changed = [];
  f.file.subscribe(() => changed.push(f.file.getSnapshot()));
  let picked;
  const first = { name: 'file', available: () => true, ui: { kind: 'action', run: session => { picked = session; } } };
  const unregister = f.commandUi.register(first);
  assert.equal(f.file.getSnapshot(), first);
  f.file.getSnapshot().ui.run({ sessionId: 'cloud-session' });
  assert.deepEqual(picked, { sessionId: 'cloud-session' });
  assert.throws(() => f.commandUi.register(first), /already registered/);
  unregister();
  const next = { ...first };
  const removeNext = f.commandUi.register(next);
  unregister();
  assert.equal(f.file.getSnapshot(), next);
  removeNext();
  assert.deepEqual(changed, [first, null, next, null]);
});

test('cloud native command registry cannot add unsupported menu commands', () => {
  const f = fixture();
  for (const command of [{ name: 'shell', ui: { kind: 'action' } }, { name: 'file', ui: { kind: 'popupSelect' } }]) {
    assert.throws(() => f.commandUi.register(command), /only supports the native file action/);
    assert.equal(f.file.getSnapshot(), null);
  }
});
