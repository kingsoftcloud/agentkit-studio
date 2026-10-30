import { createHash } from 'node:crypto';
import { CHILD_OWNER_CONTRACT, canonical, copy, terminal } from '@kingsoftcloud/agentkit-harness-core';

const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left, right) => canonical(left) === canonical(right);
const identity = value => Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
  .map(key => [key, copy(value[key])]));

/** A saved decision awaiting consumption is runnable work, not a new request
 * for approval. This observation grants nothing: the child Kernel still checks
 * and consumes the original command against its own pending interaction. */
export function childNeedsApproval(record) {
  const pending = record.snapshot.pendingInteraction;
  return record.snapshot.phase === 'awaiting_interaction' && (!pending || !record.commands.some(row => !row.consumed
    && row.command.kind === 'submit_interaction' && row.command.payload.interactionId === pending?.interactionId
    && ['allow', 'deny'].includes(row.command.payload.decision)));
}

export function resolveChildToolIntent(parentRecord, operationKey) {
  const intent = parentRecord.intents.find(item => item.operationKey === operationKey);
  if (intent && Array.isArray(intent.payload.calls) && intent.payload.calls.length === 1)
    return { intent, calls: intent.payload.calls, index: 0, base: operationKey };
  const match = operationKey.match(/^(.+):call:([1-9][0-9]*)$/);
  if (!match) return null;
  const base = match[1], index = Number(match[2]) - 1;
  const baseIntent = parentRecord.intents.find(item => item.operationKey === base);
  return baseIntent?.kind === 'tool' && Array.isArray(baseIntent.payload.calls) && baseIntent.payload.calls.length > 1
    && Number.isSafeInteger(index) && index < baseIntent.payload.calls.length
    ? { intent: baseIntent, calls: baseIntent.payload.calls, index, base } : null;
}

/** Locators confer no authority: prove the original causal binding and committed start receipt. */
export function loadOwnedDirectChild({ store, childScopes, parent, childRunId, roles }) {
  if (!(parent.childRunIds ?? []).includes(childRunId)) return null;
  const parentRecord = store.load(parent.scope, parent.runId);
  for (const childScope of childScopes) {
    let record;
    try { record = store.load(childScope, childRunId); }
    catch (error) { if (error.code === 'run_not_found') continue; throw error; }
    const binding = record.configuration.childOwnerBinding;
    if (binding?.contract !== CHILD_OWNER_CONTRACT || !same(record.snapshot.scope, childScope)
      || !same(binding.parent, identity(parent)) || roles && !roles.includes(binding.role)) continue;
    const reservation = (parent.childBudgetReservations ?? []).find(item => item.childRunId === childRunId);
    if (!reservation || !same(reservation.childScope, childScope)
      || reservation.parentOperationKey !== binding.parentOperationKey || reservation.parentToolCallId !== binding.parentToolCallId
      || reservation.childRequestDigest !== binding.childRequestDigest || reservation.deliveryMode !== binding.deliveryMode
      || reservation.configurationDigest !== record.snapshot.configDigest || hash(record.configuration) !== reservation.configurationDigest
      || reservation.maxModelCalls !== binding.maxModelCalls || reservation.maxToolCalls !== binding.maxToolCalls) continue;
    const start = resolveChildToolIntent(parentRecord, binding.parentOperationKey), call = start?.calls[start.index];
    const receipt = parentRecord.receipts.find(item => item.operationKey === start?.base && item.status === 'committed');
    const original = receipt?.result.results?.[start?.index]?.childBudgetReservation;
    if (start?.intent.kind !== 'tool' || !call || !['native_start_child', 'native_delegate'].includes(call.name)
      || call.callId !== binding.parentToolCallId || call.arguments.role !== binding.role
      || call.arguments.task !== record.configuration.contract.objective
      || !original || !same(original, { ...reservation, settledUsageDigest: null })) continue;
    return record;
  }
  return null;
}

export function hasUnsafeChildReceipt(record) {
  const reconciled = intent => {
    const original = intent?.kind === 'tool_receipt'
      ? record.intents.find(row => row.operationKey === intent.payload.originalOperationKey) : intent;
    const call = original?.payload.calls?.[0];
    if (original?.kind !== 'tool' || original.status !== 'running' || original.payload.calls.length !== 1
      || !Number.isSafeInteger(original.claimedFence) || original.claimedFence <= 0
      || record.configuration.tools.find(tool => tool.name === call.name)?.recoveryPolicy !== 'receipt-observation/v1') return false;
    if (intent.kind === 'tool_receipt' && (intent.payload.contract !== 'agentkit.tool-receipt-observation/v1'
      || intent.payload.callId !== call.callId || intent.payload.originalClaimedFence !== original.claimedFence)) return false;
    return record.intents.some(query => {
      const p = query.payload;
      if (query.kind !== 'tool_receipt' || query.status !== 'running' || p.contract !== 'agentkit.tool-receipt-observation/v1'
        || p.originalOperationKey !== original.operationKey || p.callId !== call.callId || p.originalClaimedFence !== original.claimedFence) return false;
      const receipt = record.receipts.find(row => row.operationKey === query.operationKey);
      return receipt?.status === 'committed' && receipt.result.contract === p.contract
        && receipt.result.originalOperationKey === original.operationKey && receipt.result.callId === call.callId
        && ['ok', 'error'].includes(receipt.result.result?.status);
    });
  };
  return record.receipts.some(receipt => receipt.status === 'uncertain'
    && !(receipt.result.retryScheduled === true && ['safe-read/v1', 'workspace-observation/v1'].includes(receipt.result.recoveryPolicy))
    && record.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind !== 'model'
    && !reconciled(record.intents.find(intent => intent.operationKey === receipt.operationKey)));
}

/** A settled marker alone cannot authorize delivery or reuse of a Session. */
export function accountedChildDelivery(parentRecord, childRecord) {
  const child = childRecord.snapshot;
  if (!terminal(child.phase) || child.phase === 'interrupted' || hasUnsafeChildReceipt(childRecord)) return null;
  const reservation = parentRecord.snapshot.childBudgetReservations.find(item => item.childRunId === child.runId);
  if (!reservation?.settledUsageDigest) return null;
  return parentRecord.receipts.filter(receipt => receipt.status === 'committed').flatMap(receipt => receipt.result.results ?? [])
    .find(result => result.childBudgetSettlement?.childRunId === child.runId
      && result.childBudgetSettlement.terminalSnapshotDigest === hash(child)
      && hash({ settlement: result.childBudgetSettlement, usage: result.resourceUsage, childRunIds: result.childRunIds })
        === reservation.settledUsageDigest) ?? null;
}

/** Only terminal ancestors in this exact parent Session may grant their original child. */
export function loadSessionChild({ store, childScopes, parent, childRunId }) {
  const seen = new Set();
  for (let cursor = parent; cursor && !seen.has(cursor.runId);) {
    seen.add(cursor.runId);
    const child = loadOwnedDirectChild({ store, childScopes, parent: cursor, childRunId });
    if (child) return { child, parent: store.load(cursor.scope, cursor.runId) };
    if (!cursor.parentRunId) return null;
    const previous = store.load(parent.scope, cursor.parentRunId);
    if (!same(previous.snapshot.scope, parent.scope) || previous.snapshot.sessionId !== parent.sessionId
      || !terminal(previous.snapshot.phase)) return null;
    cursor = previous.snapshot;
  }
  return null;
}
