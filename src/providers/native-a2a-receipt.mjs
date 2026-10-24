import { canonical, copy, invariant, terminal } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { nativeA2aTerminalResult } from '../../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { createNativeToolReceiptAuthority } from './native-tool-authority.mjs';
import { a2aTerminal } from './native-a2a-protocol.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { a2aDecisionDigest } from './native-a2a-decision.mjs';
import { A2A_QUESTION_LEDGER } from './native-a2a-question.mjs';
import { awaitA2aControl } from './native-a2a-controls.mjs';

export const NATIVE_A2A_RECEIPT_WAIT = 'agentkit.native-a2a-receipt-wait/v1';
export const NATIVE_A2A_QUESTION_CLEANUP = 'agentkit.native-a2a-question-cleanup/v1';

/** Local, read-only classification. This grants neither a receipt query nor
 * execution of the original tool. Rebinding still validates the full Host
 * capsule/configuration before the original external turn can be adopted. */
export function nativeA2aReceiptWaitSource(record) {
  const snapshot = record?.snapshot, marker = snapshot?.toolReconciliation;
  if (snapshot?.phase !== 'awaiting_reconciliation' || snapshot.pendingIntent !== null
    || marker?.contract !== 'agentkit.tool-receipt-observation/v1') return null;
  const intent = record.intents.find(item => item.operationKey === marker.operationKey);
  const call = intent?.payload.calls?.[0], definition = record.configuration.tools.find(item => item.name === call?.name);
  const receipt = record.receipts.find(item => item.operationKey === marker.operationKey);
  if (call?.name !== 'call_a2a_agent' || definition?.recoveryPolicy !== 'receipt-observation/v1'
    || intent.kind !== 'tool' || intent.status !== 'running' || intent.payload.calls.length !== 1
    || !Number.isSafeInteger(intent.claimedFence) || intent.claimedFence <= 0 || call.callId !== marker.callId
    || canonical(snapshot.pendingTools.slice(0, 1)) !== canonical([call])
    || !receipt || !(receipt.status === 'uncertain' || receipt.result.results?.[0]?.status === 'uncertain')) return null;
  return { intent, call, definition };
}

/** Cleanup requires an actual committed terminal, never an abandoned Host
 * callback or shutdown signal. It has no network/control execution authority. */
export function createNativeA2aQuestionTerminator({ a2a, scope, sessionId, store, stateRoot, workspaceRoot, isClosed }) {
  const fixedScope = copy(scope);
  return snapshot => {
    if (!terminal(snapshot.phase)) return;
    const sealed = canonical(snapshot);
    const check = current => {
      invariant(!isClosed() && canonical(current) === sealed && canonical(snapshot.scope) === canonical(fixedScope)
        && snapshot.sessionId === sessionId && canonical(store.load(fixedScope, snapshot.runId).snapshot) === sealed,
      'A2A_QUESTION_TERMINAL_AUTHORITY_LOST'); return true;
    };
    check(snapshot);
    const owner = a2a.forSession({ scope: fixedScope, sessionId, stateRoot, workspaceRoot,
      assertCurrent: () => false, assertQuestionTerminal: check });
    try { owner.questions?.settle(snapshot); } finally { owner.close(); }
  };
}

/** Waiting owns no execution lease and cannot query a remote task. A local
 * terminal fact merely requests the Kernel's separately fenced receipt read.
 * The command identity survives process restart; one fact cannot busy-loop
 * into an unbounded sequence of new receipt intents. */
export function createNativeA2aReceiptWaiter({ a2a, scope, sessionId, store, stateRoot, workspaceRoot, isClosed }) {
  const fixedScope = copy(scope);
  return async ({ snapshot, signal, questionHost }) => {
    signal.throwIfAborted();
    if (snapshot.phase !== 'awaiting_reconciliation' || !snapshot.toolReconciliation) return null;
    const record = store.load(fixedScope, snapshot.runId), originalOperationKey = snapshot.toolReconciliation.operationKey;
    const intent = record.intents.find(item => item.operationKey === originalOperationKey);
    const call = intent?.payload.calls?.[0], definition = record.configuration.tools.find(item => item.name === call?.name);
    if (call?.name !== 'call_a2a_agent' || definition?.recoveryPolicy !== 'receipt-observation/v1') return null;
    invariant(canonical(snapshot.scope) === canonical(fixedScope) && snapshot.sessionId === sessionId
      && canonical(record.snapshot) === canonical(snapshot) && nativeA2aReceiptWaitSource(record),
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
    const locator = { scope: fixedScope, sessionId, runId: snapshot.runId, operationKey: originalOperationKey, callId: call.callId };
    const owner = a2a.forSession({ scope: fixedScope, sessionId, stateRoot, workspaceRoot,
      assertCurrent: () => false, assertReceiptWait: check,
      ...(questionHost ? { assertQuestion: check,
        assertControl: input => {
          check(query); return input.authority?.contract === 'agentkit.a2a-question-operation/v1'
            && canonical(input.operation_locator) === canonical(locator);
        },
        authorizeControl: async input => { check(query); const consent = await questionHost.authorizeControl(input); check(query); return consent; },
      } : {}) });
    const unavailable = new Set();
    const advanceQuestion = async () => {
      if (!questionHost || !owner.questions) return;
      const observed = owner.questions.inspect(query); if (!observed) return;
      const { wait } = observed, digest = wait.questionDigest;
      const release = owner.questions.claim(query, digest); if (!release) return;
      try {
        let entry = owner.questions.begin(query, digest);
        if (Date.now() >= wait.deadlineAt) { owner.questions.close(query, digest, 'expired'); return; }
        if (entry.status === 'pending') {
          if (unavailable.has(digest)) return;
          const deadline = AbortSignal.timeout(Math.max(1, wait.deadlineAt - Date.now()));
          const questionSignal = AbortSignal.any([signal, deadline]);
          let answer;
          try {
            answer = await awaitA2aControl(() => questionHost.present({ wait: copy(wait), signal: questionSignal }), questionSignal);
            check(query); entry = owner.questions.answer(query, digest, answer);
          } catch (error) {
            check(query);
            if (Date.now() >= wait.deadlineAt) { owner.questions.close(query, digest, 'expired'); return; }
            if (['A2A_QUESTION_UNAVAILABLE', 'NO_PROVIDER', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER'].includes(error?.code)) {
              unavailable.add(digest); return;
            }
            if (['A2A_QUESTION_ANSWER_INVALID', 'A2A_STRUCTURED_INPUT_INVALID', 'A2A_STRUCTURED_INPUT_REQUIRED'].includes(error?.code)) return;
            throw error;
          }
        }
        if (entry.status === 'rejected' && wait.request.request_type === 'structured_input') return;
        if (!['submitted', 'approved', 'rejected'].includes(entry.status) || entry.effectCommandId) return;
        const kind = entry.status === 'rejected' ? 'reject' : 'continue';
        const commandId = `question-operation-${a2aDecisionDigest({ contract: A2A_QUESTION_LEDGER,
          originalOperationKey, interactionId: wait.interactionId, answerDigest: entry.answerDigest, kind })}`;
        try {
          const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, wait.deadlineAt - Date.now()))]);
          await owner.control.execute({ kind, commandId, operation_locator: copy(locator),
            authority: { contract: 'agentkit.a2a-question-operation/v1', interactionId: wait.interactionId },
            pauseDigest: wait.pauseDigest, ...(kind === 'continue'
              ? { parts: wait.request.request_type === 'approval' ? [{ data: 'approve' }] : copy(entry.rawParts) } : {}), signal: operationSignal });
        } catch (error) {
          check(query);
          if (Date.now() >= wait.deadlineAt) { owner.questions.close(query, digest, 'expired'); return; }
          if (['A2A_CONTROL_PERMISSION_DENIED', 'STUDIO_NATIVE_A2A_PERMISSION_UNAVAILABLE', 'STUDIO_A2A_APPROVAL_UNAVAILABLE',
            'STUDIO_A2A_APPROVAL_AUDIT_MISMATCH', 'STUDIO_A2A_APPROVAL_NOT_DURABLE'].includes(error?.code)) {
            owner.questions.close(query, digest, 'operation_denied'); return;
          }
          throw error;
        }
      } finally { release(); }
    };
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
        try { await advanceQuestion(); }
        catch (error) { if (error?.code !== 'A2A_QUESTION_STALE' && error?.code !== 'A2A_CONTINUATION_NOT_ALLOWED') throw error; }
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
      const local = observed?.localOutcome;
      invariant(!local || local.contract === A2A_QUESTION_LEDGER
        && ['A2A_INPUT_REJECTED', 'A2A_OVERALL_TIMEOUT', 'A2A_APPROVAL_DENIED', 'A2A_INPUT_WITHDRAWN'].includes(local.errorCode),
      'A2A_QUESTION_OUTCOME_INVALID');
      return { contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId,
        result: local ? { status: 'error', content: { ok: false, error_type: local.errorCode, local_outcome: local.outcome,
          remote_state: observed.state, task_id: observed.task_id, agent: observed.agent, executed: true } }
          : observed && a2aTerminal.has(observed.state) ? nativeA2aTerminalResult(observed, observed.agent) : null };
    } finally { owner.close(); }
  };
}
