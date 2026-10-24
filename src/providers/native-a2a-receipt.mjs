import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeA2aTerminalResult } from '../../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { createNativeToolReceiptAuthority } from './native-tool-authority.mjs';
import { a2aTerminal } from './native-a2a-protocol.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { a2aDecisionDigest } from './native-a2a-decision.mjs';

export const NATIVE_A2A_RECEIPT_WAIT = 'agentkit.native-a2a-receipt-wait/v1';

/** Waiting owns no execution lease and cannot query a remote task. A local
 * terminal fact merely requests the Kernel's separately fenced receipt read.
 * The command identity survives process restart; one fact cannot busy-loop
 * into an unbounded sequence of new receipt intents. */
export function createNativeA2aReceiptWaiter({ a2a, scope, sessionId, store, stateRoot, workspaceRoot, isClosed }) {
  const fixedScope = copy(scope);
  return async ({ snapshot, signal }) => {
    signal.throwIfAborted();
    if (snapshot.phase !== 'awaiting_reconciliation' || !snapshot.toolReconciliation) return null;
    const record = store.load(fixedScope, snapshot.runId), originalOperationKey = snapshot.toolReconciliation.operationKey;
    const intent = record.intents.find(item => item.operationKey === originalOperationKey);
    const call = intent?.payload.calls?.[0], definition = record.configuration.tools.find(item => item.name === call?.name);
    if (call?.name !== 'call_a2a_agent' || definition?.recoveryPolicy !== 'receipt-observation/v1') return null;
    const receipt = record.receipts.find(item => item.operationKey === originalOperationKey);
    invariant(canonical(snapshot.scope) === canonical(fixedScope) && snapshot.sessionId === sessionId
      && canonical(record.snapshot) === canonical(snapshot) && snapshot.pendingIntent === null
      && intent.kind === 'tool' && intent.status === 'running' && intent.payload.calls.length === 1
      && Number.isSafeInteger(intent.claimedFence) && intent.claimedFence > 0
      && call.callId === snapshot.toolReconciliation.callId
      && canonical(snapshot.pendingTools.slice(0, 1)) === canonical([call])
      && receipt && (receipt.status === 'uncertain' || receipt.result.results?.[0]?.status === 'uncertain'),
    'A2A_RECEIPT_WAIT_SOURCE_INVALID');
    const query = { contract: NATIVE_A2A_RECEIPT_WAIT,
      ...Object.fromEntries(['scope', 'sessionId', 'runId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
        .map(key => [key, copy(snapshot[key])])), originalOperationKey, originalClaimedFence: intent.claimedFence,
      call: copy(call), definition: copy(definition), signal };
    const sealed = canonical({ ...query, signal: null }), checkpoint = canonical(snapshot);
    const check = input => {
      signal.throwIfAborted();
      invariant(!isClosed() && input === query && query.signal === signal && canonical({ ...query, signal: null }) === sealed
        && canonical(store.load(fixedScope, snapshot.runId).snapshot) === checkpoint, 'A2A_RECEIPT_WAIT_AUTHORITY_LOST');
      return true;
    };
    check(query);
    const owner = a2a.forSession({ scope: fixedScope, sessionId, stateRoot, workspaceRoot,
      assertCurrent: () => false, assertReceiptWait: check });
    try {
      for (;;) {
        check(query);
        const observed = owner.peekReceipt(query);
        if (observed) {
          invariant(/^[a-f0-9]{64}$/u.test(observed.token), 'A2A_RECEIPT_WAIT_TOKEN_INVALID');
          const commandId = `native-a2a-receipt-${a2aDecisionDigest({ contract: NATIVE_A2A_RECEIPT_WAIT,
            scope: fixedScope, sessionId, runId: snapshot.runId, originalOperationKey, callId: call.callId, token: observed.token })}`;
          const commands = store.load(fixedScope, snapshot.runId).commands;
          // A different process can enqueue between the executor's queued-
          // command check and this wait. Returning that SAME pending command
          // wakes consumption through the Kernel's idempotent submit path.
          if (!commands.some(row => row.command.commandId === commandId && row.consumed)) return {
            commandId, kind: 'reconcile_tool', payload: { originalOperationKey } };
        }
        // Only local private journal reads. Timers are abortable and owned by
        // this idle attempt; manual controls and shutdown withdraw the wait.
        await delay(100, undefined, { signal });
      }
    } finally { owner.close(); }
  };
}

/** A new ledger read may inspect an old task, but can never send or cancel it. */
export function createNativeA2aReceiptObserver({ a2a, scope, sessionId, store, stateRoot, workspaceRoot, isClosed }) {
  const authority = createNativeToolReceiptAuthority({ scope, sessionId, store, isClosed });
  return async request => {
    const signal = request.signal, sealed = canonical({ ...request, signal: null });
    const check = () => {
      invariant(request.signal === signal && canonical({ ...request, signal: null }) === sealed
        && request.call?.name === 'call_a2a_agent' && authority(request), 'A2A_RECEIPT_AUTHORITY_LOST');
      return true;
    };
    check();
    const locator = { scope: copy(scope), sessionId, runId: request.runId,
      operationKey: request.originalOperationKey, callId: request.call.callId };
    const owner = a2a.forSession({ scope, sessionId, stateRoot, workspaceRoot, assertCurrent: () => false,
      assertReceipt: check,
      assertControl: input => {
        check(); return input.kind === 'get' && canonical(input.operation_locator) === canonical(locator)
          && input.authority?.contract === 'agentkit.native-a2a-receipt-read/v1'
          && input.authority.operationKey === request.operationKey;
      },
      authorizeControl: ({ readOnly, command }) => { check(); return readOnly && command.kind === 'get' ? 'allow' : 'deny'; },
    });
    try {
      const observed = await owner.observeReceipt(request); check();
      return { contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId,
        result: observed && a2aTerminal.has(observed.state) ? nativeA2aTerminalResult(observed, observed.agent) : null };
    } finally { owner.close(); }
  };
}
