import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CLOUD_MODEL, managedRuntimeModelConfig } from '../src/managed-runtime-model.mjs';

test('the model config repeats the declared model verbatim', () => {
  for (const model of ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']) {
    assert.deepEqual(managedRuntimeModelConfig(model), { Model: model, Mode: 'aicp' });
  }
});

test('the two real models stay distinct and neither becomes an alias', () => {
  const dated = managedRuntimeModelConfig('deepseek-v4.1-flash-1017').Model;
  const plain = managedRuntimeModelConfig('deepseek-v4.1-flash').Model;
  assert.equal(dated, 'deepseek-v4.1-flash-1017');
  assert.equal(plain, 'deepseek-v4.1-flash');
  assert.notEqual(dated, plain);
});

test('an omitted model falls back to the documented cloud default', () => {
  assert.equal(DEFAULT_CLOUD_MODEL, 'deepseek-v4.1-flash-1017');
  assert.equal(managedRuntimeModelConfig().Model, DEFAULT_CLOUD_MODEL);
});

test('an unusable model name fails instead of inheriting the platform default', () => {
  for (const model of ['', '   ', 'deepseek v4', '-leading-dash', 'x'.repeat(102), null]) {
    assert.throws(() => managedRuntimeModelConfig(model),
      error => error.code === 'MANAGED_RUNTIME_MODEL_INVALID', `expected ${JSON.stringify(model)} to be rejected`);
  }
});
