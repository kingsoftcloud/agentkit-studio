/** Interactive E2B commands for real DSH Agent/Session/call ownership. The
 * fsynced DSH ledger surrounds SDK/lifecycle entry; supervisors own commands
 * after the requesting turn ends. No Native Run or execution fence is invented. */
import { join } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createDshE2BCommandTools, e2bCommandToolDefinitions } from '../../packages/agentkit-harness/src/native/e2b-command-tools.mjs';
import { E2BCommandStore, e2bCommandId, e2bCommandOwner } from '../../packages/agentkit-harness/src/native/e2b-background.mjs';
import { DshNodeCommandLedger, commandDigest, commandStateRoot } from './dsh-node-command-ledger.mjs';
import { createDshNodeToolOutputStore } from './dsh-node-tool-output-store.mjs';
import { prepareDshE2BHost } from './native-e2b-host.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_NODE_E2B_COMMAND_CONTRACT = 'agentkit.dsh-node-e2b-command-tools/v1';
const transportModule = new URL('./native-e2b-sdk-transport.mjs', import.meta.url).href;
const fail = code => Object.assign(new Error(code), { code });
const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
function abortable(pending, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(fail('dsh_e2b_command_canceled')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

export function createDshNodeE2BCommandTools({ ctx, agentId, agentRevision = 1, buildId = null, workspaceRoot, stateDir,
  env = {}, loadSdk, isClosed = () => false, signal: hostSignal, persistOutput } = {}) {
  invariant(['darwin', 'linux'].includes(process.platform), 'dsh_e2b_command_platform_unsupported');
  invariant(ctx && typeof agentId === 'string' && agentId.trim() && typeof isClosed === 'function'
    && (hostSignal === undefined || hostSignal instanceof AbortSignal), 'dsh_e2b_command_binding_invalid');
  invariant(Number.isSafeInteger(agentRevision) && agentRevision >= 1 && (buildId === null || typeof buildId === 'string' && buildId.trim()),
    'dsh_e2b_command_revision_invalid');
  invariant(persistOutput === undefined || typeof persistOutput === 'function', 'dsh_e2b_command_output_invalid');
  const prepared = prepareDshE2BHost({ env: { ...env }, ...(loadSdk ? { loadSdk } : {}) });
  const state = commandStateRoot(stateDir, workspaceRoot, agentId);
  const definitions = e2bCommandToolDefinitions(prepared.binding.timeoutSeconds), formal = new Map(definitions.map(d => [d.name, copy(d)]));
  const binding = Object.freeze({ contract: DSH_NODE_E2B_COMMAND_CONTRACT, backend: 'e2b',
    digest: commandDigest({ agentId, agentRevision, buildId, host: prepared.binding }) });
  const lifetime = new AbortController(), ownerSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const output = persistOutput === undefined ? createDshNodeToolOutputStore({ directory: join(state.root, 'e2b-output'), agentId,
    isClosed, signal: ownerSignal, toolDefinitions: definitions }) : null;
  const persist = persistOutput ?? output.persistOutput, sessions = new Map();
  const assertOpen = () => {
    invariant(!ownerSignal.aborted, 'dsh_e2b_command_closed');
    const closed = isClosed();
    if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
    invariant(closed === false, closed === true ? 'dsh_e2b_command_closed' : 'dsh_e2b_command_lifetime_invalid');
    state.guard(); invariant(!ownerSignal.aborted, 'dsh_e2b_command_closed');
  };
  function sessionFor(sessionId) {
    if (!sessions.has(sessionId)) sessions.set(sessionId,
      new DshNodeCommandLedger({ root: state.root, agentId, sessionId, assertRoot: state.guard }));
    return sessions.get(sessionId);
  }
  return { contract: DSH_NODE_E2B_COMMAND_CONTRACT,
    get binding() { return { ...copy(binding), host: copy(prepared.binding) }; },
    get definitions() { return copy(definitions); },
    supports: name => formal.has(name),
    close() { lifetime.abort(); output?.close(); sessions.clear(); },
    async execute(name, args, exec) {
      const definition = formal.get(name); if (!definition) return errorResult('dsh_e2b_command_unbound');
      let dispatched = false, request, taskId;
      try {
        assertOpen();
        invariant(exec?.agent?.session && typeof exec.agent.session.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.name === name && exec.signal instanceof AbortSignal,
        'dsh_e2b_command_exec_unbound');
        const rejection = toolInputRejection(definition, { callId: exec.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, signal: exec.signal, args: canonical(args) };
        request = { agentId, sessionId: original.sessionId, operationKey: `dsh-e2b-command:${original.callId}`,
          call: { callId: original.callId, name, arguments: copy(args) }, definition: copy(definition),
          signal: AbortSignal.any([original.signal, ownerSignal, AbortSignal.timeout(definition.timeoutMs)]) };
        const assertCurrent = () => {
          const stable = () => {
            request.signal.throwIfAborted();
            invariant(exec.agent === original.agent && exec.agent.session === original.session && exec.agent.session.id === original.sessionId
              && exec.callId === original.callId && exec.signal === original.signal && exec.name === name
              && canonical(args) === original.args && canonical(exec.arguments) === original.args, 'dsh_e2b_command_request_drifted');
          };
          stable(); assertOpen(); stable(); return true;
        };
        assertCurrent(); await abortable(authorizeNativeBuiltin(ctx, exec, definition), request.signal); assertCurrent();
        const ledger = sessionFor(original.sessionId);
        if (name === 'read_command_output' || name === 'stop_command') ledger.resolveOwned(request, args.task_id, binding);
        taskId = name === 'run_command' ? e2bCommandId(e2bCommandOwner(state.workspace, original.sessionId), request.operationKey)
          : args.task_id;
        const dispatch = async () => {
          assertCurrent();
          // Verify task ownership before SDK import as well as inside the shared
          // command port. An arbitrary task ID never grants remote authority.
          if (name === 'read_command_output' || name === 'stop_command') ledger.resolveOwned(request, args.task_id, binding);
          dispatched = definition.readOnly !== true;
          const host = await abortable(prepared.forSession({ agentId, sessionId: original.sessionId, workspaceRoot: state.workspace,
            stateRoot: join(ledger.root, 'e2b-sandbox'), assertAuthority: assertCurrent }), request.signal);
          assertCurrent(); host.owner.inspect();
          const transport = loadSdk ? await abortable(host.createTransport(), request.signal) : null;
          assertCurrent(); let store;
          const tools = createDshE2BCommandTools({ agentId, sessionId: original.sessionId, owner: host.owner,
            foregroundTimeoutSeconds: prepared.binding.timeoutSeconds, backgroundTimeoutSeconds: prepared.binding.timeoutSeconds,
            allowInternetAccess: prepared.binding.allowInternetAccess, assertAuthority: assertCurrent,
            authorize: async () => { assertCurrent(); return 'allow'; },
            resolveOwnedCommand: (value, id) => ledger.resolveOwned(value, id, binding),
            storeFactory(input) {
              assertCurrent(); invariant(input.agentId === agentId && input.sessionId === original.sessionId, 'dsh_e2b_command_store_unbound');
              const owner = host.owner.inspect(); invariant(owner?.sandboxId, 'dsh_e2b_command_sandbox_unavailable');
              if (input.sandboxId !== undefined) invariant(owner.phase === 'ready' && owner.sandboxId === input.sandboxId,
                'dsh_e2b_command_sandbox_unproven');
              return store ??= new E2BCommandStore({ stateRoot: join(ledger.root, 'e2b-processes'), workspaceRoot: state.workspace,
                sessionId: original.sessionId, sandboxId: owner.sandboxId, launchAuthorized: false,
                transportModule, transportConfig: host.transportOptions(), ...(transport ? { transport } : {}),
                authority: frozen => { assertCurrent(); const current = host.owner.inspect();
                  return current?.phase === 'ready' && current.sandboxId === frozen.sandboxId; } });
            },
            artifacts: { async write(value) {
              assertCurrent(); const ref = await abortable(persist(value, value.content, { toolName: name, mediaType: value.mediaType,
                fullBytes: Buffer.byteLength(value.content), reachedByteCeiling: false }), request.signal);
              assertCurrent(); return ref;
            } } });
          const result = await tools.execute(request);
          return result.status === 'uncertain' ? { ...result, content: { ...result.content,
            ...(taskId ? { task_id: taskId } : {}), status: 'uncertain', backend: 'sandbox/e2b' } } : result;
        };
        const result = definition.readOnly === true ? await dispatch() : await ledger.execute({ request, binding,
          taskId: taskId ?? null, assertCurrent, dispatch });
        ledger.publishTask(request, result);
        return result;
      } catch (error) {
        return dispatched ? { status: 'uncertain', content: { ok: false, error_type: 'dsh_e2b_command_outcome_unknown',
          status: 'uncertain', backend: 'sandbox/e2b', evidence_incomplete: true, agentId, sessionId: request.sessionId, callId: request.call.callId,
          operationKey: request.operationKey, ...(taskId ? { task_id: taskId } : {}) } }
          : errorResult(error?.code ?? 'dsh_e2b_command_failed');
      }
    } };
}
