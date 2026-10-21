export const STUDIO_NATIVE_TOOL_PERMISSION_CONTRACT = 'agentkit.native-tool-permission/v1';
/** Permission scopes a Node builtin may declare. A ``memory:write`` tool
 * mutates the scoped Memory store, not the workspace filesystem, so the
 * workspace standing policy never gates it; its own exact-call consent (the
 * real approval service) owns that approval. Filesystem/workspace writes keep
 * the standing policy + one-shot approval below. */
const MEMORY_WRITE = 'memory:write';
const isMemoryWriteOnly = definition => Array.isArray(definition?.permissions)
  && definition.permissions.length === 1 && definition.permissions[0] === MEMORY_WRITE;
const denied = code => Object.assign(new Error(code), { code });

/** Node builtin bodies bypass DSH's filesystem wrappers. Enforce the standing
 * Host policy immediately before their own dispatch, even after pre-policies
 * returned allow. Only the real approval service can grant one escalation.
 * A memory:write builtin is not a workspace write: the Memory tool's own
 * consent runs inside its body, so the standing policy does not gate it. */
export async function authorizeNativeBuiltin(ctx, exec, definition) {
  exec.signal.throwIfAborted();
  if (definition.readOnly === true) return;
  if (isMemoryWriteOnly(definition)) return;
  const currentPolicy = () => ctx.get?.('sandboxPolicy') ?? ctx.sandboxPolicy;
  const policy = currentPolicy();
  if (typeof policy?.resolve !== 'function' || !exec.agent?.session) throw denied('STUDIO_NATIVE_TOOL_POLICY_UNAVAILABLE');
  const resolve = () => {
    const live = currentPolicy();
    if (typeof live?.resolve !== 'function') throw denied('STUDIO_NATIVE_TOOL_POLICY_UNAVAILABLE');
    const mode = live.resolve({ session: exec.agent.session })?.mode;
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) throw denied('STUDIO_NATIVE_TOOL_POLICY_UNAVAILABLE');
    return mode;
  };
  if (resolve() !== 'read-only') return;
  const approval = ctx.get?.('approval') ?? ctx.approval;
  if (typeof approval?.request !== 'function') throw denied('STUDIO_NATIVE_PERMISSION_DENIED');
  const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
    reason: `Native tool ${exec.name} may modify state and requires approval under read-only policy.` });
  exec.signal.throwIfAborted();
  resolve(); // Re-read live services; Cordis can return a fresh scoped proxy.
  if (typeof (ctx.get?.('approval') ?? ctx.approval)?.request !== 'function') throw denied('STUDIO_NATIVE_PERMISSION_DENIED');
  if (outcome !== 'allowed-once') throw denied('STUDIO_NATIVE_PERMISSION_DENIED');
}
