import { invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';

export const STUDIO_NATIVE_TASK_POLICY_CONTRACT = 'agentkit.studio-native-task-policy/v1';
const WEB_SUFFIXES = ['.html', '.htm', '.js', '.jsx', '.css', '.ts', '.tsx'];

/** Studio selects its web profile; the independent Kernel never guesses source types. */
export function bindNativeTaskPolicy({ tools, nativeLimits, vision = false } = {}) {
  invariant(Array.isArray(tools), 'studio_native_task_tools_invalid');
  invariant(typeof vision === 'boolean', 'studio_native_task_vision_invalid');
  invariant(nativeLimits === undefined || nativeLimits !== null && typeof nativeLimits === 'object'
    && !Array.isArray(nativeLimits) && Object.keys(nativeLimits).every(key => ['maxModelCalls', 'maxToolCalls',
      'maxWallMs', 'finalizationReserveWallMs', 'deliveryContextRecoveryPolicy'].includes(key)),
  'studio_native_execution_limits_invalid');
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
    workspaceObservationPolicy: browser ? { role: 'browser', pathSuffixes: [...WEB_SUFFIXES] } : null,
    limits: {
      maxModelCalls, maxToolCalls,
      ...Object.fromEntries(['maxWallMs', 'finalizationReserveWallMs', 'deliveryContextRecoveryPolicy']
        .filter(key => nativeLimits && Object.hasOwn(nativeLimits, key)).map(key => [key, nativeLimits[key]])),
      verificationReserveModelCalls: browser ? maxModelCalls === null ? 6 : Math.min(6, Math.max(1, Math.floor(maxModelCalls / 5))) : 0,
      browserObservationIntervalToolCalls: browser ? 12 : 0,
      verificationIdleToolCalls: browser ? 4 : 0,
      finalizationReserveModelCalls: maxModelCalls === null ? vision ? 2 : 1 : Math.min(vision ? 2 : 1, maxModelCalls),
      maxOutputRestarts: maxModelCalls === null || maxModelCalls >= 20 ? 1 : 0,
    },
  };
}
