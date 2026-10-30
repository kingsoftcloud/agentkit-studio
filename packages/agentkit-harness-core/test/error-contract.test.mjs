import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeError, isNativeError } from '../dist/index.mjs';

// A second evaluated module has a genuinely different constructor, just as a
// separately installed npm package does. No test-only registration is needed.
const foreign = await import(new URL('../dist/values.mjs?independent-error-contract', import.meta.url));

test('the Native error contract crosses module instances in both directions', () => {
  assert.notEqual(NativeError, foreign.NativeError);
  const local = new NativeError('run_not_found'), remote = new foreign.NativeError('stale_fence');
  assert.equal(remote instanceof NativeError, false);
  assert.equal(local instanceof foreign.NativeError, false);
  assert.equal(isNativeError(remote), true);assert.equal(foreign.isNativeError(local), true);
  assert.equal(isNativeError(local), true);assert.equal(isNativeError(new TypeError('run_not_found')), false);
});

test('serialized and ordinary named exceptions cannot acquire Native control semantics', () => {
  const lookalike = Object.assign(new Error('untrusted'), { name: 'NativeError', code: 'run_not_found' });
  for (const value of [lookalike, JSON.parse(JSON.stringify(new NativeError('run_not_found'))),
    { name: 'NativeError', code: 'stale_fence' }, null, undefined, 'run_not_found', 0])
    assert.equal(isNativeError(value), false);
  const error = new foreign.NativeError('run_not_found');
  assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: 'run_not_found', name: 'NativeError' });
});

test('checking a foreign exception never reads its accessors or propagates a proxy trap', () => {
  let reads = 0;
  const getter = Object.assign(new Error('untrusted'), { name: 'NativeError' });
  Object.defineProperty(getter, 'code', { get() { reads++; throw Error('private accessor'); } });
  assert.equal(isNativeError(getter), false);assert.equal(reads, 0);
  assert.equal(isNativeError(new Proxy({}, { getPrototypeOf() { throw Error('private proxy'); } })), false);
  const marker = Symbol.for('@kingsoftcloud/agentkit-harness-core/NativeError/v1');
  const mutable = Object.assign(new Error('untrusted'), { name: 'NativeError', code: 'run_not_found', [marker]: true });
  assert.equal(isNativeError(mutable), false);
});
