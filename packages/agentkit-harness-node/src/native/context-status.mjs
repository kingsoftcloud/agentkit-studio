import { nativeContextMarkers } from './context-markers.mjs';
/** Bounded, content-free view of the committed context planner. Read-only. */
export function nativeContextStatus(record, { driving = false } = {}) {
  if (!record?.configuration.contextPolicy) return null;
  const { snapshot, configuration, events = [] } = record;
  let admission = null, lastAction = null, admissionSeq = null;
  for (const event of events) if (event.kind === 'context.planned') {
    lastAction = event.payload.action;
    if (event.payload.admission) { admission = event.payload.admission; admissionSeq = event.seq; }
  }
  const policy = configuration.contextPolicy;
  const state = snapshot.contextState;
  // A proposal/model response is not a committed, adopted compaction.
  const count = Number.isSafeInteger(state?.compactions) ? state.compactions : 0;
  const compacting = snapshot.phase === 'compacting' || Boolean(state?.compaction);
  return {
    contract: 'agentkit.native-context-status/v1', runId: snapshot.runId, snapshotRevision: snapshot.revision,
    enabled: policy.enabled, thresholdRatio: policy.triggerRatio, targetRatio: policy.targetRatio,
    contextWindow: configuration.profile.contextWindow,
    reservedOutputTokens: configuration.profile.maxOutputTokens,
    lastRequestInputTokens: admission?.countedInputTokens ?? null,
    lastAdmissionSeq: admissionSeq,
    compactions: count,
    markers: nativeContextMarkers(record, { driving }),
    state: lastAction === 'blocked' ? 'blocked' : compacting ? driving ? 'compacting' : 'interrupted' : 'idle',
  };
}
