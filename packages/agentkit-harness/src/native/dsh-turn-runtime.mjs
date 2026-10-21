import { createHash, randomUUID } from 'node:crypto';
import { NativeKernel, NativeError, NATIVE_GOAL_CONTRACT_BINDING, NATIVE_JSON_CODEC, canonical, configure, invariant, terminal } from '../../../agentkit-harness-core/dist/index.mjs';
import { createNativeSessionDelivery } from './session-delivery.mjs';
import { nativeLiveStream } from './assistant-stream.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from './dsh-turn-contract.mjs';
import { nativeDshOwnership, nativeDshOwnershipHost, readNativeDshOwnership } from './dsh-turn-ownership.mjs';

export { NATIVE_DSH_TURN_CONTRACT };
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const failure = (code, snapshot) => Object.assign(new Error(code), { code,
  ...(snapshot ? { nativeRunId: snapshot.runId, nativePhase: snapshot.phase, nativeReason: snapshot.reason } : {}),
});
const unresolvedEffects = record => record.intents.some(intent => ['tool', 'hook', 'child', 'input'].includes(intent.kind)
  && (intent.status === 'running' && !record.receipts.some(receipt => receipt.operationKey === intent.operationKey)
    || record.receipts.some(receipt => receipt.operationKey === intent.operationKey && receipt.status === 'uncertain'
      && !(receipt.result.recoveryPolicy === 'safe-read/v1' && receipt.result.retryScheduled === true))));

function cancelReason(cause) {
  return ['user', 'parent', 'disposed'].includes(cause?.kind) ? { kind: cause.kind }
    : cause?.kind === 'hook' && typeof cause.reason === 'string' ? { kind: 'hook', reason: cause.reason }
      : null;
}
function canceledEnding(signal, record) {
  const persisted = record?.commands.find(row => row.command.commandId === `${record.snapshot.runId}:dsh-turn-cancel`)
    ?.command.payload.dshCancelReason;
  const reason = cancelReason(signal?.aborted ? signal.reason : persisted)
    ?? { kind: signal?.aborted ? 'disposed' : 'user' };
  return { reason: { kind: 'aborted', reason } };
}

/** Shared freezing for first admission and explicit adoption of the same Run. */
export function freezeNativeDshConfiguration(binding, input, contract = binding.configuration.contract) {
  return configure({ ...binding.configuration, contract, hostBindingDigest: hash({
    contract: NATIVE_DSH_TURN_CONTRACT, declared: binding.configuration.hostBindingDigest,
    goalContractBinding: NATIVE_GOAL_CONTRACT_BINDING, jsonCodec: NATIVE_JSON_CODEC,
    input: input.messages, source: binding.source,
  }) });
}

/** Verify a trusted Host's reconstructed ports/configuration before any worker starts. */
export function rebindNativeDshConfiguration(record, binding, payload) {
  invariant(hash(record.configuration) === record.snapshot.configDigest, 'stored_configuration_mismatch');
  invariant(canonical(binding.scope) === canonical(record.snapshot.scope)
    && binding.buildId === record.snapshot.buildId
    && payload?.agent?.session?.id === record.snapshot.sessionId
    && Number.isSafeInteger(payload.turn) && payload.turn > 0 && String(payload.turn) === record.snapshot.turnId,
  'native_dsh_recovery_identity_mismatch');
  const configuration = freezeNativeDshConfiguration(binding, payload.input, record.configuration.contract);
  invariant(hash(configuration) === record.snapshot.configDigest, 'native_dsh_recovery_configuration_changed');
  return configuration;
}

// Resolving host resources is not execution authority. A late lookup can never
// start a Native run after the enclosing DSH turn has been canceled.
async function resolveWhileLive(resolve, payload) {
  const signal = payload.signal;
  signal.throwIfAborted();
  let onAbort;
  const canceled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => resolve(payload)), canceled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', onAbort); }
}

async function flushOwnership(flush, payload, timeoutMs) {
  let timer;
  try {
    return await resolveWhileLive(() => Promise.race([
      Promise.resolve().then(() => flush(payload.agent.session)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(
        new NativeError('native_dsh_ownership_flush_timeout')), timeoutMs); }),
    ]), payload);
  } finally { clearTimeout(timer); }
}

/**
 * Bind the actual Native loop to DSH's public whole-turn boundary.
 *
 * resolveTurn(payload) returns null to delegate an unrelated runtime, or
 * {scope, buildId, configuration, ports, source:{provider,model}, taskChainId?, taskContractFactory?}.
 * An optional trusted taskContractFactory receives the pinned parent facts.
 * Its result is frozen in the new Run configuration, with session-head CAS.
 * The resolver must project all admitted input, including attachment bytes
 * resolved by the host, into configuration.inputMessages. It owns that trusted
 * projection; this adapter never reads attachment paths supplied in messages.
 * The trusted host resolves credentials and permissions into ports; none are
 * read from user text or copied into the Native ledger by this adapter.
 *
 * Same-turn replay reuses the exact Native run and committed DSH atoms. A new
 * DSH turn cannot implicitly restart an unfinished Native run. Cross-turn
 * adoption of interrupted work requires an explicit host recovery workflow.
 * durableOwnership additionally requires the public DSH external-turn host:
 * complete admission is flushed before creating the Run. resolveRecoveryTurn
 * must independently rebind trusted ports to those original facts; persisted
 * admission never grants execution authority. resume() uses the original turn.
 */
export function createNativeDshTurnExecutor({ store, resolveTurn, resolveRecoveryTurn, projections, flush,
  owner = `native-dsh-${randomUUID()}`, durableOwnership = false, ownershipFlushTimeoutMs = 30_000,
  onStream, publishStreamFrame, onIdle, onCheckpoint, onActive } = {}) {
  invariant((onActive === undefined || typeof onActive === 'function') && store && typeof resolveTurn === 'function' && typeof flush === 'function'
    && typeof projections?.stateOf === 'function' && typeof owner === 'string' && owner.trim()
    && typeof durableOwnership === 'boolean' && (resolveRecoveryTurn === undefined || typeof resolveRecoveryTurn === 'function'),
  'native_dsh_host_binding_invalid');
  invariant(Number.isSafeInteger(ownershipFlushTimeoutMs) && ownershipFlushTimeoutMs > 0
    && ownershipFlushTimeoutMs <= 2_147_483_647, 'native_dsh_ownership_flush_timeout_invalid');
  const active = new Set(), revisions = new WeakMap();
  const run = async (payload, admission) => {
    const { agent, input, turn, signal } = payload;
    invariant(agent?.session && typeof agent.session.id === 'string' && agent.session.id.trim()
      && input?.kind === 'enter' && Array.isArray(input.messages)
      && Number.isSafeInteger(turn) && turn > 0 && signal instanceof AbortSignal, 'native_dsh_turn_input_invalid');
    const binding = await resolveWhileLive(admission
      ? request => resolveRecoveryTurn(request, structuredClone(admission)) : resolveTurn, payload);
    if (binding === null) {
      invariant(!admission, 'native_dsh_recovery_binding_unavailable');
      return undefined;
    }
    invariant(binding && binding.scope && binding.configuration
      && Array.isArray(binding.configuration.inputMessages) && binding.configuration.inputMessages.length > 0
      && typeof binding.buildId === 'string' && binding.buildId.trim()
      && typeof binding.source?.provider === 'string' && binding.source.provider.trim()
      && typeof binding.source?.model === 'string' && binding.source.model.trim()
      && binding.ports && typeof binding.ports.model?.generate === 'function'
      && typeof binding.ports.tools?.execute === 'function', 'native_dsh_turn_binding_invalid');
    const sessionId = String(agent.session.id), scope = structuredClone(binding.scope);
    const runId = `native-dsh-${hash({ contract: NATIVE_DSH_TURN_CONTRACT, scope, sessionId, turn })}`;
    invariant(binding.taskContractFactory === undefined || typeof binding.taskContractFactory === 'function', 'native_dsh_contract_factory_invalid');
    invariant(binding.releaseResources === undefined || typeof binding.releaseResources === 'function', 'native_dsh_resource_release_invalid');
    const key = canonical({ scope, sessionId });
    invariant(!active.has(key), 'native_dsh_session_already_driving');
    active.add(key);
    let live, failed = false, originalError, releaseControls, cancelListener;
    try {
      signal.throwIfAborted();
      const head = store.sessionHead(scope, sessionId);
      if (head && head.runId !== runId) {
        const previous = store.load(scope, head.runId);
        // Interrupted is a terminal phase for the worker, not proof that its
        // effects finished. Cancellation can also leave an unknown write.
        // Requiring reconciliation prevents a new turn from racing that work.
        const unknownEffect = unresolvedEffects(previous);
        const unsettledChildren = (previous.snapshot.childBudgetReservations ?? []).some(item => item.settledUsageDigest === null);
        if (!terminal(head.phase) || head.phase === 'interrupted' || unknownEffect || unsettledChildren) {
          throw failure('NATIVE_RUN_RECOVERY_REQUIRED', previous.snapshot);
        }
      }
      let existing = null, existingConfiguration = null;
      try { const record = store.load(scope, runId); existing = record.snapshot; existingConfiguration = record.configuration; }
      catch (error) { if (!(error instanceof NativeError && error.code === 'run_not_found')) throw error; }
      if (admission) {
        invariant(binding.taskChainId === undefined ? admission.identity.taskChainId === sessionId
          : binding.taskChainId === admission.identity.taskChainId, 'native_dsh_recovery_identity_mismatch');
        invariant(existing ? head?.runId === runId && existing.parentRunId === admission.identity.parentRunId
          : (head?.runId ?? null) === admission.identity.parentRunId, 'native_dsh_recovery_superseded');
        invariant(!existing || existing.configDigest === admission.configDigest, 'native_dsh_recovery_configuration_changed');
      }
      // Redelivery compiles against the original parent, even after later
      // turns have advanced this Session. A new turn pins the current head.
      const parentRunId = existing ? existing.parentRunId : head?.runId ?? null;
      const parent = parentRunId ? store.load(scope, parentRunId) : null;
      const contract = admission ? admission.configuration.contract : binding.taskContractFactory ? await resolveWhileLive(() => binding.taskContractFactory({
        scope: structuredClone(scope), sessionId, runId, parentRunId,
        parentGoal: parent?.snapshot.goal ?? null,
        parentContract: structuredClone(parent?.snapshot.taskContract ?? parent?.configuration.contract ?? null),
        goal: binding.configuration.contract.objective, signal,
      }), payload) : binding.configuration.contract;
      signal.throwIfAborted();
      invariant(contract && typeof contract === 'object' && !Array.isArray(contract)
        && contract.objective === binding.configuration.contract.objective, 'native_dsh_task_contract_invalid');
      // An optional locator introduced by a newer Host must not rewrite an
      // older Run's identity during exact same-turn redelivery. Every original
      // execution/configuration field still participates in start's digest CAS.
      let frozenBinding = binding;
      if (existingConfiguration && existingConfiguration.hostRecoveryBinding === undefined
        && binding.configuration.hostRecoveryBinding !== undefined) {
        const legacy = { ...binding.configuration }; delete legacy.hostRecoveryBinding;
        frozenBinding = { ...binding, configuration: legacy };
      }
      const configuration = admission ? rebindNativeDshConfiguration({ configuration: admission.configuration,
        snapshot: { ...admission.identity, configDigest: admission.configDigest } }, binding, payload)
        : freezeNativeDshConfiguration(frozenBinding, input, contract);
      if (durableOwnership && existing) invariant(hash(configuration) === existing.configDigest, 'run_creation_conflict');
      const delivery = createNativeSessionDelivery({ store, scope, runId, session: agent.session, turn, projections, flush,
        inputMessages: input.messages, systemText: configuration.instructions, source: binding.source,
        onStreamSettled: (...args) => live.settled(...args) });
      live = nativeLiveStream({ agent, runId, turn, revisions, beginStep: delivery.beginStream,
        publish: publishStreamFrame ? frame => publishStreamFrame(payload, frame) : undefined });
      const kernel = new NativeKernel({ store, ports: binding.ports, digest: hash, owner,
        onStream: (identity, event, record) => {
          live.accept(identity, record);
          onStream?.(payload, identity, event);
        },
        onCheckpoint: async snapshot => {
          await delivery(snapshot);
          if (onCheckpoint && !signal.aborted) await resolveWhileLive(
            () => onCheckpoint(payload, structuredClone(snapshot)), payload);
        },
      });
      const identity = { scope, runId, sessionId, turnId: String(turn), buildId: binding.buildId, parentRunId,
        taskChainId: binding.taskChainId ?? sessionId };
      const start = () => kernel.start({ ...identity, parentRunId: null }, configuration,
        durableOwnership || binding.taskContractFactory ? { expectedParentRunId: parentRunId } : {});
      const persistCancel = () => {
        const commandId = `${runId}:dsh-turn-cancel`;
        const original = store.load(scope, runId).commands.find(row => row.command.commandId === commandId)?.command;
        return kernel.submit(scope, runId, original ?? { commandId, kind: 'cancel',
          payload: durableOwnership ? { dshCancelReason: cancelReason(signal.reason) ?? { kind: 'disposed' } } : {} });
      };
      if (durableOwnership) {
        const host = nativeDshOwnershipHost(agent);
        host.claim(nativeDshOwnership({ identity, configuration, input, source: binding.source }));
        try {
          invariant(await flushOwnership(flush, payload, ownershipFlushTimeoutMs) === true, 'native_dsh_ownership_not_durable');
        } catch (error) {
          // Cancellation must outlive this process even if the Session barrier
          // failed. Creating a canceled intent never dispatches an effect.
          if (signal.aborted) { start(); persistCancel(); }
          throw error;
        }
      }
      start();
      if (signal.aborted) persistCancel();
      else if (durableOwnership) {
        cancelListener = persistCancel;
        signal.addEventListener('abort', cancelListener, { once: true });
      }
      let wakeIdle = () => {};
      releaseControls = onActive?.(payload, { kernel, scope: structuredClone(scope), sessionId, runId, wake: () => wakeIdle() });
      invariant(releaseControls === undefined || typeof releaseControls === 'function', 'native_dsh_controls_cleanup_invalid');
      let snapshot;
      try {
        snapshot = await kernel.runUntilIdle(scope, runId, { signal });
        while (!terminal(snapshot.phase)) {
          signal.throwIfAborted();
          if (!onIdle) throw failure('NATIVE_TURN_SUSPENDED', snapshot);
          const idle = new AbortController(), idlePayload = { ...payload, signal: AbortSignal.any([signal, idle.signal]) };
          let command, woken = false;
          wakeIdle = () => { woken = true; idle.abort(new NativeError('native_idle_woken')); };
          try {
            if (store.load(scope, runId).commands.some(row => !row.consumed)) wakeIdle();
            command = await resolveWhileLive(() => onIdle(idlePayload, structuredClone(snapshot)), idlePayload);
          } catch (error) {
            if (!woken || signal.aborted) throw error;
            snapshot = await kernel.runUntilIdle(scope, runId, { signal });
            continue;
          } finally { wakeIdle = () => {}; idle.abort(); }
          if (!command) throw failure('NATIVE_TURN_SUSPENDED', snapshot);
          const revision = snapshot.revision;
          const receipt = kernel.submit(scope, runId, command);
          invariant(receipt.status !== 'rejected', 'native_dsh_command_rejected');
          snapshot = await kernel.runUntilIdle(scope, runId, { signal });
          invariant(terminal(snapshot.phase) || snapshot.revision > revision, 'native_dsh_command_made_no_progress');
        }
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted && !terminal(store.load(scope, runId).snapshot.phase)) {
          // A turn can be canceled while no kernel worker is active (approval
          // or host checkpoint). Persist first, then drain without allowing a
          // late host callback to authorize another effect. A failed delivery
          // leaves the cancel command durable for recovery.
          persistCancel();
          try { await kernel.runUntilIdle(scope, runId); }
          catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Native cancellation requires recovery'); }
        }
        if (durableOwnership && signal.aborted) {
          const ended = store.load(scope, runId).snapshot;
          if (terminal(ended.phase)) {
            await delivery(ended);
            return canceledEnding(signal);
          }
        }
        throw error;
      }
      if (durableOwnership && snapshot.phase === 'canceled') return canceledEnding(undefined, store.load(scope, runId));
      if (snapshot.reason === 'host_input_rejected' && snapshot.outcome === 'blocked') return { reason: { kind: 'blocked' } };
      if (durableOwnership && snapshot.phase === 'failed') return { reason: { kind: 'error',
        error: { code: 'NATIVE_TURN_FAILED', message: snapshot.reason ?? 'Native run failed' } } };
      if (snapshot.phase === 'canceled') { signal.throwIfAborted(); throw failure('NATIVE_TURN_CANCELED', snapshot); }
      if (snapshot.phase !== 'completed') throw failure('NATIVE_TURN_FAILED', snapshot);
      return { reason: { kind: snapshot.outcome === 'blocked' ? 'blocked' : 'completed' } };
    } catch (error) {
      failed = true; originalError = error; throw error;
    } finally {
      if (cancelListener) signal.removeEventListener('abort', cancelListener);
      try {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => releaseControls?.()),
          Promise.resolve().then(() => live?.abandon()),
          Promise.resolve().then(() => binding.releaseResources?.({ scope: structuredClone(scope), sessionId, runId })),
        ]);
        const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(failed ? [originalError, ...errors] : errors, 'Native turn resource cleanup failed');
      } finally { active.delete(key); }
    }
  };
  const execute = payload => run(payload);
  /** Trusted Host recovery: resolve original ports, then drive the same owned turn and Run. */
  execute.resume = ({ agent, ...request }) => {
    invariant(durableOwnership && typeof resolveRecoveryTurn === 'function', 'native_dsh_recovery_resolver_required');
    const host = nativeDshOwnershipHost(agent);
    return host.resume(NATIVE_DSH_TURN_CONTRACT, resumed => {
      const admission = readNativeDshOwnership(resumed.ownership, { sessionId: agent.session.id, turn: resumed.turn });
      return run({ ...request, ...resumed, agent,
        input: { kind: 'enter', messages: structuredClone(admission.messages) } }, admission);
    });
  };
  return execute;
}
