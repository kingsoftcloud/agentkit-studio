import type { ModelResult, RunConfiguration } from './contracts.mjs';
import { invariant } from './values.mjs';

/** Resolve once per committed retry. Explicit provider waits are never jittered. */
export function retryDelay(result: ModelResult, attempts: number, config: RunConfiguration, random: number): number {
  if (!['provider_retryable_error', 'empty_response', 'malformed_tool_call'].includes(result.kind)) return 0;
  invariant(Number.isSafeInteger(attempts) && attempts > 0, 'invalid_retry_counter');
  invariant(Number.isFinite(random) && random >= 0 && random <= 1, 'invalid_random_source');
  const profile = config.profile, cap = Math.min(profile.retryMaxDelayMs, 60_000);
  let floor = profile.retryInitialDelayMs;
  for (let index = 1; index < Math.min(attempts, 129); index++) {
    floor = Math.min(cap, floor * profile.retryBackoffMultiplier);
    if (floor >= cap) break;
  }
  if (result.retryAfterMs !== undefined) {
    invariant(Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0, 'invalid_retry_after');
    return Math.min(result.failureKind === 'rate_limit' ? 300_000 : cap, Math.max(floor, result.retryAfterMs));
  }
  const limit = result.failureKind === 'rate_limit' ? 300_000 : cap;
  if (result.failureKind === 'rate_limit') floor = Math.max(floor, profile.rateLimitCooldownMs);
  return floor <= 0 || floor >= limit ? floor : Math.min(limit, floor + floor * 0.25 * random);
}
