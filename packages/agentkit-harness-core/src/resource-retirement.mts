import type { StoredRun } from './contracts.mjs';
import type { BrowserSessionRef } from './browser-contract.mjs';
import { validateBrowserSessionRef } from './browser-contract.mjs';
import { backgroundCommandObservation } from './background-contract.mjs';
import { canonical, invariant } from './values.mjs';

/** A trusted owner fences its disposable resource namespace, not the effect's
 * outcome. External writes, commands, children and unknown claims cannot use it. */
export interface ResourceFence {
  contract: 'agentkit.resource-fence/v1'; resourceKind: 'ephemeral-browser';
  scope: BrowserSessionRef['scope']; runId: string; sessionId: string;
  refs: BrowserSessionRef[]; fenced: true; externalEffects: false; oldActionsReplayed: false;
}
export interface ResourceRetirementReview {
  contract: 'agentkit.resource-retirement-review/v1'; commandId: string; eventSeq: number; fence: ResourceFence;
}

export function retirableBrowserResources(record: StoredRun): BrowserSessionRef[] | null {
  try {
    const s = record.snapshot;
    if (s.phase !== 'interrupted' || s.reason !== 'effect_outcome_unknown' || s.pendingIntent || s.toolReconciliation
      || s.children.some(child => !['completed', 'failed', 'canceled'].includes(child.state))
      || s.childBudgetReservations.some(row => row.settledUsageDigest === null)
      || s.backgroundCommands.some(row => !row.notified) || record.commands.some(row => !row.consumed)) return null;
    const completedBackground = new Map(s.messages.filter(message => message.kind === 'background_command_observation')
      .flatMap(message => (JSON.parse(message.content).commands as unknown[]).map(value => {
        const row = backgroundCommandObservation(value); return [canonical(row.ref), row.status] as const;
      })));
    if (s.backgroundCommands.some(row => !['completed', 'failed', 'canceled', 'timed_out', 'output_limit']
      .includes(completedBackground.get(canonical(row.ref)) ?? ''))) return null;
    if (record.intents.some(intent => intent.status === 'running'
      && !record.receipts.some(receipt => receipt.operationKey === intent.operationKey))) return null;
    const refs = (s.browserSessionRefs ?? []).map(validateBrowserSessionRef);
    if (!refs.length || refs.length > 16 || refs.some(ref => ref.runId !== s.runId || canonical(ref.scope) !== canonical(s.scope))) return null;
    let unknown = 0;
    for (const receipt of record.receipts) {
      const results = Array.isArray(receipt.result.results) ? receipt.result.results : [];
      if (receipt.status !== 'uncertain' && !results.some(row => row && typeof row === 'object' && !Array.isArray(row) && row.status === 'uncertain')) continue;
      const intent = record.intents.find(row => row.operationKey === receipt.operationKey);
      if (intent?.kind !== 'tool' || !Array.isArray(intent.payload.calls)) return null;
      // A claimed action can lose its complete owner response before commit.
      // Kernel recovery records that loss without fabricating per-call results.
      // The trusted owner must still fence the entire Run namespace, including
      // a page generation whose reply was never persisted. A known prior owner
      // reference and one exact browser call are required; this is not replay.
      if (receipt.status === 'uncertain' && !results.length && intent.payload.calls.length === 1
        && intent.status === 'running' && Number.isSafeInteger(intent.claimedFence) && intent.claimedFence! > 0
        && Number.isFinite(intent.claimedAtMs) && receipt.result.code === 'effect_outcome_unknown'
        && receipt.result.recoveryPolicy === null && receipt.result.retryScheduled === false
        && Object.keys(receipt.result).sort().join(',') === 'code,recoveryPolicy,retryScheduled') {
        const call = intent.payload.calls[0];
        if (!call || typeof call !== 'object' || Array.isArray(call)
          || record.configuration.tools.find(tool => tool.name === call.name)?.observationRole !== 'browser') return null;
        unknown++; continue;
      }
      if (results.length !== intent.payload.calls.length) return null;
      let receiptUnknown = 0;
      for (const [index, result] of results.entries()) {
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.status !== 'uncertain') continue;
        const call = intent.payload.calls[index];
        if (!call || typeof call !== 'object' || Array.isArray(call)
          || record.configuration.tools.find(tool => tool.name === call.name)?.observationRole !== 'browser') return null;
        const ref = validateBrowserSessionRef(result.browserSessionRef);
        if (!refs.some(row => canonical(row) === canonical(ref))) return null;
        unknown++; receiptUnknown++;
      }
      if (!receiptUnknown) return null;
    }
    return unknown ? refs : null;
  } catch { return null; }
}

export function validateResourceRetirement(record: StoredRun, review: ResourceRetirementReview): ResourceRetirementReview {
  const refs = retirableBrowserResources(record), s = record.snapshot, fence = review?.fence;
  invariant(refs && review?.contract === 'agentkit.resource-retirement-review/v1'
    && Object.keys(review).sort().join(',') === 'commandId,contract,eventSeq,fence'
    && typeof review.commandId === 'string' && !!review.commandId.trim() && review.commandId.length <= 256
    && review.eventSeq === s.eventSeq && fence?.contract === 'agentkit.resource-fence/v1'
    && Object.keys(fence).sort().join(',') === 'contract,externalEffects,fenced,oldActionsReplayed,refs,resourceKind,runId,scope,sessionId'
    && fence.resourceKind === 'ephemeral-browser' && fence.fenced === true && fence.externalEffects === false
    && fence.oldActionsReplayed === false && fence.runId === s.runId && fence.sessionId === s.sessionId
    && canonical(fence.scope) === canonical(s.scope) && canonical(fence.refs) === canonical(refs), 'invalid_resource_retirement');
  return structuredClone(review);
}

export function reviewedResourceInterruption(record: StoredRun): boolean {
  if (!record.resourceRetirementReview) return false;
  try { validateResourceRetirement(record, record.resourceRetirementReview); return true; } catch { return false; }
}
