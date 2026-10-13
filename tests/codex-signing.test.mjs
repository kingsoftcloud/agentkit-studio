import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCodeModeHostEntitlements, assertCodeModeSigningRecord } from '../scripts/verify-codex-signing.mjs';

const jit = 'com.apple.security.cs.allow-jit';
const memory = 'com.apple.security.cs.allow-unsigned-executable-memory';
test('a correctly signed binary without Code Mode entitlements is not an executable release', () => {
  for (const value of [{}, { [jit]: true }, { [jit]: true, [memory]: false }]) {
    assert.throws(() => assertCodeModeHostEntitlements(value), /missing required entitlement/);
  }
});
test('the pinned official Code Mode entitlement contract is accepted', () => {
  assert.doesNotThrow(() => assertCodeModeHostEntitlements({ [jit]: true, [memory]: true }));
});
test('reusing an old signed candidate cannot bypass the corrected signature gate', () => {
  assert.throws(() => assertCodeModeSigningRecord({}), /rebuild/);
  assert.throws(() => assertCodeModeSigningRecord({ codeModeHostSigning: { verified: true, sha256: 'a'.repeat(64), entitlements: {} } }), /missing required entitlement/);
  assert.doesNotThrow(() => assertCodeModeSigningRecord({ codeModeHostSigning: { verified: true, sha256: 'a'.repeat(64), entitlements: { [jit]: true, [memory]: true } } }));
});
