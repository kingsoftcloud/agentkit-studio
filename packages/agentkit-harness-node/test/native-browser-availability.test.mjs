import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNativeBrowserExecutable } from '../src/native/browser-availability.mjs';

test('browser discovery shares one real executable selection and never masks an invalid explicit setting', () => {
  const bundled = '/installed/chromium', chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const options = { env: {}, platform: 'darwin', bundledPath: bundled, canExecute: value => [bundled, chrome].includes(value) };
  assert.equal(resolveNativeBrowserExecutable(options), bundled);
  assert.equal(resolveNativeBrowserExecutable({ ...options, canExecute: value => value === chrome }), chrome);
  assert.equal(resolveNativeBrowserExecutable({ ...options, canExecute: () => false }), null);
  assert.equal(resolveNativeBrowserExecutable({ ...options, env: { KSADK_BROWSER_EXECUTABLE_PATH: '/missing/browser' } }), null);
  assert.equal(resolveNativeBrowserExecutable({ ...options, env: { KSADK_BROWSER_EXECUTABLE_PATH: 'relative-browser' } }), null);
  assert.equal(resolveNativeBrowserExecutable({ ...options, env: { KSADK_BROWSER_EXECUTABLE_PATH: chrome } }), chrome);
});
