import type { RunAuthority, RunToolAuthority } from './contracts.mjs';

export const TOOL_AUTHORITY_SNAPSHOT_FIELDS = ['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId',
  'phase', 'pendingIntent', 'configDigest', 'goalRevision', 'goal', 'planMode', 'sourceReadQuote', 'conversationBranch'] as const;
export const TOOL_AUTHORITY_CONFIGURATION_FIELDS = ['tools', 'artifactPolicy', 'sourceReadPolicy', 'contextPolicy', 'planModePolicy', 'limits', 'hostBindingDigest'] as const;
function pick<T extends object, K extends keyof T>(object: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]])) as Pick<T, K>;
}

/** Immutable projection of current authority, not a replacement full snapshot. */
export function projectRunToolAuthority(current: RunAuthority): RunToolAuthority {
  let sourceReadMessage: RunToolAuthority['sourceReadMessage'] = null;
  if (current.snapshot.sourceReadQuote) for (let index = current.snapshot.messages.length - 1; index >= 0; index--) {
    const message = current.snapshot.messages[index]!;
    if (message.role === 'assistant' && message.toolCalls?.length) { sourceReadMessage = message; break; }
  }
  return { snapshot: pick(current.snapshot, TOOL_AUTHORITY_SNAPSHOT_FIELDS),
    configuration: pick(current.configuration, TOOL_AUTHORITY_CONFIGURATION_FIELDS),
    splitModelObservation: Boolean(current.configuration.modelSurface),
    sourceReadMessage, pendingIntent: current.snapshot.phase === 'executing_tools' ? current.pendingIntent : null,
    lease: current.lease, fence: current.fence };
}
