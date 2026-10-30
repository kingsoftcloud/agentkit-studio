import { nativeDeliveryId } from './delivery-timeline.mjs';
import { advanceNativeToolObservation, nativeObservedToolStates } from './tool-observation.mjs';

/** A content-free display projection, never a tool execution authority. */
export function nativeToolStates(record, { driving = false } = {}) {
  if (!record) return null;
  return projectedNativeToolStates(advanceNativeToolObservation(null, record), record.snapshot, { driving });
}

export function projectedNativeToolStates(observation, snapshot, options) {
  return { contract: 'agentkit.native-tool-states/v1', runId: snapshot.runId,
    calls: nativeObservedToolStates(observation, snapshot, options).map(call => ({ ...call,
      callId: nativeDeliveryId(snapshot.scope, snapshot.runId, `call:${call.callId}`) })) };
}
