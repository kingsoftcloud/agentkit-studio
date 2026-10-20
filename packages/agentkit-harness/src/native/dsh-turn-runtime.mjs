import { createHash, randomUUID } from 'node:crypto';
import { NativeKernel, canonical, configure, invariant, terminal } from '../../../agentkit-harness-core/dist/index.mjs';
import { createNativeSessionDelivery } from './session-delivery.mjs';
import { nativeLiveStream } from './assistant-stream.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from './dsh-turn-contract.mjs';

export { NATIVE_DSH_TURN_CONTRACT };
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const failure = (code, snapshot) => Object.assign(new Error(code), { code,
  ...(snapshot ? { nativeRunId: snapshot.runId, nativePhase: snapshot.phase, nativeReason: snapshot.reason } : {}),
});

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

/**
 * Bind the actual Native loop to DSH's public whole-turn boundary.
 *
 * resolveTurn(payload) returns null to delegate an unrelated runtime, or
 * {scope, buildId, configuration, ports, source:{provider,model}, taskChainId?}.
 * The resolver must project all admitted input, including attachment bytes
 * resolved by the host, into configuration.inputMessages. It owns that trusted
 * projection; this adapter never reads attachment paths supplied in messages.
 * The trusted host resolves credentials and permissions into ports; none are
 * read from user text or copied into the Native ledger by this adapter.
 *
 * Same-turn replay reuses the exact Native run and committed DSH atoms. A new
 * DSH turn cannot implicitly restart an unfinished Native run. Cross-turn
 * adoption of interrupted work requires an explicit host recovery workflow.
 */
export function createNativeDshTurnExecutor({ store, resolveTurn, projections, flush,
  owner = `native-dsh-${randomUUID()}`, onStream, publishStreamFrame, onIdle, onCheckpoint } = {}) {
  invariant(store && typeof resolveTurn === 'function' && typeof flush === 'function'
    && typeof projections?.stateOf === 'function' && typeof owner === 'string' && owner.trim(), 'native_dsh_host_binding_invalid');
  const active = new Set(), revisions = new WeakMap();
  return async payload => {
    const { agent, input, turn, signal } = payload;
    invariant(agent?.session && typeof agent.session.id === 'string' && agent.session.id.trim()
      && input?.kind === 'enter' && Array.isArray(input.messages)
      && Number.isSafeInteger(turn) && turn > 0 && signal instanceof AbortSignal, 'native_dsh_turn_input_invalid');
    const binding = await resolveWhileLive(resolveTurn, payload);
    if (binding === null) return undefined;
    invariant(binding && binding.scope && binding.configuration
      && Array.isArray(binding.configuration.inputMessages) && binding.configuration.inputMessages.length > 0
      && typeof binding.buildId === 'string' && binding.buildId.trim()
      && typeof binding.source?.provider === 'string' && binding.source.provider.trim()
      && typeof binding.source?.model === 'string' && binding.source.model.trim()
      && binding.ports && typeof binding.ports.model?.generate === 'function'
      && typeof binding.ports.tools?.execute === 'function', 'native_dsh_turn_binding_invalid');
    const sessionId = String(agent.session.id), scope = structuredClone(binding.scope);
    const runId = `native-dsh-${hash({ contract: NATIVE_DSH_TURN_CONTRACT, scope, sessionId, turn })}`;
    const configuration = configure({ ...binding.configuration, hostBindingDigest: hash({
      contract: NATIVE_DSH_TURN_CONTRACT, declared: binding.configuration.hostBindingDigest,
      input: input.messages, source: binding.source,
    }) });
    const key = canonical({ scope, sessionId });
    invariant(!active.has(key), 'native_dsh_session_already_driving');
    active.add(key);
    let live;
    try {
      signal.throwIfAborted();
      const head = store.sessionHead(scope, sessionId);
      if (head && head.runId !== runId) {
        const previous = store.load(scope, head.runId);
        // Interrupted is a terminal phase for the worker, not proof that its
        // effects finished. Cancellation can also leave an unknown write.
        // Requiring reconciliation prevents a new turn from racing that work.
        const unknownEffect = previous.receipts.some(receipt => receipt.status === 'uncertain'
          && !(receipt.result.recoveryPolicy === 'safe-read/v1' && receipt.result.retryScheduled === true)
          && ['tool', 'hook', 'child', 'input'].includes(previous.intents.find(intent => intent.operationKey === receipt.operationKey)?.kind));
        if (!terminal(head.phase) || head.phase === 'interrupted' || unknownEffect) {
          throw failure('NATIVE_RUN_RECOVERY_REQUIRED', previous.snapshot);
        }
      }
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
      kernel.start({ scope, runId, sessionId, turnId: String(turn), buildId: binding.buildId, parentRunId: null,
        taskChainId: binding.taskChainId ?? sessionId }, configuration);
      let snapshot;
      try {
        snapshot = await kernel.runUntilIdle(scope, runId, { signal });
        while (!terminal(snapshot.phase)) {
          signal.throwIfAborted();
          if (!onIdle) throw failure('NATIVE_TURN_SUSPENDED', snapshot);
          const command = await resolveWhileLive(() => onIdle(payload, structuredClone(snapshot)), payload);
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
          kernel.submit(scope, runId, { commandId: `${runId}:dsh-turn-cancel`, kind: 'cancel', payload: {} });
          try { await kernel.runUntilIdle(scope, runId); }
          catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Native cancellation requires recovery'); }
        }
        throw error;
      }
      if (snapshot.phase === 'canceled') { signal.throwIfAborted(); throw failure('NATIVE_TURN_CANCELED', snapshot); }
      if (snapshot.reason === 'host_input_rejected' && snapshot.outcome === 'blocked') return { reason: { kind: 'blocked' } };
      if (snapshot.phase !== 'completed') throw failure('NATIVE_TURN_FAILED', snapshot);
      return { reason: { kind: snapshot.outcome === 'blocked' ? 'blocked' : 'completed' } };
    } finally { live?.abandon(); active.delete(key); }
  };
}
