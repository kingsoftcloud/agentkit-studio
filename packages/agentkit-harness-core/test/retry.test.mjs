import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retryDelay, emptyUsage } from '../dist/index.mjs';
import { fixture } from './fixtures.mjs';

test('retry timing matches the captured Python floor, explicit server wait and rate-limit semantics', () => {
  const oracle = JSON.parse(readFileSync(new URL('../../../tests/fixtures/native-reference.json', import.meta.url)))
    .scenarios.find(scenario => scenario.id === 'retry_delay_pure').normalized_output;
  const { config } = fixture();
  Object.assign(config.profile, { retryInitialDelayMs: 1000, retryMaxDelayMs: 8000,
    retryBackoffMultiplier: 2, rateLimitCooldownMs: 5000 });
  const response = { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage(), failureKind: 'rate_limit' };
  assert.equal(retryDelay(response, 1, config, 0.5) / 1000, oracle.rate_limit_with_cooldown);
  assert.equal(retryDelay({ ...response, retryAfterMs: 12000 }, 1, config, 1) / 1000, oracle.explicit_server_wait_preserved);
  assert.equal(retryDelay({ ...response, kind: 'final_candidate' }, 1, config, 1), oracle.non_retryable_delay);
  const regular = { ...response, failureKind: 'transport' };
  assert.equal(retryDelay(regular, 2, config, 0), 2000);
  assert.equal(retryDelay(regular, 2, config, 1), 2500);
  assert.equal(retryDelay(regular, 2, config, 0.5), 2250);
  assert.equal(retryDelay(regular, Number.MAX_SAFE_INTEGER, config, 1), 8000);
  assert.equal(retryDelay({ ...regular, retryAfterMs: 3000 }, 1, config, 0.9), 3000);
});
