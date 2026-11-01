import { canonical } from '@kingsoftcloud/agentkit-harness-core';
import { nativeDeliveryId } from '@kingsoftcloud/agentkit-harness-node/native/delivery-timeline';
import { createCommandProgressObserver } from '@kingsoftcloud/agentkit-harness-node/native/command-progress';

/** Local authenticated operator observations, never model context or receipts.
 * The composition root supplies the output-disclosure policy independently of
 * the final model-result policies. Hosts can withhold/redact each snapshot.
 */
export function createStudioNativeCommandProgress({ workspaceId, project, now = Date.now } = {}) {
  if (typeof project !== 'function') throw TypeError('Native command preview requires an output policy');
  const entries = new Map();
  const keyOf = request => canonical([request.scope, request.runId, request.operationKey, request.call.callId]);
  return {
    begin({ request, agent, signal, assertCurrent }) {
      if (request.call.name !== 'run_command' || request.call.arguments.background === true
        || request.scope.tenantId !== 'local' || request.scope.userId !== 'local-user'
        || request.scope.workspaceId !== workspaceId || typeof assertCurrent !== 'function') return null;
      const key = keyOf(request);
      entries.get(key)?.observer.close();
      const entry = { scope: structuredClone(request.scope), runId: request.runId, sessionId: request.sessionId,
        operationKey: request.operationKey, callId: request.call.callId, fence: request.executionFence, signal, frame: null };
      const observer = createCommandProgressObserver({ signal,
        isCurrent: () => entries.get(key) === entry && assertCurrent(request) === true,
        project: source => project(source, { agent, request, signal }),
        publish: frame => { entry.frame = frame; } });
      entry.observer = observer; entries.set(key, entry);
      while (entries.size > 32) {
        const oldest = entries.keys().next().value;
        entries.get(oldest).observer.close(); entries.delete(oldest);
      }
      return { observe: observer.observe, close() {
        observer.close(); if (entries.get(key) === entry) entries.delete(key);
      } };
    },
    read(record) {
      const s = record?.snapshot;
      if (!s || s.phase !== 'executing_tools' || !record.lease || record.lease.expiresAt <= now()) return null;
      const observed = record.contract === 'agentkit.native-run-observation/v1';
      const intent = observed ? record.facts.pendingEffect : record.intents.find(i => i.operationKey === s.pendingIntent);
      if (intent?.kind !== 'tool' || intent.status !== 'running' || intent.claimedFence !== record.lease.fence
        || (observed ? intent.receiptPresent : record.receipts.some(r => r.operationKey === intent.operationKey))) return null;
      const pendingCalls = observed ? intent.calls : intent.payload.calls;
      const calls = [];
      for (const entry of entries.values()) {
        if (!entry.frame || entry.signal.aborted || entry.runId !== s.runId || entry.sessionId !== s.sessionId
          || canonical(entry.scope) !== canonical(s.scope) || entry.fence !== record.lease.fence) continue;
        const index = pendingCalls.findIndex(call => call.callId === entry.callId && call.name === 'run_command');
        if (index < 0 || intent.operationKey !== s.pendingIntent || entry.operationKey !== (pendingCalls.length === 1
          ? intent.operationKey : `${intent.operationKey}:call:${index + 1}`)) continue;
        calls.push({ callId: nativeDeliveryId(s.scope, s.runId, `call:${entry.callId}`),
          sequence: entry.frame.sequence, display: entry.frame.display, truncated: entry.frame.truncated });
      }
      return calls.length ? { contract: 'agentkit.native-command-previews/v1', runId: s.runId, sessionId: s.sessionId, calls } : null;
    },
    close() { for (const entry of entries.values()) entry.observer.close(); entries.clear(); },
  };
}
