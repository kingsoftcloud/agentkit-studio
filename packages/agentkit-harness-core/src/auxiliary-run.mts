import type { ModelRequest, NativePorts, RunConfiguration, RunIdentity, RunSnapshot, RunStore, ToolReceiptRequest, ToolRequest } from './contracts.mjs';
import { NativeKernel } from './kernel.mjs';
import { toolReceiptRequest } from './tool-receipt.mjs';
import { canonical, invariant } from './values.mjs';

export const NATIVE_AUXILIARY_RUN = 'agentkit.native-auxiliary-run/v1' as const;
const identityFields = ['runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'] as const;
export type NativeAuxiliaryExecutionStatus = 'success' | 'error' | 'aborted';
export interface NativeAuxiliaryRun {
  readonly contract: typeof NATIVE_AUXILIARY_RUN;
  readonly identity: RunIdentity;
  readonly configuration: RunConfiguration;
}

/** Reusable exact-call guard for an auxiliary capability owner, including its
 * final synchronous check immediately before a database mutation. It does not
 * grant permission: the Host must additionally prove the source and policy. */
export function assertNativeAuxiliaryToolExecution({ store, run, request, now = Date.now() }: {
  store: RunStore; run: NativeAuxiliaryRun; request: ToolRequest; now?: number;
}): void {
  request.signal.throwIfAborted();
  invariant(run.contract === NATIVE_AUXILIARY_RUN && canonical(request.scope) === canonical(run.identity.scope)
    && identityFields.every(key => request[key] === run.identity[key]), 'auxiliary_execution_identity_unbound');
  const record = store.load(run.identity.scope, run.identity.runId);
  invariant(canonical(record.configuration) === canonical(run.configuration), 'auxiliary_configuration_changed');
  const { snapshot, lease } = record;
  invariant(snapshot.phase === 'executing_tools' && lease && lease.expiresAt > now,
    'auxiliary_execution_not_live');
  const intent = record.intents.find(item => item.operationKey === snapshot.pendingIntent);
  const calls = intent?.payload.calls;
  invariant(intent?.kind === 'tool' && intent.status === 'running' && Array.isArray(calls)
    && intent.claimedFence === lease.fence && request.executionFence === lease.fence,
  'auxiliary_execution_fence_unbound');
  const index = calls.findIndex((call, position) => canonical(call) === canonical(request.call)
    && request.operationKey === (calls.length > 1 ? `${intent.operationKey}:call:${position + 1}` : intent.operationKey));
  const formal = run.configuration.tools.find(tool => tool.name === request.call.name);
  invariant(index >= 0 && formal && canonical(formal) === canonical(request.definition),
    'auxiliary_execution_call_unbound');
}

/** A receipt lookup must itself be a claimed, fenced observation of the exact
 * original uncertain effect. It never grants permission to execute that effect. */
export function assertNativeAuxiliaryReceiptObservation({ store, run, request, now = Date.now() }: {
  store: RunStore; run: NativeAuxiliaryRun; request: ToolReceiptRequest; now?: number;
}): void {
  request.signal.throwIfAborted();
  invariant(run.contract === NATIVE_AUXILIARY_RUN && canonical(request.scope) === canonical(run.identity.scope)
    && identityFields.every(key => request[key] === run.identity[key]), 'auxiliary_receipt_identity_unbound');
  const record = store.load(run.identity.scope, run.identity.runId), { snapshot, lease } = record;
  invariant(canonical(record.configuration) === canonical(run.configuration), 'auxiliary_configuration_changed');
  const intent = record.intents.find(item => item.operationKey === snapshot.pendingIntent);
  invariant(snapshot.phase === 'reconciling_tool' && lease && lease.expiresAt > now
    && request.executionFence === lease.fence && intent?.kind === 'tool_receipt'
    && intent.status === 'running' && intent.claimedFence === lease.fence
    && request.operationKey === intent.operationKey, 'auxiliary_receipt_execution_unbound');
  const expected = toolReceiptRequest(request, record, intent);
  invariant(request.contract === expected.contract && request.originalOperationKey === expected.originalOperationKey
    && request.originalClaimedFence === expected.originalClaimedFence
    && canonical(request.call) === canonical(expected.call)
    && canonical(request.definition) === canonical(expected.definition), 'auxiliary_receipt_call_unbound');
}

/** Runs the existing durable NativeKernel, not another model/tool loop.
 * The Host or capability module owns scheduling, input authority, permissions
 * and durable job/cursor publication. Non-completion never proves that work succeeded. */
export async function executeNativeAuxiliaryRun({ run, store, ports, owner, digest, signal,
  assertSourceCurrent, countRequest }: {
  run: NativeAuxiliaryRun; store: RunStore; ports: Pick<NativePorts, 'model' | 'tools'>;
  owner: string; digest: (value: unknown) => string; signal: AbortSignal;
  assertSourceCurrent: () => void | Promise<void>;
  countRequest: (request: ModelRequest) => number | Promise<number>;
}): Promise<{ status: NativeAuxiliaryExecutionStatus; snapshot: RunSnapshot }> {
  invariant(run.contract === NATIVE_AUXILIARY_RUN, 'auxiliary_contract_invalid');
  signal.throwIfAborted();
  await assertSourceCurrent();
  signal.throwIfAborted();
  const check = async (requestSignal: AbortSignal) => {
    requestSignal.throwIfAborted(); signal.throwIfAborted();
    await assertSourceCurrent();
    requestSignal.throwIfAborted(); signal.throwIfAborted();
  };
  const kernel = new NativeKernel({ store, owner, digest, ports: {
    model: { async generate(request, emit) {
      await check(request.signal);
      const counted = await countRequest(request);
      invariant(Number.isSafeInteger(counted) && counted >= 0
        && counted + request.profile.maxOutputTokens < request.profile.contextWindow,
      'auxiliary_context_budget_exhausted');
      await check(request.signal);
      return ports.model.generate({ ...request, signal: AbortSignal.any([signal, request.signal]) }, emit);
    } },
    tools: { ...(ports.tools.executionLifecycle ? { executionLifecycle: ports.tools.executionLifecycle } : {}),
      async execute(request, lifecycle) {
      await check(request.signal);
      assertNativeAuxiliaryToolExecution({ store, run, request });
      return ports.tools.execute({ ...request, signal: AbortSignal.any([signal, request.signal]) }, lifecycle);
    }, ...(ports.tools.observeReceipt ? { async observeReceipt(request) {
      await check(request.signal);
      assertNativeAuxiliaryReceiptObservation({ store, run, request });
      return ports.tools.observeReceipt!({ ...request, signal: AbortSignal.any([signal, request.signal]) });
    } } : {}) },
  } });
  kernel.start(run.identity, run.configuration);
  const cancel = () => kernel.submit(run.identity.scope, run.identity.runId,
    { commandId: 'auxiliary-shutdown', kind: 'cancel', payload: {} });
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    let snapshot = await kernel.runUntilIdle(run.identity.scope, run.identity.runId);
    if (snapshot.phase === 'awaiting_reconciliation' && ports.tools.observeReceipt && !signal.aborted) {
      kernel.submit(run.identity.scope, run.identity.runId, {
        commandId: `auxiliary-receipt-${snapshot.revision}`, kind: 'reconcile_tool',
        payload: { originalOperationKey: snapshot.toolReconciliation!.operationKey },
      });
      snapshot = await kernel.runUntilIdle(run.identity.scope, run.identity.runId);
    }
    if (signal.aborted) return { status: 'aborted', snapshot };
    await assertSourceCurrent();
    if (signal.aborted) return { status: 'aborted', snapshot };
    return { status: snapshot.phase === 'completed' ? 'success' : 'error', snapshot };
  } catch {
    return { status: signal.aborted ? 'aborted' : 'error',
      snapshot: store.load(run.identity.scope, run.identity.runId).snapshot };
  } finally { signal.removeEventListener('abort', cancel); }
}
