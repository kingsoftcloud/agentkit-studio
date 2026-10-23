/** The legacy snippet tool always requires isolation. Local selection still
 * owns the formal tool and rejects execution, so it cannot enter Python. */
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { e2bCodeToolDefinitions } from '../../packages/agentkit-harness/src/native/e2b-command-tools.mjs';
import { createDshNodeE2BCodeTools } from './dsh-node-e2b-command-tools.mjs';
import { nativeCommandBackend } from './native-e2b-host.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';
import { SANDBOX_CODE_NAME } from './sandbox-code-name.mjs';

function waitFor(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function createDshNodeCodeTools(options = {}) {
  if (nativeCommandBackend(options.env) === 'e2b') return createDshNodeE2BCodeTools(options);
  const definition = e2bCodeToolDefinitions(300, SANDBOX_CODE_NAME)[0], lifetime = new AbortController();
  const owner = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]);
  return { contract: 'agentkit.dsh-node-local-code-rejection/v1',
    get definitions() { return [copy(definition)]; }, supports: name => name === SANDBOX_CODE_NAME, close: () => lifetime.abort(),
    async execute(name, args, exec) {
      try {
        invariant(name === SANDBOX_CODE_NAME && exec?.name === name && exec.agent?.session?.id
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.signal instanceof AbortSignal, 'dsh_code_request_unbound');
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, signal: exec.signal, args: canonical(args) };
        const guard = () => {
          owner.throwIfAborted(); original.signal.throwIfAborted();
          const closed = options.isClosed ? options.isClosed() : false;
          if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
          invariant(closed === false && exec.agent === original.agent && exec.agent.session === original.session
            && exec.agent.session.id === original.sessionId && exec.callId === original.callId && exec.signal === original.signal
            && exec.name === name && canonical(args) === original.args && canonical(exec.arguments) === original.args, 'dsh_code_request_drifted');
          owner.throwIfAborted(); original.signal.throwIfAborted();
        };
        guard(); const rejection = toolInputRejection(definition, { callId: exec.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        await waitFor(authorizeNativeBuiltin(options.ctx, exec, definition),
          AbortSignal.any([owner, original.signal, AbortSignal.timeout(definition.timeoutMs)])); guard();
        return { status: 'error', content: { ok: false, error_type: 'isolated_sandbox_required', backend: 'local_process',
          executed: false, boundary: 'run_code requires an isolated sandbox; local snippet execution is disabled.' } };
      } catch (error) { return { status: 'error', content: { ok: false, error_type: error.code ?? 'dsh_code_request_rejected', executed: false } }; }
    } };
}
