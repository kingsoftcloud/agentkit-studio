/** Node command bodies for the real DSH registry (Native and Codex runtimes).
 * DSH retains its complete policy/hook pipeline. Calls use real Session/call
 * identities; the shared transport owns process supervision and output.
 */
import { join } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';
import { createLocalCommandTransport, localCommandToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/local-command-tools';
import { buildScriptEnvironment, localControlSettings } from '@kingsoftcloud/agentkit-harness-node/native/local-process';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { DshNodeCommandLedger, commandDigest, commandStateRoot } from './dsh-node-command-ledger.mjs';
import { createDshNodeToolOutputStore } from './dsh-node-tool-output-store.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_NODE_COMMAND_CONTRACT = 'agentkit.dsh-node-command-tools/v1';
const fail = code => Object.assign(new Error(code), { code });
const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(fail('dsh_node_command_canceled')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
export function createDshNodeCommandTools({ ctx, workspaceRoot, stateDir, agentId,
  settings = {}, env = {}, isClosed = () => false, signal: hostSignal, persistOutput } = {}) {
  invariant(ctx && typeof agentId === 'string' && agentId.trim() && typeof isClosed === 'function',
    'dsh_node_command_binding_invalid');
  invariant(hostSignal === undefined || hostSignal instanceof AbortSignal, 'dsh_node_command_host_signal_invalid');
  invariant(persistOutput === undefined || typeof persistOutput === 'function', 'dsh_node_command_output_invalid');
  const state = commandStateRoot(stateDir, workspaceRoot, agentId), policy = localControlSettings(settings);
  const environment = buildScriptEnvironment({ ...env }, { settings: policy });
  const definitions = localCommandToolDefinitions(policy), formal = new Map(definitions.map(item => [item.name, copy(item)]));
  const binding = { contract: DSH_NODE_COMMAND_CONTRACT, digest: commandDigest({ policy, environment }) };
  const lifetime = new AbortController();
  const ownerSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const output = persistOutput === undefined ? createDshNodeToolOutputStore({ directory: join(state.root, 'output'), agentId,
    isClosed, signal: ownerSignal, toolDefinitions: definitions }) : null;
  const persist = persistOutput ?? output.persistOutput;
  const sessions = new Map();
  const assertOpen = () => {
    invariant(!ownerSignal.aborted, 'dsh_node_command_closed');
    const closed = isClosed();
    if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
    invariant(closed === false, closed === true ? 'dsh_node_command_closed' : 'dsh_node_command_is_closed_invalid');
    state.guard();
  };
  function sessionFor(sessionId) {
    if (!sessions.has(sessionId)) sessions.set(sessionId, {
      ledger: new DshNodeCommandLedger({ root: state.root, agentId, sessionId, assertRoot: state.guard }),
      workspace: createNativeWorkspaceTools({ workspaceRoot, stateDir: join(state.root, 'capture'), sessionId }),
    });
    return sessions.get(sessionId);
  }
  return {
    contract: DSH_NODE_COMMAND_CONTRACT,
    get definitions() { return copy(definitions); },
    supports: name => formal.has(name),
    close() { lifetime.abort(fail('dsh_node_command_closed')); output?.close(); sessions.clear(); },
    async execute(name, args, exec) {
      const definition = formal.get(name);
      if (!definition) return errorResult('dsh_node_command_unbound');
      let request, assertCurrent, dispatched = false;
      try {
        assertOpen();
        invariant(exec?.agent?.session && typeof exec.agent.session.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.name === name
          && exec.signal instanceof AbortSignal, 'dsh_node_command_exec_unbound');
        const rejection = toolInputRejection(definition, { callId: exec.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        const argsJson = canonical(args);
        invariant(canonical(exec.arguments) === argsJson, 'dsh_node_command_arguments_mismatch');
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, signal: exec.signal, name };
        request = { agentId, sessionId: original.sessionId,
          call: { callId: original.callId, name, arguments: copy(args) }, definition: copy(definition),
          operationKey: `dsh-node-command:${original.callId}`, signal: AbortSignal.any([original.signal, ownerSignal]) };
        assertCurrent = () => {
          assertOpen(); request.signal.throwIfAborted();
          invariant(exec.agent === original.agent && exec.agent.session === original.session
            && exec.agent.session.id === original.sessionId && exec.callId === original.callId
            && exec.signal === original.signal && exec.name === original.name
            && canonical(args) === argsJson && canonical(exec.arguments) === argsJson,
          'dsh_node_command_request_drifted');
          return true;
        };
        assertCurrent();
        await abortable(authorizeNativeBuiltin(ctx, exec, definition), request.signal); assertCurrent();
        const { ledger, workspace } = sessionFor(original.sessionId);
        const transport = createLocalCommandTransport({ workspaceRoot, stateRoot: join(state.root, 'processes'),
          sessionId: original.sessionId, settings: policy, sourceEnv: environment, durableForeground: true,
          assertAuthority: assertCurrent, authorize: async () => { assertCurrent(); return 'allow'; },
          captureWorkspace: value => workspace.capture(value),
          resolveOwnedCommand: (value, taskId) => ledger.resolveOwned(value, taskId, binding),
          artifacts: { async write(value) {
            assertCurrent(); const ref = await abortable(persist(value, value.content, { toolName: name, mediaType: value.mediaType,
              fullBytes: Buffer.byteLength(value.content), reachedByteCeiling: false }), request.signal);
            assertCurrent(); return ref;
          } } });
        const dispatch = async () => {
          assertCurrent(); dispatched = definition.readOnly !== true;
          const { launchedCommand: _, ...result } = await transport.execute(request);
          return result;
        };
        // Read output remains a live safe read. Only mutations are deduplicated.
        const result = definition.readOnly === true ? await dispatch() : await ledger.execute({ request, binding,
          taskId: name === 'run_command' ? transport.commandId(request.operationKey) : null,
          assertCurrent, dispatch });
        // Commit/publish original evidence even after a post-effect abort. A
        // saved uncertain result can never be silently promoted to success.
        ledger.publishTask(request, result);
        return result;
      } catch (error) {
        if (dispatched) return { status: 'uncertain', content: { ok: false, error_type: 'dsh_node_command_outcome_unknown',
          evidence_incomplete: true } };
        return errorResult(error.code ?? 'dsh_node_command_failed');
      }
    },
  };
}
