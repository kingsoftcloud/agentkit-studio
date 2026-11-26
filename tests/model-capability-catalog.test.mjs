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

test('same-family minor versions match the family entry, distinct models do not', () => {
  // deepseek-v4.1-flash is a minor release in the v4 line: it shares the family facts.
  const hit = lookupModelCapabilities({ ...star, modelName: 'deepseek-v4.1-flash' });
  assert.equal(hit.providerId, 'deepseek');
  assert.equal(hit.context, 1048576);
  assert.deepEqual(hit.efforts, ['low', 'high', 'max']);
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'deepseek-v4.1-flash-1017' }).providerId, 'deepseek');
  // glm-4.5 and glm-4.6 are distinct models, each resolved exactly (not merged).
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'glm-4.5' }).context, 131072);
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'glm-4.6' }).context, 204800);
  assert.equal(lookupModelCapabilities({ ...star, modelName: 'no-such-model-xyz' }), null);
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
