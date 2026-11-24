import assert from 'node:assert/strict';
import test from 'node:test';
import * as existing from '@kingsoftcloud/agentkit-harness-core';
import { canonical, copy, invariant, runKey, scopeKey } from '../src/contracts/native-values.mjs';
import { parseNativeJson, requiresExactJsonWire, stringifyModelJson } from '../src/contracts/native-json.mjs';

test('Studio Native contract values retain existing digests and historical scope keys', () => {
  const vectors = [null, false, '引擎', [0, -0, 1e30, 1n, 9007199254740993n],
    JSON.parse('{"__proto__":{"value":9},"1":"one","10":"ten","2":"two","b":[1],"a":true}'),
    Object.assign(Object.create(null), { b: 2, a: 1 })];
  for (const value of vectors) {
    assert.equal(canonical(value), existing.canonical(value));
    assert.deepEqual(copy(value), existing.copy(value));
  }
  const scope = { agentId: 'agent', userId: 'user', workspaceId: 'workspace', tenantId: 'tenant' };
  assert.equal(scopeKey(scope), existing.scopeKey(scope));
  assert.equal(runKey(scope, 'run-1'), existing.runKey(scope, 'run-1'));
  assert.equal(Object.getPrototypeOf(copy(vectors[4])), Object.prototype);
  assert.equal(Object.hasOwn(copy(vectors[4]), '__proto__'), true);
});

test('Studio keeps typed failures interoperable while rejecting unsupported values', () => {
  assert.throws(() => invariant(false, 'studio_test'), error => existing.isNativeError(error) && error.code === 'studio_test');
  assert.throws(() => canonical(Infinity), { code: 'non_json_number' });
  assert.throws(() => copy(new Date()), { code: 'non_json_object' });
  assert.throws(() => copy(new Array(1)), { code: 'invalid_model_json' });
  const cycle = { next: null };
  cycle.next = cycle;
  assert.throws(() => canonical(cycle), { code: 'non_json_value' });
  assert.throws(() => copy(cycle), { code: 'non_json_value' });
});

test('Studio Native JSON keeps persisted integers exact and refuses duplicate fields', () => {
  const encoded = '{"id":9007199254740993,"number":-0.0,"__proto__":{"own":true}}';
  const value = parseNativeJson(encoded);
  assert.deepEqual(value, existing.parseNativeJson(encoded));
  assert.equal(value.id, 9007199254740993n);
  assert.ok(Object.is(value.number, -0));
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(requiresExactJsonWire(value), true);
  assert.equal(stringifyModelJson(value), encoded);
  assert.throws(() => parseNativeJson('{"a":1,"\\u0061":2}'), { code: 'duplicate_model_json_key' });
  assert.throws(() => parseNativeJson('{"a":1} trailing'), { code: 'invalid_model_json' });
});
