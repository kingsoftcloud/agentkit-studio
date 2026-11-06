import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionPermissionMode } from '../src/session-permission-mode.mjs';

const session = { id: 'session-a' };
const context = services => ({ get: name => services[name] });

test('the Session sandbox knob wins over the derived preset name', () => {
  const ctx = context({
    // A DSH image without a read-only preset derives `custom` from the name,
    // even though the sandbox knob still records the selected mode.
    sessionProjections: { stateOf: (_session, key) => (key === 'sandboxMode' ? 'read-only' : null) },
    permissionPresets: { current: () => 'custom' },
  });

  assert.equal(readSessionPermissionMode(ctx, session), 'read-only');
});

test('the preset name remains a fallback for hosts without the projection', () => {
  const ctx = context({ permissionPresets: { current: () => 'workspace-write' } });

  assert.equal(readSessionPermissionMode(ctx, session), 'workspace-write');
});

test('a Session without an override returns undefined so the image default stays', () => {
  const ctx = context({
    sessionProjections: { stateOf: () => null },
    permissionPresets: { current: () => null },
  });

  assert.equal(readSessionPermissionMode(ctx, session), undefined);
});

test('an unavailable projection service never fails a turn', () => {
  assert.equal(readSessionPermissionMode(context({}), session), undefined);
  assert.equal(readSessionPermissionMode({ get: () => { throw new Error('disposing'); } }, session), undefined);
  assert.equal(readSessionPermissionMode(undefined, session), undefined);
});
