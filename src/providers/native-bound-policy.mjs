import { canonical } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { createHash } from 'node:crypto';
import { nativeAgentPolicyDecision, normalizeNativeAgentPolicy } from '../native-agent-policy.mjs';

const active = new WeakMap();
const DENIED = 'Agent 绑定的权限策略禁止此工具调用';
const UNAVAILABLE = 'Agent 权限审批服务不可用';

/** One live ToolRegistry execution, never a durable or model-visible grant. */
function seal(exec) {
  return canonical({ name: exec.name, callId: exec.callId, arguments: exec.arguments,
    sessionId: exec.agent?.session?.id });
}

export function hasNativeBoundApproval(ctx, exec) {
  const state = active.get(ctx), grant = state?.grants.get(exec);
  const approval = ctx.get?.('approval') ?? ctx.approval;
  return Boolean(state && !state.closed && grant?.guarded && !exec.signal.aborted
    && typeof approval?.request === 'function'
    && (typeof approval.effectivePolicy !== 'function' || approval.effectivePolicy(exec.agent.session) !== 'never')
    && grant.seal === seal(exec));
}

/** Install on the admitted preset scope. The monotonic guard survives later
 * pre-execute listeners returning allow, while the Host's other guards can
 * still reject this call. Tool bodies receive the exact registry execution. */
export function installNativeBoundPolicy(ctx, value, classify) {
  const policy = normalizeNativeAgentPolicy(value);
  if (!policy) return () => {};
  if (typeof ctx.tools?.guard !== 'function' || typeof ctx.on !== 'function' || typeof classify !== 'function')
    throw Object.assign(new Error('Native Agent policy needs the trusted ToolRegistry'), { code: 'STUDIO_NATIVE_AGENT_POLICY_UNAVAILABLE' });
  const state = { closed: false, grants: new WeakMap(), seen: new WeakSet() };
  active.set(ctx, state);
  const decision = exec => {
    const definition = classify(exec.agent, exec.name);
    const action = nativeAgentPolicyDecision(policy, exec.name, definition?.readOnly === true);
    if (action === 'deny' || definition?.readOnly === true || definition) return action;
    // MCP and Skill shell have no verified read-only classification. A mutable
    // Session's read-only setting must constrain them as well as Node builtins.
    const standing = ctx.get?.('sandboxPolicy') ?? ctx.sandboxPolicy;
    const mode = standing?.resolve?.({ session: exec.agent?.session })?.mode;
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) return 'deny';
    return action === 'ask' || mode === 'read-only' ? 'ask' : 'inherit';
  };
  const guard = ctx.tools.guard(exec => {
    if (state.closed) return UNAVAILABLE;
    const action = decision(exec);
    if (action === 'deny') return DENIED;
    if (action !== 'ask') return undefined;
    const grant = state.grants.get(exec);
    if (!grant || grant.guarded || grant.seal !== seal(exec) || exec.signal.aborted) return UNAVAILABLE;
    const approval = ctx.get?.('approval') ?? ctx.approval;
    if (typeof approval?.request !== 'function'
      || typeof approval.effectivePolicy === 'function' && approval.effectivePolicy(exec.agent.session) === 'never') return UNAVAILABLE;
    grant.guarded = true;
    return undefined;
  });
  const listener = ctx.on('tools/pre-execute', async (exec, next) => {
    const action = decision(exec);
    if (state.closed) return { kind: 'deny', reason: UNAVAILABLE };
    if (action === 'deny') return { kind: 'deny', reason: DENIED };
    if (action !== 'ask') return next();
    if (state.seen.has(exec)) return { kind: 'deny', reason: DENIED };
    state.seen.add(exec);
    // Collect the rest of the declarative waterfall first. A later `ask` is
    // answered by this same ApprovalService request, so the two constraints
    // produce one audited question. A later denial wins without prompting.
    const downstream = await next();
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream;
    if (downstream.kind !== 'allow' && downstream.kind !== 'ask') return { kind: 'deny', reason: UNAVAILABLE };
    const approval = ctx.get?.('approval') ?? ctx.approval;
    if (typeof approval?.request !== 'function' || !exec.agent?.session)
      return { kind: 'deny', reason: UNAVAILABLE };
    const details = canonical(exec.arguments);
    // The UI can correlate this callId with its tool-call details. Keep raw
    // arguments (which may include credentials) out of the approval log.
    const argumentDigest = createHash('sha256').update(details).digest('hex');
    const reason = `Agent 策略要求审批 ${exec.name}（参数摘要 ${argumentDigest.slice(0, 16)}，请核对工具调用详情）`
      + (downstream.kind === 'ask' && downstream.reason ? `；其他策略：${String(downstream.reason).slice(0, 500)}` : '');
    let outcome;
    try { outcome = await approval.request({ agent: exec.agent, toolName: exec.name,
      callId: exec.callId, signal: exec.signal, reason }); }
    catch (error) { if (exec.signal.aborted) throw error; return { kind: 'deny', reason: UNAVAILABLE }; }
    if (state.closed || exec.signal.aborted || outcome !== 'allowed-once')
      return { kind: 'deny', reason: DENIED };
    state.grants.set(exec, { seal: seal(exec), guarded: false });
    return { kind: 'allow' };
  }, { prepend: true });
  return () => { state.closed = true; listener?.(); guard?.(); if (active.get(ctx) === state) active.delete(ctx); };
}
