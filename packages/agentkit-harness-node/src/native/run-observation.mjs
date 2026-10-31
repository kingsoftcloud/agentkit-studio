import { copy, reviewedBackgroundInterruption, reviewableBackgroundInterruption,
  reviewedResourceInterruption, retirableBrowserResources } from '@kingsoftcloud/agentkit-harness-core';
import { projectedNativeToolStates } from './tool-states.mjs';
import { advanceNativeToolObservation, nativeObservedToolStates } from './tool-observation.mjs';
import { nativeContextStatus } from './context-status.mjs';
import { nativeActivityStatus } from './activity-status.mjs';
import { nativeA2aReceiptWaitSource } from './a2a-receipt-source.mjs';
import { canCloseNativeReadInterruption } from './read-interruption.mjs';
import { advanceNativeContextMarkerState, nativeContextMarkerFactsFromState } from './context-markers.mjs';

export const NATIVE_RUN_OBSERVATION = 'agentkit.native-run-observation/v1';
export const NATIVE_COMMIT_PROJECTION = 'agentkit.native-commit-projection/v2';

function contextProjection(previous, record) {
  let lastPlan = previous?.lastPlan ?? null, lastAdmission = previous?.lastAdmission ?? null;
  for (const event of record.events ?? []) if (event.kind === 'context.planned') {
    lastPlan = { kind: event.kind, seq: event.seq, payload: { action: event.payload.action } };
    if (event.payload.admission) lastAdmission = { kind: event.kind, seq: event.seq,
      payload: { admission: event.payload.admission } };
  }
  return { lastPlan, lastAdmission, markers: advanceNativeContextMarkerState(previous?.markers, record) };
}

function observationHeader(s) {
  const header = Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId',
    'configDigest', 'phase', 'revision', 'eventSeq', 'usage', 'descendantUsage', 'outcome', 'reason', 'pendingIntent',
    'toolReconciliation'].filter(key => s[key] !== undefined).map(key => [key, s[key]]));
  header.diagnostics = Object.fromEntries(['providerUsageIncomplete', 'descendantUsageIncomplete', 'lastModelFailure']
    .filter(key => s.diagnostics[key] !== undefined).map(key => [key, s.diagnostics[key]]));
  return header;
}

/** A control transaction changes no transcript, receipt or event. Its display
 * consequence is derived from current authority, never used as execution input. */
export function advanceNativeRunControlObservation(previous, state, changes) {
  const view = copy(previous);
  if (changes.claim) {
    view.snapshot = observationHeader(changes.claim.snapshot);
    const intent = changes.claim.intent;
    view.facts.pendingEffect = { operationKey: intent.operationKey, kind: intent.kind, status: intent.status,
      claimedFence: intent.claimedFence ?? null, receiptPresent: state.pendingIntentHasReceipt,
      calls: (intent.payload.calls ?? []).map(({ callId, name }) => ({ callId, name })) };
    view.commitProjection.tools = advanceNativeToolObservation(view.commitProjection.tools, { intents: [intent] });
    for (const mode of ['idle', 'driving']) view.facts.toolStates[mode] = projectedNativeToolStates(
      view.commitProjection.tools, changes.claim.snapshot, { driving: mode === 'driving' });
  }
  view.projections = copy(changes.projections ?? state.projections);
  if (changes.commands?.some(row => !row.consumed)) {
    view.facts.controlHints.reviewBackground = false;
    view.facts.controlHints.retireResources = false;
    view.facts.backgroundReview = null;
    view.facts.resourceReview = null;
  }
  view.lease = copy(state.lease); view.fence = state.fence;
  return copy(view);
}

/** Materialize a display read model inside the same ledger transaction.
 * No transcript, model replay, tool arguments/results, image bytes or ports.
 * Control hints are for display only: every control re-reads its original ledger.
 */
export function projectNativeRunObservation(record, tools = advanceNativeToolObservation(null, record)) {
  const { snapshot: s, configuration: c } = record;
  const header = observationHeader(s);
  const receiptWait = nativeA2aReceiptWaitSource(record);
  const pending = record.intents.find(i => i.operationKey === s.pendingIntent);
  const resourceReviewed = reviewedResourceInterruption(record);
  const backgroundReviewed = reviewedBackgroundInterruption(record);
  const toolOutcomes = nativeObservedToolStates(tools, s).filter(call => ['uncertain', 'not_dispatched'].includes(call.status));
  const facts = {
    toolStates: { idle: projectedNativeToolStates(tools, s), driving: projectedNativeToolStates(tools, s, { driving: true }) },
    contextStatus: { idle: nativeContextStatus(record), driving: nativeContextStatus(record, { driving: true }) },
    activity: nativeActivityStatus(record),
    acceptance: c.contract.acceptance.map(({ required, verifierRef }) => ({ required, verifierRef })),
    toolNames: c.tools.map(tool => tool.name),
    a2aTasks: record.intents.filter(i => i.kind === 'tool').flatMap(i => (i.payload.calls ?? [])
      .filter(call => call.name === 'call_a2a_agent').map(call => ({ runId: s.runId, operationKey: i.operationKey, callId: call.callId }))),
    uncertainCalls: toolOutcomes.filter(row => row.status === 'uncertain').map(({ callId }) => ({ callId })),
    toolOutcomes,
    receiptWait: receiptWait ? { operationKey: receiptWait.intent.operationKey, callId: receiptWait.call.callId } : null,
    pendingEffect: pending ? { operationKey: pending.operationKey, kind: pending.kind, status: pending.status,
      claimedFence: pending.claimedFence ?? null, receiptPresent: record.receipts.some(r => r.operationKey === pending.operationKey),
      calls: (pending.payload.calls ?? []).map(({ callId, name }) => ({ callId, name })) } : null,
    controlHints: {
      closeReadInterruption: canCloseNativeReadInterruption(record),
      reviewBackground: reviewableBackgroundInterruption(record),
      retireResources: Boolean(retirableBrowserResources(record)),
      repairWorkspace: c.tools.some(tool => tool.name === s.pendingTools[0]?.name && tool.workspaceRepairPolicy === 'preimage-compensation/v1'),
    },
    backgroundReview: backgroundReviewed ? record.backgroundInterruptionReview : null,
    resourceReview: resourceReviewed ? { contract: 'agentkit.resource-retirement-review/v1',
      commandId: record.resourceRetirementReview.commandId, eventSeq: record.resourceRetirementReview.eventSeq,
      resourceKind: record.resourceRetirementReview.fence.resourceKind } : null,
  };
  return copy({ contract: NATIVE_RUN_OBSERVATION, snapshot: header, lease: record.lease, fence: record.fence,
    projections: record.projections, facts,
    commitProjection: { contract: NATIVE_COMMIT_PROJECTION, context: contextProjection(null, record), tools } });
}

/** Advance display facts from a validated append. These facts are never used
 * as execution authority. Exceptional recovery keeps the complete-ledger path. */
export function advanceNativeRunCommitObservation(previous, state, changes) {
  const record = { ...state, snapshot: changes.snapshot, events: changes.events,
    intents: [...state.intents, ...changes.intents], receipts: changes.receipts,
    commands: changes.commands, projections: previous.projections };
  const context = contextProjection(previous.commitProjection.context, record);
  const tools = advanceNativeToolObservation(previous.commitProjection.tools, record);
  const view = projectNativeRunObservation(record, tools);
  const merge = (old, next, key) => [...new Map([...old, ...next].map(item => [key(item), item])).values()];
  view.facts.a2aTasks = merge(previous.facts.a2aTasks, view.facts.a2aTasks, row => row.callId);
  const contextRecord = { ...record, events: [context.lastAdmission, context.lastPlan].filter(Boolean) };
  for (const mode of ['idle', 'driving']) {
    const options = { driving: mode === 'driving' };
    view.facts.contextStatus[mode] = nativeContextStatus(contextRecord, options);
    if (view.facts.contextStatus[mode]) view.facts.contextStatus[mode].markers =
      nativeContextMarkerFactsFromState(context.markers, record.snapshot, options).map(fact => fact.marker);
  }
  const observed = new Set(changes.events.filter(event => event.kind === 'background.commands_observed')
    .flatMap(event => (event.payload.commands ?? []).map(command => command.taskId)));
  const terminals = new Map(previous.facts.activity.terminals.map(row => [row.id, row]));
  view.facts.activity.terminals = view.facts.activity.terminals.map(row => {
    const old = terminals.get(row.id);
    return !old ? row : { ...row, title: row.title === row.id ? old.title : row.title,
      state: observed.has(row.id) ? row.state : old.state };
  });
  view.commitProjection = { contract: NATIVE_COMMIT_PROJECTION, context, tools };
  return view;
}
