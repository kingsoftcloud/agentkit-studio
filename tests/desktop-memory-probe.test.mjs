import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDesktopRoles, assertStableRoles } from '../scripts/measure-desktop-memory.mjs';

// Independent observation: the second renderer was the welcome window, not a guest.
const pages = [
  { id: 2, type: 'window', pid: 33354, url: 'file:///desktop/renderer/welcome.html' },
  { id: 1, type: 'window', pid: 33346, url: 'dsh-app://app/' },
  { id: 3, type: 'webview', pid: 35946, url: 'http://127.0.0.1:58874/' },
];

test('desktop memory roles use webContents type and URL, never renderer order', () => {
  const roles = selectDesktopRoles({ pid: 45477, pages }, 45477, 'http://127.0.0.1:58874/');
  assert.equal(roles.app_renderer.pid, 33346);
  assert.equal(roles.browser_guest.pid, 35946);
  assert.throws(() => selectDesktopRoles({ pid: 45477, pages: pages.slice(0, 2) }, 45477, 'http://127.0.0.1:58874/'), /exactly one Browser guest/);
  assert.throws(() => selectDesktopRoles({ pid: 45477, pages }, 33339, 'http://127.0.0.1:58874/'), /main PID/);
});

test('memory probe rejects ambiguous guests, reused PIDs and changed page identities', () => {
  assert.throws(() => selectDesktopRoles({ pid: 45477, pages: [...pages, { ...pages[2], id: 4, pid: 99999 }] }, 45477, 'http://127.0.0.1:58874/'), /exactly one Browser guest/);
  const roles = selectDesktopRoles({ pid: 45477, pages }, 45477, 'http://127.0.0.1:58874/');
  assert.throws(() => assertStableRoles(roles, { ...roles, browser_guest: { ...roles.browser_guest, pid: 99999 } }), /identity changed/);
  assert.throws(() => assertStableRoles(roles, { ...roles, browser_guest: { ...roles.browser_guest, id: 99 } }), /identity changed/);
  assertStableRoles(roles, structuredClone(roles));
});
