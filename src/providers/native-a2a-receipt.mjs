import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeA2aTerminalResult } from '../../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { createNativeToolReceiptAuthority } from './native-tool-authority.mjs';
import { a2aTerminal } from './native-a2a-protocol.mjs';

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
