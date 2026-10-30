import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalTeamsJson, copyTeamsJson } from '../src/providers/native-teams-json.mjs';
import { teamsContextDigest, validatePreparedTeamsContext, validateTeamsCallbackPermit } from '../src/providers/native-teams-context-contract.mjs';
import { preparedContext, callbackPermit } from './fixtures/native-teams-context.mjs';

test('Teams canonical JSON uses UTF16 key order, ECMAScript numbers and negative-zero normalization', () => {
  const expected = '{"a":[0,0.000001,1e-7,333333333.3333333],"z":"中文","😀":1,"דּ":2}';
  const value = { '\ufb33': 2, '\ud83d\ude00': 1, z: '中文', a: [-0, 1e-6, 1e-7, 333333333.33333329] };
  assert.equal(canonicalTeamsJson(value), expected);
  assert.equal(teamsContextDigest(value), 'sha256:' + createHash('sha256').update(expected).digest('hex'));
  assert.equal(Object.is(copyTeamsJson(value).a[0], -0), false);
});

test('Teams signed JSON rejects lossy numbers, BigInt, invalid Unicode and non-JSON structures', () => {
  const circular = {}; circular.self = circular;
  const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { assert.fail('getter must not be invoked'); } });
  const symbol = { [Symbol('not-json')]: 'x' };
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1e20, 1n, undefined,
    '\ud800', { '\udfff': 'invalid key' }, new Date(), new Set(), [, 1], circular, accessor, symbol]) {
    assert.throws(() => canonicalTeamsJson(value), { code: 'NATIVE_TEAMS_JSON_INVALID' });
  }
  assert.equal(canonicalTeamsJson(Number.MAX_SAFE_INTEGER), '9007199254740991');
  let nested = null; for (let i = 0; i < 51; i++) nested = [nested];
  assert.throws(() => canonicalTeamsJson(nested), { code: 'NATIVE_TEAMS_JSON_INVALID' });
});

test('full Teams command identity/content is validated even without a Host command callback', () => {
  for (const name of ['schema_version', 'authorization_ref', 'submitted_at', 'source']) {
    const context = preparedContext(); delete context.command[name];
    assert.throws(() => validatePreparedTeamsContext(context), { code: 'NATIVE_TEAMS_CONTEXT_INVALID' });
  }
  const context = preparedContext(); delete context.command.payload.content;
  assert.throws(() => validatePreparedTeamsContext(context), { code: 'NATIVE_TEAMS_CONTEXT_INVALID' });
  const spaceKey = preparedContext({ idem: 'original business operation key' });
  assert.deepEqual(validatePreparedTeamsContext(spaceKey), spaceKey);
});

test('impossible calendar dates and lone surrogates are not normalized into signed claims', () => {
  const context = preparedContext();
  for (const change of [{ issuedAt: '2026-02-30T00:00:00.000Z', expiresAt: '2026-03-02T00:00:10.000Z' },
    { nonce: '\ud800' }, { authorityId: 'x\0y' }]) {
    assert.throws(() => validateTeamsCallbackPermit(callbackPermit(context, change)), { code: 'NATIVE_TEAMS_CALLBACK_INVALID' });
  }
});
