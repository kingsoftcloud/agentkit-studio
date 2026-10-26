import test from 'node:test';
import assert from 'node:assert/strict';
import { admitProviderToolSearchPolicy } from '../src/native/model-tool-search-policy.mjs';

test('provider tool search admits exact supported models or explicit custom Anthropic capability', () => {
  const input = { protocol: 'anthropic-messages', model: 'claude-sonnet-4-6', discovery: true };
  assert.equal(admitProviderToolSearchPolicy(input), 'anthropic-deferred/v1');
  assert.equal(admitProviderToolSearchPolicy({ ...input, requested: false }), 'local-only/v1');
  assert.equal(admitProviderToolSearchPolicy({ ...input, discovery: false }), 'local-only/v1');
  assert.equal(admitProviderToolSearchPolicy({ ...input, model: 'proxy-claude-sonnet-4-6' }), 'local-only/v1');
  assert.equal(admitProviderToolSearchPolicy({ ...input, model: 'custom', requested: true }), 'anthropic-deferred/v1');
  for (const protocol of ['openai-chat', 'openai-responses']) {
    assert.equal(admitProviderToolSearchPolicy({ ...input, protocol }), 'local-only/v1');
    assert.throws(() => admitProviderToolSearchPolicy({ ...input, protocol, requested: true }), /protocol_unsupported/);
  }
  for (const requested of ['true', null, 1, {}]) assert.throws(() => admitProviderToolSearchPolicy({ ...input, requested }), /invalid/);
});
