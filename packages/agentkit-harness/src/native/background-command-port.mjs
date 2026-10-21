// Observe existing command handles through the canonical launch receipt. This
// port has no launch, stop, approval or model capability; those are separate
// durable tool/Host operations. Backend selection never falls back to the env.
import { BACKGROUND_COMMAND_CONTRACT, backgroundCommandObservation, backgroundCommandRef,
  commandProbe, canonical, copy, NativeError } from '../../../agentkit-harness-core/dist/index.mjs';
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
