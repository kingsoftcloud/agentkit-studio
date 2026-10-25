import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const STUDIO_NATIVE_TASK_POLICY_CONTRACT = 'agentkit.studio-native-task-policy/v1';
const WEB_SUFFIXES = ['.html', '.htm', '.js', '.jsx', '.css', '.ts', '.tsx'];

/** Product policy is pinned by the Agent revision/Build; it never extends time. */
export function bindNativeDeadlinePolicy(execution) {
  execution ??= {};
  invariant(typeof execution === 'object' && !Array.isArray(execution), 'studio_native_execution_invalid');
  const policy = execution.nativeWallDeliveryPolicy;
  invariant(policy == null || typeof policy === 'string' && /^deadline-delivery\/v[1-7]$/.test(policy), 'studio_native_deadline_policy_invalid');
  const active = policy != null || Object.hasOwn(execution, 'timeoutSeconds');
  if (!active) return { limits: {} };
  const seconds = Object.hasOwn(execution, 'timeoutSeconds') ? execution.timeoutSeconds : 300;
  invariant(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 3600, 'studio_native_deadline_timeout_invalid');
  // Reference composer passes RunLimits().effect_timeout_seconds (120), rather
  // than its later enlarged browser/subagent/transport effect timeout.
  const reserve = policy === 'deadline-delivery/v1' ? Math.min(60, Math.floor(seconds / 10))
    : policy ? Math.min(240, Math.floor(seconds / 2), Math.ceil(2 * 120)) : 0;
  return { wallDeliveryPolicy: policy ?? null, limits: { maxWallMs: seconds === 0 ? null : seconds * 1000,
    ...(policy ? { finalizationReserveWallMs: reserve * 1000,
      deliveryContextRecoveryPolicy: Number(policy.at(-1)) >= 4 ? 'delivery-window-summary/v2'
        : policy === 'deadline-delivery/v3' ? 'committed-write-summary/v1' : null } : {}) } };
}

/** Studio selects its web profile; the independent Kernel never guesses source types. */
export function bindNativeTaskPolicy({ tools, nativeLimits, vision = false, execution } = {}) {
  invariant(Array.isArray(tools), 'studio_native_task_tools_invalid');
  invariant(typeof vision === 'boolean', 'studio_native_task_vision_invalid');
  invariant(nativeLimits === undefined || nativeLimits !== null && typeof nativeLimits === 'object'
    && !Array.isArray(nativeLimits) && Object.keys(nativeLimits).every(key => ['maxModelCalls', 'maxToolCalls',
      'maxWallMs', 'finalizationReserveWallMs', 'deliveryContextRecoveryPolicy'].includes(key)),
  'studio_native_execution_limits_invalid');
  const deadline = bindNativeDeadlinePolicy(execution);
  invariant(!Object.keys(deadline.limits).some(key => nativeLimits && Object.hasOwn(nativeLimits, key)),
    'studio_native_deadline_limits_conflict');
  const maxWallMs = nativeLimits?.maxWallMs ?? null, reserve = nativeLimits?.finalizationReserveWallMs ?? 0;
  invariant((maxWallMs === null || Number.isSafeInteger(maxWallMs) && maxWallMs > 0 && maxWallMs <= 86400000)
    && Number.isSafeInteger(reserve) && reserve >= 0 && reserve <= 240000
    && (nativeLimits?.deliveryContextRecoveryPolicy == null || ['committed-write-summary/v1', 'delivery-window-summary/v2']
      .includes(nativeLimits.deliveryContextRecoveryPolicy)), 'studio_native_execution_limits_invalid');
  const maxModelCalls = nativeLimits?.maxModelCalls ?? null, maxToolCalls = nativeLimits?.maxToolCalls ?? null;
  invariant((maxModelCalls === null || Number.isSafeInteger(maxModelCalls) && maxModelCalls >= 1)
    && (maxToolCalls === null || Number.isSafeInteger(maxToolCalls) && maxToolCalls >= 0),
  'studio_native_execution_limits_invalid');
  const browser = tools.some(tool => tool.name === 'browser_inspect_workspace' && tool.observationRole === 'browser');
  return {
    ...(Object.hasOwn(deadline, 'wallDeliveryPolicy') ? { wallDeliveryPolicy: deadline.wallDeliveryPolicy } : {}),
    workspaceObservationPolicy: browser ? { role: 'browser', pathSuffixes: [...WEB_SUFFIXES] } : null,
    limits: {
      maxModelCalls, maxToolCalls,
      ...Object.fromEntries(['maxWallMs', 'finalizationReserveWallMs', 'deliveryContextRecoveryPolicy']
        .filter(key => nativeLimits && Object.hasOwn(nativeLimits, key)).map(key => [key, nativeLimits[key]])),
      ...deadline.limits,
      verificationReserveModelCalls: browser ? maxModelCalls === null ? 6 : Math.min(6, Math.max(1, Math.floor(maxModelCalls / 5))) : 0,
      browserObservationIntervalToolCalls: browser ? 12 : 0,
      verificationIdleToolCalls: browser ? 4 : 0,
      finalizationReserveModelCalls: maxModelCalls === null ? vision ? 2 : 1 : Math.min(vision ? 2 : 1, maxModelCalls),
      maxOutputRestarts: maxModelCalls === null || maxModelCalls >= 20 ? 1 : 0,
    },
  };
}
