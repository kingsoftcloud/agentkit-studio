/**
 * DSH Node workspace tools adapter for the legacy Codex builtin Python bridge.
 *
 * The parent (Codex-owned Host/runtime bridge) registers the ten formal
 * workspace tool definitions returned here and routes the real DSH
 * ToolExecution into `execute`. This adapter does NOT fabricate a Native Run,
 * scope, lease or fence, and it never calls ctx.tools.register: the parent
 * owns registration, and the full DSH pre/guard/around/post pipeline still
 * runs around every call. Inside that admitted pipeline this adapter:
 *
 *  - reuses the real createNativeWorkspaceTools port for file editing, so no
 *    file-editing algorithm is copied;
 *  - validates formal parameters with the core toolInputRejection before
 *    trusting anything, and fails closed without a real Session/callId/Signal;
 *  - routes every mutating call through the real authorizeNativeBuiltin
 *    pipeline (standing sandboxPolicy + one-shot approval), and never treats a
 *    DSH registration allow as a permanent permission;
 *  - seals the call args/formal/exec identity across every await and verifies
 *    !closed/isClosed/exec+Session+callId+signal+args before and after
 *    permission and after the shared workspace mutation lock;
 *  - returns the original Native ToolResult (status/content/
 *    workspaceChangedPaths, including uncertain) without swallowing errors.
 *
 * State is fixed at construction: a stateRoot under stateDir namespaced by the
 * trusted agentId plus a digest of the workspace root, then per real Session
 * beneath that. Read-before-edit state persists on disk, so a reopened adapter
 * or a new process keeps the actual read state; cross-Agent/Session never share
 * it. The state root may not be the workspace, inside it, or contain it.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { canonical, copy, invariant, toolInputRejection } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { authorizeNativeBuiltin } from './native-tool-policy.mjs';

export const DSH_NODE_WORKSPACE_CONTRACT = 'agentkit.dsh-node-workspace/v1';

const sha256Hex = value => createHash('sha256')
  .update(typeof value === 'string' ? value : canonical(value)).digest('hex');

/** Resolve through symlinks for the existing portion of a path, leaving a
 *  non-existent tail lexical (mirrors pathlib.Path.resolve(strict=False) and
 *  the workspace port's realpathExisting). Necessary because macOS /tmp is a
 *  symlink to /private/tmp: comparing a realpath'd root against a lexically
 *  resolved (un-resolved) state path would miss a nesting. */
function resolveReal(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    try { return realpathSync(absolute); } catch { return absolute; }
  }
  const tail = [];
  let head = absolute;
  while (!existsSync(head)) {
    const base = dirname(head);
    if (base === head) break; // reached filesystem root
    tail.unshift(head.slice(base.length + 1) || head.slice(base.length));
    head = base;
  }
  const realHead = existsSync(head) ? realpathSync(head) : head;
  return tail.length ? join(realHead, ...tail) : realHead;
}

/** True when target is root or located beneath root (both absolute). */
function isInside(target, root) {
  if (target === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(rootWithSep);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const authorityLost = code => Object.assign(new Error(code), { code });
const errorResult = (code, message) => ({
  status: 'error',
  content: { code, executed: false, ...(message ? { message } : {}) },
});

/**
 * Build the DSH Node workspace tool adapter.
 *
 * @param {object} opts
 * @param {object} opts.ctx Host context carrying sandboxPolicy/approval (used
 *   by authorizeNativeBuiltin). The parent owns ctx.tools.register.
 * @param {string} opts.workspaceRoot Trusted workspace root (pinned once).
 * @param {string} opts.stateDir External Host store dir; never inside the
 *   workspace. The model cannot control the state path.
 * @param {string} opts.agentId Trusted bound agent id from the constructor;
 *   never confused with a DSH Agent.id.
 * @param {() => boolean} [opts.isClosed] Optional Host-side closed signal.
 * @returns {{contract,definitions,supports(name):boolean,execute(name,args,exec):Promise<object>,close()}}
 */
export function createDshNodeWorkspaceTools({ ctx, workspaceRoot, stateDir, agentId, isClosed = () => false } = {}) {
  invariant(typeof workspaceRoot === 'string' && workspaceRoot.trim(), 'dsh_node_workspace_root_missing');
  invariant(typeof stateDir === 'string' && stateDir.trim(), 'dsh_node_workspace_state_dir_missing');
  invariant(typeof agentId === 'string' && agentId.trim(), 'dsh_node_workspace_agent_id_missing');
  invariant(typeof isClosed === 'function', 'dsh_node_workspace_is_closed_invalid');
  invariant(ctx && typeof ctx === 'object', 'dsh_node_workspace_ctx_missing');

  const resolvedRoot = resolve(workspaceRoot);
  const rootReal = resolveReal(resolvedRoot);
  const resolvedState = resolve(stateDir);
  const stateReal = resolveReal(resolvedState);
  // The state root must not be the workspace, live inside it, or contain it.
  // The model cannot control the state path and the Host passes an external
  // store dir; reject any overlap at construction (fail closed).
  if (rootReal === stateReal) throw new TypeError('dsh_node_workspace_state_root_conflicts_with_workspace');
  if (isInside(stateReal, rootReal)) throw new TypeError('dsh_node_workspace_state_root_inside_workspace');
  if (isInside(rootReal, stateReal)) throw new TypeError('dsh_node_workspace_workspace_inside_state_root');

  // Per (agentId, workspaceRoot) state namespace, then per real Session beneath.
  // The digest keeps the on-disk path free of caller-supplied separators and
  // isolates state across agents that share the same stateDir.
  const namespace = `${sha256Hex(agentId).slice(0, 16)}-${sha256Hex(resolvedRoot).slice(0, 16)}`;
  const stateRoot = join(resolvedState, namespace);

  // A template instance yields the ten formal definitions without executing;
  // creating it pins the root boundary but writes no state to disk.
  const template = createNativeWorkspaceTools({
    workspaceRoot: resolvedRoot,
    stateDir: join(stateRoot, '__definitions__'),
    sessionId: '__definitions__',
  });
  const formalDefinitions = Object.freeze(template.definitions.map(definition => deepFreeze(copy(definition))));
  const formal = new Map(formalDefinitions.map(definition => [definition.name, definition]));
  const supportedNames = new Set(formal.keys());

  // Per-session workspace tool instances. WorkspaceStateStore persists the
  // read-state on disk under stateRoot/<sha256(sessionId)>, so a new adapter or
  // process with the same stateRoot+sessionId reloads it; cross-Session state
  // is never shared.
  const sessions = new Map();
  function toolsFor(sessionId) {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, createNativeWorkspaceTools({
        workspaceRoot: resolvedRoot,
        stateDir: stateRoot,
        sessionId,
        // The real permission pipeline (authorizeNativeBuiltin) runs in
        // execute before dispatch. This callback may only return allow AFTER
        // that pipeline permitted; it never grants approval on its own.
        authorize: async () => 'allow',
      }));
    }
    return sessions.get(sessionId);
  }

  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    sessions.clear();
  }

  /** Capture the real exec identity. Fail closed without a real
   *  Session/callId/AbortSignal; never substitute a config/default session. The
   *  real DSH ToolExecutionInput carries a readonly `arguments` field that is
   *  the authoritative admitted payload; seal it alongside the function args
   *  and require they agree, so a later swap of exec.arguments during an
   *  approval await is detected as drift rather than a silent divergence. */
  function sealExec(exec, name, args) {
    invariant(exec && typeof exec === 'object', 'dsh_node_workspace_exec_missing');
    invariant(exec.agent && typeof exec.agent === 'object', 'dsh_node_workspace_exec_agent_missing');
    invariant(exec.agent.session && typeof exec.agent.session === 'object', 'dsh_node_workspace_exec_session_missing');
    invariant(typeof exec.agent.session.id === 'string' && exec.agent.session.id.trim(), 'dsh_node_workspace_session_id_missing');
    invariant(typeof exec.callId === 'string' && exec.callId.trim(), 'dsh_node_workspace_call_id_missing');
    invariant(exec.signal instanceof AbortSignal, 'dsh_node_workspace_signal_missing');
    invariant(exec.name === name, 'dsh_node_workspace_exec_name_mismatch');
    const argsSnapshot = canonical(args);
    // exec.arguments is the readonly admitted payload on the real
    // ToolExecutionInput. It must agree with the function args at seal time; a
    // mismatch here is a binding error, not a drift.
    let execArgumentsSnapshot;
    try { execArgumentsSnapshot = canonical(exec.arguments); }
    catch { throw authorityLost('dsh_node_workspace_exec_arguments_invalid'); }
    if (execArgumentsSnapshot !== argsSnapshot) throw authorityLost('dsh_node_workspace_arguments_mismatch');
    return {
      agent: exec.agent,
      session: exec.agent.session,
      sessionId: exec.agent.session.id,
      callId: exec.callId,
      originalSignal: exec.signal,
      name,
      argsSnapshot,
      execArgumentsSnapshot,
      argsCopy: copy(args),
    };
  }

  async function execute(name, args, exec) {
    // Unbound tools must never access.
    if (!supportedNames.has(name)) return errorResult('dsh_node_workspace_unbound', `unbound tool: ${name}`);
    const definition = formal.get(name);

    // Validate formal parameters with the core schema validator first; do not
    // trust a fallback empty schema. No effect has started, so executed:false.
    let rejection;
    try { rejection = toolInputRejection(definition, { callId: exec?.callId, name, arguments: args }); }
    catch (failure) { return errorResult('dsh_node_workspace_args_invalid', failure.message); }
    if (rejection) return { status: 'error', content: rejection };

    // Fail closed: a real DSH ToolExecution with a real Session, callId and
    // AbortSignal is required. No fabricated Native identity.
    let sealed;
    try { sealed = sealExec(exec, name, args); }
    catch (failure) { return errorResult(failure.code || 'dsh_node_workspace_exec_unbound', failure.message); }
    const argsSnapshot = sealed.argsSnapshot;

    // Synchronous identity guard. Verified before permission, after permission,
    // and (as assertCurrent) after the shared workspace mutation lock. It never
    // returns a promise: an async guard cannot be accepted across the lock, and
    // a rejection here is observed by the underlying port's catch.
    const guard = () => {
      if (closed) throw authorityLost('dsh_node_workspace_closed');
      // isClosed must be a strict synchronous boolean. A thenable or non-boolean
      // is a Host contract violation, not a closed signal: observe any rejection
      // so it cannot leak as an unhandledRejection, then fail closed. Never treat
      // a Promise as closed via truthiness.
      const closedValue = isClosed();
      if (closedValue && typeof closedValue === 'object' && typeof closedValue.then === 'function') {
        closedValue.then(() => {}, () => {}); // observe the rejection
        throw authorityLost('dsh_node_workspace_is_closed_invalid');
      }
      if (typeof closedValue !== 'boolean') throw authorityLost('dsh_node_workspace_is_closed_invalid');
      if (closedValue) throw authorityLost('dsh_node_workspace_closed');
      if (exec.agent !== sealed.agent || exec.agent.session !== sealed.session)
        throw authorityLost('dsh_node_workspace_session_drifted');
      if (exec.agent.session.id !== sealed.sessionId || exec.callId !== sealed.callId)
        throw authorityLost('dsh_node_workspace_identity_drifted');
      if (exec.signal !== sealed.originalSignal)
        throw authorityLost('dsh_node_workspace_signal_drifted');
      if (sealed.originalSignal.aborted)
        throw authorityLost('dsh_node_workspace_canceled');
      if (exec.name !== sealed.name)
        throw authorityLost('dsh_node_workspace_name_drifted');
      let live;
      try { live = canonical(args); } catch { throw authorityLost('dsh_node_workspace_args_drifted'); }
      if (live !== argsSnapshot) throw authorityLost('dsh_node_workspace_args_drifted');
      // The real DSH ToolExecutionInput arguments must not be swapped out from
      // under the call (e.g. during an approval await). It must still match the
      // sealed snapshot and therefore the function args.
      let liveExecArgs;
      try { liveExecArgs = canonical(exec.arguments); }
      catch { throw authorityLost('dsh_node_workspace_exec_arguments_drifted'); }
      if (liveExecArgs !== sealed.execArgumentsSnapshot)
        throw authorityLost('dsh_node_workspace_exec_arguments_drifted');
    };

    try { guard(); }
    catch (failure) { return errorResult(failure.code, failure.message); }

    // Each mutating call enters the real authorizeNativeBuiltin pipeline
    // (standing sandboxPolicy + one-shot approval). A DSH registration allow is
    // not a permanent permission; deny/cancel/missing service writes nothing.
    if (definition.readOnly !== true) {
      try { await authorizeNativeBuiltin(ctx, exec, definition); }
      catch (failure) {
        return { status: 'error', content: { code: failure.code || 'STUDIO_NATIVE_PERMISSION_DENIED', executed: false } };
      }
      // Re-verify the sealed identity after the approval await: the signal,
      // args, exec object and Session must not have drifted while the caller
      // was deciding. No effect has started, so executed:false is honest.
      try { guard(); }
      catch (failure) { return errorResult(failure.code, failure.message); }
    }

    // Dispatch to the real workspace port. The request carries only the real
    // session id, callId, original signal and sealed arguments — never a
    // fabricated scope/Run/lease/fence. assertCurrent runs after the shared
    // workspace mutation lock and after the implementation, so a guard failure
    // after a write preserves uncertain and the changed paths.
    const request = {
      call: { name, callId: sealed.callId, arguments: sealed.argsCopy },
      sessionId: sealed.sessionId,
      signal: sealed.originalSignal,
      operationKey: `dsh-node-workspace:${sealed.callId}`,
    };
    const tools = toolsFor(sealed.sessionId);
    // Await even read-only tools: lint_workspace_file parses via an async WASM
    // worker. The underlying port only runs assertCurrent for mutating tools,
    // so the adapter must verify the sealed identity once more after the await
    // and never surface an ok result it no longer has authority to return.
    const result = await tools.execute(request, { assertCurrent: () => { guard(); return true; } });
    try { guard(); }
    catch (failure) {
      // A write that already happened keeps its receipt as uncertain with the
      // changed paths; never downgrade a real effect to executed:false. The
      // underlying port already returned uncertain when its own assertCurrent
      // caught a post-write guard failure, so pass that through unchanged.
      if (result && result.status === 'uncertain') return result;
      if (definition.readOnly !== true && result && result.status === 'ok'
        && Array.isArray(result.workspaceChangedPaths) && result.workspaceChangedPaths.length) {
        return {
          status: 'uncertain',
          workspaceChangedPaths: result.workspaceChangedPaths,
          content: { ...result.content, ok: false, error_type: failure.code, executed: true,
            paths: result.workspaceChangedPaths },
        };
      }
      return errorResult(failure.code, failure.message);
    }
    return result;
  }

  return {
    contract: DSH_NODE_WORKSPACE_CONTRACT,
    definitions: formalDefinitions,
    supports: name => supportedNames.has(name),
    execute,
    close,
  };
}
