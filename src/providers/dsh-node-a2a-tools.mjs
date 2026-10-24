/** Managed A2A for real DSH Agent/Session/call identities. The DSH intent is
 * durable before resolution/dispatch; the shared transport checkpoints the
 * original remote task. Neither unknown receipt permits another SendMessage. */
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { canonical, copy, invariant, toolInputRejection } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createDshA2aToolPort, nativeA2aToolDefinitions } from '../../packages/agentkit-harness/src/native/a2a-tools.mjs';
import { prepareDshA2AHost } from './native-a2a-host.mjs';
import { commandStateRoot, commandDigest, DshNodeCommandLedger } from './dsh-node-command-ledger.mjs';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_NODE_A2A_CONTRACT = 'agentkit.dsh-node-a2a-tools/v1';
const errorResult = code => ({ status: 'error', content: { ok: false, error_type: code, executed: false } });
function abortable(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function createDshNodeA2aTools({ ctx, agentId, agentRevision = 1, buildId = null, workspaceRoot, stateDir,
  env = {}, bindings = [], fetchImpl, sessionEvents, isClosed = () => false, signal: hostSignal } = {}) {
  invariant(typeof agentId === 'string' && agentId.trim() && Number.isSafeInteger(agentRevision) && agentRevision >= 1
    && (buildId === null || typeof buildId === 'string' && buildId.trim()) && typeof isClosed === 'function'
    && (hostSignal === undefined || hostSignal instanceof AbortSignal), 'dsh_a2a_binding_invalid');
  const prepared = prepareDshA2AHost({ env: { ...env }, bindings: copy(bindings), ...(fetchImpl ? { fetchImpl } : {}),
    ...(sessionEvents ? { sessionEvents } : {}) });
  const definitions = nativeA2aToolDefinitions(), formal = new Map(definitions.map(definition => [definition.name, definition]));
  const lifetime = new AbortController(), ownerSignal = AbortSignal.any([lifetime.signal, ...(hostSignal ? [hostSignal] : [])]);
  const state = commandStateRoot(join(stateDir, 'a2a'), workspaceRoot, agentId), sessions = new Map(), owners = new Set();
  // Reopen committed projection delivery at preset startup. No session/model
  // turn, approval, GetTask or SendMessage is created by this recovery path.
  if (prepared) for (const name of readdirSync(state.root).filter(value => /^[a-f0-9]{64}$/u.test(value)).sort())
    prepared.restoreEvents({ stateRoot: join(state.root, name, 'remote-calls'), workspaceRoot: state.workspace });
  const binding = Object.freeze({ contract: DSH_NODE_A2A_CONTRACT, agentId, agentRevision, buildId,
    host: prepared?.binding ?? null, digest: commandDigest({ agentId, agentRevision, buildId, host: prepared?.binding ?? null }) });
  const assertOpen = () => {
    ownerSignal.throwIfAborted();
    const closed = isClosed();
    if (closed && typeof closed.then === 'function') Promise.resolve(closed).catch(() => {});
    invariant(closed === false, 'dsh_a2a_closed');
    state.guard(); ownerSignal.throwIfAborted();
  };
  const sessionFor = sessionId => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, new DshNodeCommandLedger({ root: state.root, agentId, sessionId, assertRoot: state.guard }));
    return sessions.get(sessionId);
  };
  const ownedCall = (ledger, callId) => {
    let record;
    try { record = ledger.read(ledger.entry(callId)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    invariant(record?.request.call.name === 'call_a2a_agent'
      && record.request.operationKey === `dsh-a2a:${callId}` && canonical(record.binding) === canonical(binding), 'DSH_A2A_CALL_NOT_OWNED');
    return record;
  };
  let closing;
  return { contract: DSH_NODE_A2A_CONTRACT,
    get binding() { return copy(binding); }, get definitions() { return copy(definitions); }, supports: name => formal.has(name),
    taskHistory({ sessionId, offset = 0, limit = 64, inventoryDigest }, assertCurrent) {
      assertOpen(); invariant(typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256
        && Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 64
        && typeof assertCurrent === 'function' && assertCurrent() === true, 'DSH_A2A_HISTORY_INVALID');
      const ledger = sessionFor(sessionId), tasks = [];
      for (const name of readdirSync(ledger.root).filter(name => /^[a-f0-9]{64}$/u.test(name)).sort()) {
        const record = ledger.read(join(ledger.root, name));
        if (!record || record.request.call.name !== 'call_a2a_agent') continue;
        invariant(record.request.operationKey === `dsh-a2a:${record.request.call.callId}`, 'DSH_A2A_CALL_NOT_OWNED');
        tasks.push({ agentId, sessionId, agentRevision: record.request.agentRevision, buildId: record.request.buildId,
          operationKey: record.request.operationKey, callId: record.request.call.callId });
      }
      const digest = commandDigest(tasks);
      invariant(inventoryDigest === undefined || inventoryDigest === digest, 'DSH_A2A_INVENTORY_CHANGED');
      assertOpen(); invariant(assertCurrent() === true, 'DSH_A2A_CONTROL_AUTHORITY_LOST');
      return { contract: 'agentkit.studio-dsh-a2a-inventory/v1', applicable: true, agentId, sessionId,
        inventoryDigest: digest, offset, total: tasks.length, complete: offset + limit >= tasks.length, items: tasks.slice(offset, offset + limit) };
    },
    async controlTask({ sessionId, callId, agentRevision: revision, buildId: build, ...input }, { assertCurrent, authorizeControl }) {
      assertOpen(); invariant(prepared && typeof sessionId === 'string' && sessionId.trim() && sessionId.length <= 256
        && typeof callId === 'string' && callId.trim() && callId.length <= 256 && revision === agentRevision && build === buildId
        && typeof assertCurrent === 'function' && typeof authorizeControl === 'function' && assertCurrent() === true, 'DSH_A2A_CONTROL_INVALID');
      const ledger = sessionFor(sessionId), record = ownedCall(ledger, callId);
      const owner = prepared.forSession({ agentId, agentRevision, buildId, sessionId, workspaceRoot: state.workspace,
        stateRoot: join(ledger.root, 'remote-calls'), assertCurrent: () => false,
        assertControl: () => { assertOpen(); ownedCall(ledger, callId); return assertCurrent(); }, authorizeControl });
      owners.add(owner);
      try {
        return await owner.control.execute({ ...input, signal: AbortSignal.any([input.signal, ownerSignal]),
          operation_locator: { agentId, agentRevision, buildId, sessionId, operationKey: record.request.operationKey, callId } });
      } finally {
        await Promise.allSettled([Promise.resolve().then(() => owner.eventDelivery?.flushSession?.({ raiseOnError: false }))]);
        owner.close(); owners.delete(owner);
      }
    },
    close() {
      if (closing) return closing;
      lifetime.abort(); for (const owner of owners) owner.close(); owners.clear(); sessions.clear();
      return closing = Promise.resolve(prepared?.close());
    },
    async execute(name, args, exec) {
      let request, assertCurrent;
      try {
        assertOpen(); const definition = formal.get(name);
        invariant(definition && exec?.name === name && typeof exec?.agent?.session?.id === 'string' && exec.agent.session.id.trim()
          && typeof exec.callId === 'string' && exec.callId.trim() && exec.signal instanceof AbortSignal, 'dsh_a2a_request_unbound');
        const rejection = toolInputRejection(definition, { callId: exec.callId, name, arguments: args });
        if (rejection) return { status: 'error', content: rejection };
        const original = { agent: exec.agent, session: exec.agent.session, sessionId: exec.agent.session.id,
          callId: exec.callId, signal: exec.signal, args: canonical(args) };
        request = { agentId, agentRevision, buildId, sessionId: original.sessionId, operationKey: `dsh-a2a:${original.callId}`,
          call: { callId: original.callId, name, arguments: copy(args) }, definition: copy(definition),
          signal: AbortSignal.any([original.signal, ownerSignal, AbortSignal.timeout(definition.timeoutMs)]) };
        const stable = () => {
          request.signal.throwIfAborted();
          invariant(exec.agent === original.agent && exec.agent.session === original.session && exec.agent.session.id === original.sessionId
            && exec.callId === original.callId && exec.signal === original.signal && exec.name === name && canonical(args) === original.args
            && canonical(exec.arguments) === original.args, 'dsh_a2a_request_drifted');
        };
        assertCurrent = () => { stable(); assertOpen(); stable(); return true; };
        assertCurrent();
        await abortable(() => authorizeNativeBuiltin(ctx, { ...exec, signal: request.signal }, definition), request.signal); assertCurrent();
        if (!prepared) return errorResult('A2A_SPACE_NOT_CONFIGURED');
        const ledger = sessionFor(original.sessionId);
        const dispatch = async () => {
          assertCurrent();
          const owner = prepared.forSession({ agentId, agentRevision, buildId, sessionId: original.sessionId, workspaceRoot: state.workspace,
            stateRoot: join(ledger.root, 'remote-calls'), assertCurrent });
          owners.add(owner);
          try {
            const tools = createDshA2aToolPort({ agentId, agentRevision, buildId, sessionId: original.sessionId,
              spaceId: prepared.spaceId, ...owner, assertCurrent, authorize: async () => { assertCurrent(); return 'allow'; } });
            const result = await tools.execute(request);
            // The shared port preserves an uncertain locator when authority was
            // lost after Send. Do not replace that receipt with a pre-effect error.
            if (result.status !== 'uncertain') assertCurrent();
            return result;
          } finally {
            await Promise.allSettled([Promise.resolve().then(() => owner.eventDelivery?.flushSession?.({ raiseOnError: false }))]);
            owner.close(); owners.delete(owner);
          }
        };
        return definition.readOnly ? await dispatch() : await ledger.execute({ request, binding, assertCurrent, dispatch });
      } catch (error) {
        try { assertCurrent?.(); } catch (current) { error = current; }
        return errorResult(/^dsh_a2a_|^dsh_node_command_|^A2A_/u.test(error?.code ?? '') ? error.code : 'dsh_a2a_rejected');
      }
    },
  };
}
