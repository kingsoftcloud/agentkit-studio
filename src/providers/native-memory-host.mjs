import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { composeStudioNativeMemoryTools, explicitMemoryTarget } from './native-memory-tools.mjs';
import { bindStudioNativeMemoryTurn, DEFAULT_MANAGE_MEMORY_TOOL_NAMES } from './native-memory-turn.mjs';
import { createStudioNativeMemoryVerification, extendNativeMemoryGoal,
  MEMORY_VERIFIER_REF, MEMORY_VERIFIER_VERSION } from './native-memory-acceptance.mjs';
import { studioNativeMemoryPolicy } from './native-memory.mjs';

/** Host binding contract for the scoped local-default Memory owner.

 * The parent assembles this once per admitted Build (Revision or Frozen) and
 * seals it into ``hostBindingDigest``. It composes the locked Memory tool port,
 * the completed-Turn consumer, the explicit-Memory acceptance verifier and the
 * owner read/receipt adapter the verifier needs. None of these grant authority
 * by themselves: the DSH pre/guard/around/post pipeline owns every execution,
 * the Memory tool's base authorizer only acknowledges that pipeline, and only a
 * real owner receipt against the actual database proves a write. */

export const STUDIO_NATIVE_MEMORY_HOST = 'agentkit.studio-native-memory-host/v1';
const hash = value => memoryDigest(canonical(value));

const approvalDenied = () => ({ status: 'error', content: { code: 'policy_denied', executed: false } });

/** Bind the local-default Memory owner for one Build.

 * Returns ``null`` when the Memory provider is not ``local-default`` so the
 * cloud Memory path (and every non-local path) stays unchanged. For a
 * local-default Build the returned binding always carries a verification
 * wrapper (fail-closed for explicit Memory tasks even when the tools are
 * disabled) and, when the tool/turn conditions hold, the live tool port and
 * completed-Turn consumer. ``close`` releases the tool provider and consumer;
 * the parent calls it from ``releaseResources`` after the committed terminal. */
export function bindStudioNativeMemoryHost({ record, scope, sessionId, store, storeDir, buildId,
  context, ctx, bundleDigest = '', profileDigest = '', pluginLockDigest = '' } = {}) {
  const policy = studioNativeMemoryPolicy(record.spec);
  if (policy.providerRef !== 'local-default') return null;
  invariant(record.metadata?.id === scope.agentId && record.metadata.local === true
    && record.spec.runtime?.type === 'harness' && Number.isSafeInteger(record.metadata.revision)
    && record.metadata.revision > 0, 'studio_native_memory_host_binding_invalid');
  // Per-Build dispatch context: the DSH tool entry sets the live agent/signal
  // before routing to the Memory tool port. The Memory consent (real approval)
  // and the token planner read these so they run inside the owned DSH turn.
  const dispatchRef = { agent: null, signal: null };
  const lifetime = new AbortController();

  // Trusted base authorizer: the complete DSH pre/guard/around/post pipeline
  // already authorized this call before the Memory tool body runs. This only
  // acknowledges that; it grants nothing the pipeline did not already grant.
  const authorize = async () => 'allow';

  // manage_memory consent: only a non-shadow write that is not a recognized
  // exact explicit user command reaches here. forget never qualifies as
  // explicit, so it always requires this exact-call consent. The real Host
  // approval service decides; a denied or missing service blocks the write.
  const consent = async request => {
    const signal = request.signal ?? dispatchRef.signal ?? lifetime.signal;
    const approval = ctx?.get?.('approval') ?? ctx?.approval;
    if (typeof approval?.request !== 'function') return approvalDenied();
    const action = request.call?.arguments?.action;
    let outcome;
    try {
      outcome = await approval.request({ agent: dispatchRef.agent, toolName: request.call.name,
        callId: request.call.callId, signal, reason: `Memory ${action} requires exact-call approval.` });
    } catch (error) { signal?.throwIfAborted?.(); return approvalDenied(); }
    signal?.throwIfAborted?.();
    return outcome === 'allowed-once' ? 'allow' : approvalDenied();
  };

  // Real async token planner: counts the whole tool-result envelope against
  // the Build's recall budget using the current model's context counter. No
  // character estimator is invented here.
  const planner = policy.recall.maxTokens ? { countMessage: async message => {
    const signal = dispatchRef.signal ?? lifetime.signal;
    const count = await context.port.tokens.countRequest({ messages: [message], tools: [], signal });
    return count;
  } } : null;

  const memoryTools = composeStudioNativeMemoryTools({ record, scope, store, storeDir,
    bundleDigest, profileDigest, pluginLockDigest, authorize, consent, planner });
  const port = memoryTools; // null when tools are disabled
  const provider = port?.provider ?? null;

  // Owner read/receipt adapter for the explicit-Memory acceptance verifier.
  // read queries the actual current record; receipt reconciles the exact
  // scoped call against the actual database via the locked tool port. The
  // verifier passes the full call context ({scope, runId, operationKey, call,
  // definition, signal}); the adapter forwards all of it so the locked
  // definition and principal stay bound to the receipt. A tool JSON body or a
  // committed string claim is never substituted for the real owner receipt.
  const memoryOwner = provider ? {
    read: async (id, { signal } = {}) => { signal?.throwIfAborted?.(); return provider.get(id); },
    receipt: async ({ scope: receiptScope, runId, operationKey, call, definition, signal } = {}) => {
      signal?.throwIfAborted?.();
      // The locked tool port reconciles the exact call against the database via
      // the bound formal definition; a mismatched definition yields a divergent
      // request digest and an uncertain (never confirmed) receipt.
      const result = await port.reconcile({ call, definition, operationKey, signal });
      if (result.status !== 'ok') return null;
      return result.content.receipt ?? null;
    },
  } : null;

  const memoryTurn = bindStudioNativeMemoryTurn({ record, buildId: buildId ?? null, scope, sessionId,
    store, storeDir, contextWindow: context.profile.contextWindow });

  // The verification wrapper is always present for a local-default Build so an
  // explicit Memory task fails closed when the owner/tools are not installed.
  // ``bindingDigest`` does not depend on the baseline, so it is stable across
  // the live run and its recovery rebind.
  const wrapVerification = baseline => createStudioNativeMemoryVerification({ record,
    buildId: buildId ?? null, scope, sessionId, store, baseline,
    memoryOwner, definitions: port ? copy(port.definitions) : [] });

  const verificationDigest = hash({ verifier: MEMORY_VERIFIER_REF, version: MEMORY_VERIFIER_VERSION,
    revision: record.metadata.revision, buildId: buildId ?? null, principal: scope, sessionId,
    policy, definitions: port ? copy(port.definitions) : [] });

  const hostBindingDigest = hash({ contract: STUDIO_NATIVE_MEMORY_HOST,
    providerRef: policy.providerRef, revision: record.metadata.revision, buildId: buildId ?? null,
    principal: scope, sessionId, policy,
    lockedDigest: port?.lockedDigest ?? null, verificationDigest,
    turnDigest: memoryTurn?.bindingDigest ?? null });

  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    lifetime.abort(new Error('studio_native_memory_host_closed'));
    memoryTurn?.close();
    port?.close();
  };

  return { contract: STUDIO_NATIVE_MEMORY_HOST, policy, port, provider, memoryOwner, memoryTurn,
    dispatchRef, wrapVerification, verificationDigest, hostBindingDigest,
    manageMemoryToolNames: DEFAULT_MANAGE_MEMORY_TOOL_NAMES, close };
}

export { extendNativeMemoryGoal, explicitMemoryTarget, MEMORY_VERIFIER_REF, MEMORY_VERIFIER_VERSION };
