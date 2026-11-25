import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupModelCapabilities } from '../src/model-capability-catalog.mjs';
import { admitModelCapabilities } from '../src/model-capabilities.mjs';

const star = { baseUrl: 'http://kspmas.ksyun.com/v1', provider: 'custom' };

test('an exact endpoint match wins for a direct provider', () => {
  const hit = lookupModelCapabilities({ baseUrl: 'https://api.moonshot.cn/v1', provider: 'custom', modelName: 'kimi-k2.6' });
  assert.equal(hit.providerId, 'moonshotai-cn');
  assert.equal(hit.toggle, true);
  assert.equal(hit.context, 262144);
});

test('a private gateway resolves glm against the original vendor, not a reseller', () => {
  const hit = lookupModelCapabilities({ ...star, modelName: 'glm-5.3' });
  assert.equal(hit.providerId, 'zhipuai');
  assert.deepEqual(hit.efforts, ['low', 'high', 'max']);
  assert.equal(hit.context, 1000000);
  assert.equal(hit.output, 131072);
  assert.equal(hit.image, false);
});

test('vision-capable models are marked as such', () => {
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'glm-5.3-flash' }).image, true);
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'kimi-k3.1-pro-highspeed' }).image, true);
});

test('distinct model versions are never collapsed onto each other', () => {
  // deepseek-v4.1-flash is not in the catalog (which lists deepseek-v4-flash):
  // v4.1 must not be answered with v4's facts, even after dropping a build suffix.
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'deepseek-v4.1-flash' }), null);
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'deepseek-v4.1-flash-1017' }), null);
  const hit = lookupModelCapabilities({ ...star, modelName: 'deepseek-v4-flash' });
  assert.equal(hit.providerId, 'deepseek');
  assert.ok(hit.context > 0);
});

test('an unknown model returns null instead of guessing', () => {
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'no-such-model-xyz' }), null);
});

test('the catalog fills capacities the gateway does not report', () => {
  const fact = admitModelCapabilities({ ...star, modelName: 'glm-5.3' }, null);
  assert.equal(fact.contextWindow, 1000000);
  assert.equal(fact.advertisedContextWindow, 1000000);
  assert.equal(fact.advertisedMaxOutputTokens, 131072);
});

test('vendor-reported capacities still win over the catalog', () => {
  const fact = admitModelCapabilities({ ...star, modelName: 'glm-5.3' }, { context_length: 128000, max_output_tokens: 4096 });
  assert.equal(fact.contextWindow, 128000);
  assert.equal(fact.maxOutputTokens, 4096);
});
