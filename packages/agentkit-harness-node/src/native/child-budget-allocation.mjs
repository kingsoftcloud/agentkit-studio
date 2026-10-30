import { NativeError } from '@kingsoftcloud/agentkit-harness-core';

/**
 * Opt-in child allocation policy. When a parent Run admits children under this
 * policy, omitted per-role and per-call limits defer to a bounded useful allowance
 * capped by the parent's actual remaining budget, instead of stacking two unrelated
 * 4-call defaults. Absent policy preserves the exact legacy limits, digests and cold
 * recovery.
 */
export const CHILD_ALLOCATION_POLICY = 'parent-shared/v1';

/** Bounded useful child allowance used when a role omits the limit under the policy. */
export const CHILD_ALLOCATION_DEFAULTS = Object.freeze({ modelCalls: 16, toolCalls: 64, timeoutSeconds: 900 });

/** Legacy call-level defaults applied when no allocation policy is active. */
export const LEGACY_CALL_DEFAULTS = Object.freeze({ modelCallLimit: 4, toolCallLimit: 8 });

const isPolicy = value => value === undefined || value === CHILD_ALLOCATION_POLICY;

/**
 * Role-level defaults for `nativeChildRoles`. Under the policy an omitted `maxTurns`
 * becomes the 16-call allowance (so the existing `maxTurns * 4` tool formula yields 64),
 * `timeoutSeconds` becomes 900s, and `maxToolCalls` stays `null` (the resolveChild
 * formula fills it). Legacy returns the historical 4 / null / 120 so old normalized
 * role shapes and digests are byte-identical. Unknown policies are rejected.
 */
export function roleAllocationDefaults(policy) {
  if (!isPolicy(policy)) throw new NativeError('studio_native_child_allocation_policy_invalid');
  if (policy === CHILD_ALLOCATION_POLICY) {
    return { maxTurns: CHILD_ALLOCATION_DEFAULTS.modelCalls, maxToolCalls: null,
      timeoutSeconds: CHILD_ALLOCATION_DEFAULTS.timeoutSeconds };
  }
  return { maxTurns: 4, maxToolCalls: null, timeoutSeconds: 120 };
}

/**
 * Resolve the call-level limits a parent tool invocation requests for a child, after
 * the call-level clamp but before the role-cap clamp (which `createNativeChildOwner`
 * applies via `binding.maxModelCalls = min(maxModelCalls, roleCap)`).
 *
 * Under the policy, omitted `modelCallLimit`/`toolCallLimit` defer (`null`) to the role
 * cap + remaining parent budget — the stacked 4/8 default is not applied. Under legacy,
 * omitted limits fall back to 4/8. Explicit user limits are always honored and
 * validated. Unknown policies are rejected.
 *
 * `availableTools` is intentionally kept signed (NOT clamped to 0): a `start/v1` call
 * with `maxToolCallsRemaining === 0` must be rejected before any child starts, so the
 * owner refuses admission rather than core rejecting the receipt after execution. The
 * caller checks `maxModelCalls > 0 && maxToolCalls >= 0` and the helper never produces an
 * `Infinity` that would cross a copied/serialized request or binding: when a remaining
 * budget is `null` (unlimited) and a limit is deferred, the allowance's finite cap is
 * used instead, so a standalone resolver with `null` role caps still admits a bounded
 * child rather than an unbounded one.
 */
export function resolveChildCallLimits({ policy, modelCallLimit, toolCallLimit, budget, childBudgetPolicy }) {
  if (!isPolicy(policy)) throw new NativeError('studio_native_child_allocation_policy_invalid');
  if (budget == null || typeof budget !== 'object') throw new NativeError('child_budget_invalid');
  const defer = policy === CHILD_ALLOCATION_POLICY;
  const modelLimit = defer ? (modelCallLimit ?? null) : (modelCallLimit ?? LEGACY_CALL_DEFAULTS.modelCallLimit);
  const toolLimit = defer ? (toolCallLimit ?? null) : (toolCallLimit ?? LEGACY_CALL_DEFAULTS.toolCallLimit);
  if (!((modelLimit === null || Number.isSafeInteger(modelLimit) && modelLimit >= 1)
      && (toolLimit === null || Number.isSafeInteger(toolLimit) && toolLimit >= 0))) {
    throw new NativeError('child_budget_invalid');
  }
  // start/v1 consumes one of the parent's remaining tool calls for the admission itself;
  // delegate/v1 does not. Keep the result signed so an exhausted parent is refused here.
  const reserve = childBudgetPolicy === 'start/v1' ? 1 : 0;
  const availableTools = budget.maxToolCallsRemaining === null ? null : budget.maxToolCallsRemaining - reserve;
  // Under the policy the allowance is the default ceiling: a deferred limit is capped by
  // the allowance, and the parent's remaining budget caps it further (min). An unlimited
  // parent leaves the allowance as the finite result. Under legacy, omitted limits fall
  // back to 4/8; an unlimited parent keeps 4/8, a bounded parent caps them. Explicit
  // limits always win and are capped by a bounded parent. No Infinity ever reaches a
  // copied or serialized request or binding: deferred-against-unlimited yields the finite
  // allowance, and every other branch is bounded by an explicit limit, the legacy 4/8,
  // or a bounded parent.
  const modelCeiling = defer ? CHILD_ALLOCATION_DEFAULTS.modelCalls : LEGACY_CALL_DEFAULTS.modelCallLimit;
  const toolCeiling = defer ? CHILD_ALLOCATION_DEFAULTS.toolCalls : LEGACY_CALL_DEFAULTS.toolCallLimit;
  const unlimited = { model: budget.maxModelCallsRemaining === null, tool: availableTools === null };
  const maxModelCalls = modelLimit === null
    ? (unlimited.model ? modelCeiling : Math.min(modelCeiling, budget.maxModelCallsRemaining))
    : (unlimited.model ? modelLimit : Math.min(modelLimit, budget.maxModelCallsRemaining));
  const maxToolCalls = toolLimit === null
    ? (unlimited.tool ? toolCeiling : Math.min(toolCeiling, availableTools))
    : (unlimited.tool ? toolLimit : Math.min(toolLimit, availableTools));
  return { maxModelCalls, maxToolCalls };
}
