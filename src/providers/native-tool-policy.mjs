export const STUDIO_NATIVE_TOOL_PERMISSION_CONTRACT = 'agentkit.native-tool-permission/v1';
const denied = code => Object.assign(new Error(code), { code });

/** Node builtin bodies bypass DSH's filesystem wrappers. Enforce the standing
 * Host policy immediately before their own dispatch, even after pre-policies
 * returned allow. Only the real approval service can grant one escalation. */
export async function authorizeNativeBuiltin(ctx, exec, definition) {
  exec.signal.throwIfAborted();
  if (definition.readOnly === true) return;
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
