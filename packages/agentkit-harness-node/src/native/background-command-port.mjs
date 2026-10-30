// Observe existing command handles through the canonical launch receipt. This
// port has no launch, stop, approval or model capability; those are separate
// durable tool/Host operations. Backend selection never falls back to the env.
import { BACKGROUND_COMMAND_CONTRACT, backgroundCommandObservation, backgroundCommandRef,
  commandProbe, canonical, copy, NativeError, BACKGROUND_NOTIFICATION_ADMISSION } from '@kingsoftcloud/agentkit-harness-core';
import { ownedCommandReceipt } from './owned-command.mjs';

const backends = new Set(['local_process', 'e2b']);
const check = (value, code) => { if (!value) throw new NativeError(code); };
const same = (left, right) => canonical(left) === canonical(right);

/** readers[backend] performs one nonblocking, read-only handle lookup. */
export function createBackgroundCommandPort({ scope, store, readers = {} }) {
  const pinnedScope = copy(scope), bindings = Object.fromEntries(Object.entries(readers));
  check(Object.entries(bindings).every(([backend, reader]) => backends.has(backend) && typeof reader === 'function'),
    'invalid_background_command_readers');
  return Object.freeze({
    contract: BACKGROUND_COMMAND_CONTRACT,
    /** Controlled idle admission reads the original receipt, never environment
     * hints. This method cannot create a turn or mutate the backend. */
    async observeCompletion(request) {
      const signal = request.signal;
      check(signal instanceof AbortSignal, 'background_notification_signal_invalid');
      const { signal: _, ...body } = request, sealed = canonical(body);
      let original;
      const current = () => {
        signal.throwIfAborted();
        const { signal: liveSignal, ...live } = request;
        check(liveSignal === signal && canonical(live) === sealed && same(request.scope, pinnedScope), 'background_notification_request_drift');
        const source = store.load(pinnedScope, request.sourceRunId), snapshot = source.snapshot;
        const head = store.sessionHead(pinnedScope, snapshot.sessionId);
        const ref = backgroundCommandRef(request.ref);
        check(same(body, { contract: BACKGROUND_NOTIFICATION_ADMISSION, scope: pinnedScope, sourceRunId: snapshot.runId,
          sessionId: snapshot.sessionId, sourceConfigDigest: snapshot.configDigest, sourceRevision: snapshot.revision,
          headRunId: head?.runId, ref }) && snapshot.phase === 'completed' && head?.phase === 'completed'
          && ref.sourceRunId === snapshot.runId && snapshot.backgroundCommands.some(row => same(row.ref, ref) && !row.notified)
          && head.backgroundCommands.some(row => same(row.ref, ref) && !row.notified), 'background_notification_read_unbound');
        if (original) check(same(original, source), 'background_notification_read_changed');
        else original = source;
        return { ...ownedCommandReceipt({ scope: pinnedScope, store, current: source, ref }), source };
      };
      const { ref, backend, source } = current();
      if (!backend || !bindings[backend]) return backgroundCommandObservation({ ref, status: 'unavailable' });
      let output;
      try {
        output = await bindings[backend]({ scope: copy(pinnedScope), sessionId: source.snapshot.sessionId,
          runId: source.snapshot.runId, ref: copy(ref), stdoutCursor: 0, stderrCursor: 0, maxBytes: 8192, waitSeconds: 0, signal });
      } catch {
        current(); return backgroundCommandObservation({ ref, status: 'unavailable' });
      }
      current();
      if (['starting', 'running'].includes(output?.status)) return null;
      try {
        check(output && typeof output === 'object' && !Array.isArray(output), 'invalid_background_command_output');
        return backgroundCommandObservation({ ...output, ref,
          outputMayBeTruncated: output.outputMayBeTruncated === true || output.stdoutCursor >= 8192 || output.stderrCursor >= 8192 });
      } catch { return backgroundCommandObservation({ ref, status: 'unavailable' }); }
    },
    async observe(request) {
      request.signal.throwIfAborted();
      check(same(request.scope, pinnedScope), 'background_command_scope_mismatch');
      const current = store.load(pinnedScope, request.runId);
      const config = current.snapshot.taskContract ? { ...current.configuration, contract: current.snapshot.taskContract } : current.configuration;
      const intent = current.intents.find(item => item.operationKey === current.snapshot.pendingIntent) ?? null;
      const expected = commandProbe(current.snapshot, config, intent), { signal, ...plain } = request;
      check(expected && same(expected, plain), 'background_command_owner_mismatch');
      check(new Set(request.refs.map(ref => ref.taskId)).size === request.refs.length, 'background_command_owner_mismatch');
      // Verify the entire request before touching any external handle.
      const owned = request.refs.map(candidate => {
        return ownedCommandReceipt({ scope: pinnedScope, store, current, ref: backgroundCommandRef(candidate) });
      });
      const observations = [];
      for (const { ref, backend } of owned) {
        signal.throwIfAborted();
        const unavailable = () => backgroundCommandObservation({ ref, status: 'unavailable' });
        if (!backend || !bindings[backend]) observations.push(unavailable());
        else {
          try {
            const output = await bindings[backend]({ scope: copy(pinnedScope), sessionId: current.snapshot.sessionId,
              runId: request.runId, ref: copy(ref), stdoutCursor: 0, stderrCursor: 0, maxBytes: 8192, waitSeconds: 0, signal });
            signal.throwIfAborted();
            check(output && typeof output === 'object' && !Array.isArray(output), 'invalid_background_command_output');
            check(output.outputMayBeTruncated === undefined || typeof output.outputMayBeTruncated === 'boolean', 'invalid_background_command_output');
            if (['starting', 'running'].includes(output.status)) continue;
            observations.push(backgroundCommandObservation({ ...output, ref,
              outputMayBeTruncated: output.outputMayBeTruncated === true || output.stdoutCursor >= 8192 || output.stderrCursor >= 8192,
            }));
          } catch (error) { signal.throwIfAborted(); observations.push(unavailable()); }
        }
        if (observations.length === 8) break;
      }
      return observations;
    },
  });
}
