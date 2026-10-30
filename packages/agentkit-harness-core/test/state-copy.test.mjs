import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, copy, parseNativeJson } from '../dist/index.mjs';

const wireCopy = value => parseNativeJson(canonical(value));

test('detached state copy preserves the canonical wire contract including exact numbers and own keys', () => {
  const shared = { text: 'long source text\n'.repeat(10000), exact: 9007199254740993n, float: 1e20, negativeZero: -0 };
  const source = Object.assign(Object.create(null), { z: [shared, shared], a: 1n });
  Object.defineProperty(source, '__proto__', { value: { safe: true }, enumerable: true });
  const result = copy(source);
  assert.deepEqual(result, wireCopy(source));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(Object.keys(result), Object.keys(wireCopy(source)));
  assert.notEqual(result.z[0], shared); assert.notEqual(result.z[0], result.z[1]);
  result.z[0].text = 'changed'; assert.notEqual(result.z[1].text, 'changed');
  assert.equal(Object.is(result.z[1].negativeZero, -0), true);
  assert.equal(typeof result.a, 'number');
  assert.equal(Object.prototype.safe, undefined);
});

test('state copying does not broaden the accepted state value domain', () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, () => {}, Symbol(), NaN, Infinity, new Date(), new Map(), cycle, { missing: undefined }, [undefined], Array(2), BigInt('9'.repeat(4301))]) {
    assert.throws(() => wireCopy(value));
    assert.throws(() => copy(value));
  }
  const tooDeep = Array.from({length: 1025}).reduce(value => [value], 1);
  assert.throws(() => copy(tooDeep), { code: 'model_json_nesting_exceeded' });
  assert.throws(() => parseNativeJson('{"authority":1,"authority":2}'), { code: 'duplicate_model_json_key' });
});
