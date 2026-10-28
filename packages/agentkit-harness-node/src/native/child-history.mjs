import { nativeChildObservation, nativeChildActivity } from './child-observation.mjs';
import { nativeDeliveryId } from './delivery-timeline.mjs';
import { createHash } from 'node:crypto';
import { addUsage, canonical, copy, invariant, scopeKey, terminal, CHILD_OWNER_CONTRACT } from '@kingsoftcloud/agentkit-harness-core';
import { accountedChildDelivery, loadOwnedDirectChild } from './owned-child.mjs';

export const NATIVE_CHILD_HISTORY_CONTRACT = 'agentkit.studio-native-child-history/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const id = value => typeof value === 'string' && value.trim() && value.length <= 256;

function pageInventory(request, inventory) {
  const offset = request.offset ?? 0, limit = request.limit ?? 16;
  invariant(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 64
    && (request.inventoryDigest === undefined || typeof request.inventoryDigest === 'string'
      && /^[0-9a-f]{64}$/.test(request.inventoryDigest)), 'child_history_query_invalid');
  invariant((!offset || request.inventoryDigest)
    && (request.inventoryDigest === undefined || request.inventoryDigest === inventory.inventoryDigest), 'child_history_inventory_changed');
  invariant(offset <= inventory.tasks.length, 'child_history_offset_invalid');
  const tasks = inventory.tasks.slice(offset, offset + limit), nextOffset = offset + tasks.length;
  return { ...inventory, tasks, totalTasks: inventory.tasks.length, offset, nextOffset, complete: nextOffset === inventory.tasks.length };
}

/** Combine inventories supplied by trusted owners, never caller-selected stores
 * or principals. Keep each owner's ancestry order; the current owner comes first.
 * The digest binds every source, including heads without children. */
export function mergeNativeChildHistory(request, inventories) {
  invariant(id(request.sessionId) && request.runId === undefined && Array.isArray(inventories) && inventories.length > 0,
    'child_history_query_invalid');
  invariant(inventories.every(value => value.contract === NATIVE_CHILD_HISTORY_CONTRACT
    && value.sessionId === request.sessionId && (value.runId === null || id(value.runId)) && Array.isArray(value.tasks)),
  'child_history_ancestry_invalid');
  const present = inventories.filter(value => value.runId !== null);
  if (present.length <= 1) return pageInventory(request, present[0] ?? inventories[0]);
  const tasks = present.flatMap(value => value.tasks), runId = present[0].runId;
  // A public child ID must resolve to exactly one owner. Never silently choose
  // one ledger on collision or copy controls onto another owner's history.
  invariant(new Set(tasks.map(task => task.childRunId)).size === tasks.length, 'child_history_ancestry_invalid');
  const parents = new Set();
  for (const source of present) {
    const sourceParents = new Set([source.runId, ...source.tasks.map(task => task.parentRunId)]);
    invariant([...sourceParents].every(parent => !parents.has(parent)), 'child_history_ancestry_invalid');
    for (const parent of sourceParents) parents.add(parent);
  }
  const selected = tasks.map(task => task.parentRunId === runId ? task
    : { ...task, canPromote: false, canCancel: false, canSendInput: false });
  return pageInventory(request, { contract: NATIVE_CHILD_HISTORY_CONTRACT, sessionId: request.sessionId, runId,
    inventoryDigest: hash({ contract: 'agentkit.native-child-inventory-merge/v1', sessionId: request.sessionId,
      sources: present.map(value => [value.runId, value.inventoryDigest]) }), tasks: selected });
}

/** Read-only product history. No Kernel, factories, leases, commands or accounting writes. */
export function createNativeChildHistory({ scope, store, liveTasks = () => [], liveObservation = () => null }) {
  scopeKey(scope);
  const hierarchy = request => {
    invariant(id(request.sessionId) && (request.runId === undefined || id(request.runId)), 'child_history_query_invalid');
    const head = store.sessionHead(scope, request.sessionId), parents = [], seen = new Set();
    if (!head) {
      invariant(request.runId === undefined, 'child_history_run_unavailable');
      return { head: null, parents };
    }
    let cursor = head;
    while (cursor) {
      invariant(!seen.has(cursor.runId) && cursor.sessionId === request.sessionId
        && canonical(cursor.scope) === canonical(scope), 'child_history_ancestry_invalid');
      seen.add(cursor.runId);
      const parent = store.load(scope, cursor.runId);
      invariant(hash(parent.configuration) === cursor.configDigest, 'stored_configuration_mismatch');
      parents.push(parent);
      if (!cursor.parentRunId) break;
      cursor = store.load(scope, cursor.parentRunId).snapshot;
      invariant(terminal(cursor.phase), 'child_history_ancestry_invalid');
    }
    if (request.runId !== undefined) {
      const index = parents.findIndex(parent => parent.snapshot.runId === request.runId);
      invariant(index >= 0, 'child_history_run_unavailable');
      return { head: parents[index].snapshot, parents: parents.slice(index) };
    }
    return { head, parents };
  };
  const inventory = request => {
    const { head, parents } = hierarchy(request), records = [];
    for (const parent of parents) {
      // Historical grants come from the frozen original tool, never current
      // model arguments or a caller-provided child scope/role.
      const roles = [...new Set(parent.configuration.tools.filter(tool => ['start/v1', 'delegate/v1'].includes(tool.childBudgetPolicy))
        .flatMap(tool => tool.parameters.properties?.role?.enum ?? []))];
      invariant(roles.every(role => typeof role === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(role)), 'child_history_roles_invalid');
      const childScopes = roles.map(role => ({ ...scope, agentId: `${scope.agentId}:child:${role}` }));
      const children = [], descendants = new Set();
      for (const childRunId of parent.snapshot.childRunIds ?? []) {
        const child = loadOwnedDirectChild({ store, childScopes, parent: parent.snapshot, childRunId, roles });
        if (child) { children.push(child); for (const runId of child.snapshot.childRunIds ?? []) descendants.add(runId); }
      }
      const direct = new Set(children.map(child => child.snapshot.runId));
      invariant((parent.snapshot.childRunIds ?? []).every(runId => direct.has(runId) || descendants.has(runId)), 'child_history_not_available');
      const active = parent.snapshot.runId === head?.runId ? liveTasks(parent.snapshot.runId) : [];
      // The owning Kernel can authenticate a start before its parent receipt
      // commits. Such a row has controls, but never a settled delivery.
      for (const task of active) if (!direct.has(task.childRunId)) {
        const childScope = childScopes.find(item => item.agentId === `${scope.agentId}:child:${task.role}`);
        invariant(childScope, 'child_history_not_available');
        const child = store.load(childScope, task.childRunId);
        invariant(hash(child.configuration) === child.snapshot.configDigest, 'stored_configuration_mismatch');
        children.push(child); direct.add(task.childRunId);
      }
      for (const child of children) records.push({ parent, child, control: active.find(task => task.childRunId === child.snapshot.runId) });
    }
    return { head, records };
  };
  const taskRow = ({ parent, child, control }) => {
    const snapshot = child.snapshot, binding = child.configuration.childOwnerBinding;
    const accounted = Boolean(accountedChildDelivery(parent, child));
    const command = parent.commands.filter(row => ['message_child', 'cancel_child', 'promote_child'].includes(row.command.kind)
      && row.command.payload.childRunId === snapshot.runId).at(-1);
    const applied = command && parent.events.find(event => event.kind === 'command.applied' && event.payload.commandId === command.command.commandId);
    const lastControl = command ? { commandId: command.command.commandId, action: command.command.kind,
      status: !command.consumed ? 'pending' : ['queued', 'applied'].includes(applied?.payload.reason) ? 'delivered' : 'rejected',
      reason: applied?.payload.reason ?? (command.consumed ? 'parent_run_ended' : null) } : null;
    const a2aTasks = child.intents.filter(intent => intent.kind === 'tool').flatMap(intent => (intent.payload.calls ?? [])
      .filter(call => call.name === 'call_a2a_agent').map(call => ({ runId: parent.snapshot.runId, childRunId: snapshot.runId,
        childAgentId: snapshot.scope.agentId, childSessionId: snapshot.sessionId, operationKey: intent.operationKey, callId: call.callId })));
    return { parentToolCallId: nativeDeliveryId(parent.snapshot.scope, parent.snapshot.runId, `call:${binding.parentToolCallId}`),
      childRunId: snapshot.runId, sessionId: snapshot.sessionId, parentRunId: parent.snapshot.runId,
      ...(a2aTasks.length ? { a2aTasks } : {}),
      role: binding.role, phase: snapshot.phase, outcome: snapshot.outcome, reason: snapshot.reason,
      activity: nativeChildActivity(child),
      delivery: control?.delivery ?? (binding.deliveryMode === 'foreground'
        && !(parent.snapshot.promotedChildRunIds ?? []).includes(snapshot.runId) ? 'foreground' : 'background'),
      canPromote: control?.canPromote === true, canCancel: control?.canCancel === true, canSendInput: control?.canSendInput === true,
      goalRevision: snapshot.goalRevision,
      lastControl,
      goalPreview: [...snapshot.goal].slice(0, 256).join(''), goalComplete: [...snapshot.goal].length <= 256,
      snapshotRevision: snapshot.revision, resultAvailable: accounted,
      usage: addUsage(snapshot.usage, snapshot.descendantUsage),
      usageComplete: terminal(snapshot.phase) && snapshot.diagnostics.providerUsageIncomplete !== true && snapshot.diagnostics.descendantUsageIncomplete !== true,
      usageIncludedInParent: accounted, continuationOf: binding.continuationOf ?? null, buildId: snapshot.buildId };
  };
  const readInventory = request => {
    const { head, records } = inventory(request);
    return { contract: NATIVE_CHILD_HISTORY_CONTRACT, sessionId: request.sessionId, runId: head?.runId ?? null,
      inventoryDigest: hash({ scope, sessionId: request.sessionId, runId: head?.runId ?? null,
        children: records.map(({ parent, child }) => [parent.snapshot.runId, child.snapshot.runId]) }), tasks: records.map(taskRow) };
  };
  return {
    // Trusted Host composition only; public transports expose bounded list/result.
    inventory: readInventory,
    // Trusted Host fact lookup. Public list/result responses never expose the
    // full record, and a current parent's lookup cannot select an ancestor's child.
    record(request) {
      invariant(id(request.childRunId), 'child_history_query_invalid');
      const { head, records } = inventory(request);
      const found = records.find(({ parent, child }) => parent.snapshot.runId === head?.runId && child.snapshot.runId === request.childRunId);
      invariant(found, 'child_history_result_unavailable');
      const binding = found.child.configuration.childOwnerBinding, parent = found.parent.snapshot;
      invariant(binding?.contract === CHILD_OWNER_CONTRACT
        && canonical(binding.parent) === canonical(Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
          .map(key => [key, parent[key]])))
        && canonical(found.child.snapshot.scope) === canonical({ ...scope, agentId: `${scope.agentId}:child:${binding.role}` }),
      'child_history_ancestry_invalid');
      return copy(found.child);
    },
    list(request) {
      return pageInventory(request, readInventory(request));
    },
    result(request) {
      const offset = request.offset ?? 0, limit = request.limit ?? 4000;
      invariant(id(request.childRunId) && Number.isSafeInteger(offset) && offset >= 0
        && Number.isSafeInteger(limit) && limit >= 1 && limit <= 16000, 'child_history_query_invalid');
      const { head, records } = inventory(request), found = records.find(({ child }) => child.snapshot.runId === request.childRunId);
      invariant(found, 'child_history_result_unavailable');
      const task = taskRow(found), chars = task.resultAvailable ? [...found.child.snapshot.finalText] : [];
      invariant(offset <= chars.length, 'child_history_offset_invalid');
      const text = chars.slice(offset, offset + limit).join(''), nextOffset = offset + [...text].length;
      return { contract: NATIVE_CHILD_HISTORY_CONTRACT, sessionId: request.sessionId, runId: head.runId,
        observation: nativeChildObservation(found.child, liveObservation(found.child)),
        task, text, totalChars: chars.length, offset, nextOffset, complete: nextOffset === chars.length,
        resultDigest: task.resultAvailable ? hash(found.child.snapshot.finalText) : null, parentAcceptance: 'not_evaluated' };
    },
  };
}
