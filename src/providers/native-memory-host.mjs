import { AsyncLocalStorage } from 'node:async_hooks';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../../packages/agentkit-harness/src/native/memory-store.mjs';
import { composeStudioNativeMemoryTools, explicitMemoryTarget } from './native-memory-tools.mjs';
import { bindStudioNativeMemoryTurn, DEFAULT_MANAGE_MEMORY_TOOL_NAMES } from './native-memory-turn.mjs';
import { createStudioNativeMemoryVerification, extendNativeMemoryGoal,
  MEMORY_VERIFIER_REF, MEMORY_VERIFIER_VERSION } from './native-memory-acceptance.mjs';
import { studioNativeMemoryPolicy } from './native-memory.mjs';
import { readNativeRecoveryBinding } from './native-recovery-binding.mjs';

/** Host binding contract for the scoped local-default Memory owner.

 * The parent assembles this once per admitted Build (Revision or Frozen) and
 * seals it into ``hostBindingDigest``. It composes the locked Memory tool port,
 * the completed-Turn consumer, the explicit-Memory acceptance verifier and the
 * owner read/receipt adapter the verifier needs. None of these grant authority
 * by themselves: the DSH pre/guard/around/post pipeline owns every execution,
 * the Memory tool's base authorizer only acknowledges that pipeline, and only a
 * real owner receipt against the actual database proves a write. Before any
 * write the bound ledger/fence/capsule is re-verified (item 3) so a late allow
 * arriving after the Run moved on, the lease expired, the goal changed, the
 * turn was canceled, the preset closed, or a new owner took over can never
 * commit a Memory mutation. */

export const STUDIO_NATIVE_MEMORY_HOST = 'agentkit.studio-native-memory-host/v1';
const hash = value => memoryDigest(canonical(value));
const denial = code => ({ status: 'error', content: { code, executed: false } });
const guardError = code => Object.assign(new Error(code), { code, executed: false });
const IDENTITY = ['runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'];

/** Resolve the batch intent + per-call index for a tool operationKey, mirroring
 * the kernel's own dispatch key rule. A SINGLE-call batch MUST use the batch
 * base key (the kernel does not append :call:1 for one call); a MULTI-call batch
 * MUST use ``<batch>:call:<n>``. A bare base key for a multi-call batch is NOT
 * accepted as index 0 (it is an unbound per-call key). Returns null otherwise. */
function resolveToolBatch(intents, operationKey) {
  const direct = intents.find(item => item.operationKey === operationKey);
  if (direct?.kind === 'tool' && Array.isArray(direct.payload?.calls) && direct.payload.calls.length === 1)
    return { intent: direct, index: 0, base: operationKey };
  const match = /^(.+):call:([1-9][0-9]*)$/u.exec(operationKey ?? '');
  if (!match) return null;
  const base = match[1], index = Number(match[2]) - 1;
  const baseIntent = intents.find(item => item.operationKey === base);
  return baseIntent?.kind === 'tool' && Array.isArray(baseIntent.payload?.calls) && baseIntent.payload.calls.length > 1
    && Number.isSafeInteger(index) && index >= 0 && index < baseIntent.payload.calls.length
    ? { intent: baseIntent, index, base } : null;
}

/** Bind the local-default Memory owner for one Build.

 * Returns ``null`` when the Memory provider is not ``local-default`` so the
 * cloud Memory path (and every non-local path) stays unchanged. For a
 * local-default Build the returned binding always carries a verification
 * wrapper (fail-closed for explicit Memory tasks even when the tools are
 * disabled) and, when the tool/turn conditions hold, the live tool port and
 * completed-Turn consumer. ``close`` releases the tool provider and consumer;
 * the parent calls it from ``releaseResources`` after the committed terminal. */
export function bindStudioNativeMemoryHost({ record, scope, sessionId, store, storeDir, buildId,
  context, ctx, bundleDigest = '', profileDigest = '', pluginLockDigest = '', sealedCapsule } = {}) {
  const policy = studioNativeMemoryPolicy(record.spec);
  if (policy.providerRef !== 'local-default') return null;
  invariant(record.metadata?.id === scope.agentId && record.metadata.local === true
    && record.spec.runtime?.type === 'harness' && Number.isSafeInteger(record.metadata.revision)
    && record.metadata.revision > 0, 'studio_native_memory_host_binding_invalid');
  const boundScope = copy(scope), boundBuildId = buildId ?? null;
  const boundCapsule = sealedCapsule ? copy(sealedCapsule) : null;
  const lifetime = new AbortController();
  let closed = false;

  // Per-invocation dispatch context carried on AsyncLocalStorage. read-only
  // Memory tools are concurrentSafe and may run in parallel, so the consent,
  // the token planner and the ledger guard must observe THIS call's agent /
  // original signal / complete request, not a shared mutable ref overwritten by
  // a sibling call. The gateway sets this around the Memory tool body.
  const dispatchALS = new AsyncLocalStorage();
  const currentDispatch = () => dispatchALS.getStore();
  const withDispatch = (dispatch, callback) => dispatchALS.run(dispatch, callback);

  /** Verify the Memory tool call is the CURRENT authorized execution against
   * the real ledger. DSH registration is not execution authority. The Run must
   * still be in executing_tools; the pending intent must be THIS call's batch;
   * the tool intent must be running under the current lease/fence; the
   * per-call index resolves with the kernel's key rule (single=base,
   * multi=``:call:n``); the WHOLE call (name, callId, arguments) must match
   * the ledger's ``intent.payload.calls[index]``; the request.definition must
   * match the CURRENT ``configuration.tools`` locked formal (name, schema,
   * effect, permissions, locked digest); and the frozen recovery capsule must
   * still bind THIS Build's sealed identity (revision, buildId, system prompt,
   * source, messages), not merely validate its own structure. Returns null
   * when bound, or a stable error code otherwise (no write, no fake success).
   * Re-checked after each async approval and right before the real
   * provider.applyMutation so a late allow cannot commit a mutation. */
  function verifyToolExecution(request) {
    if (closed || lifetime.signal.aborted) return 'memory_host_closed';
    if (!request || canonical(request.scope) !== canonical(boundScope))
      return 'memory_execution_scope_unbound';
    let loaded;
    try { loaded = store.load(boundScope, request.runId); }
    catch { return 'memory_execution_run_unbound'; }
    if (!loaded?.snapshot) return 'memory_execution_run_unbound';
    const snapshot = loaded.snapshot;
    if (!IDENTITY.every(key => snapshot[key] === request[key]) || snapshot.sessionId !== sessionId)
      return 'memory_execution_identity_unbound';
    if (snapshot.phase !== 'executing_tools') return 'memory_execution_phase_unbound';
    const batch = resolveToolBatch(loaded.intents, request.operationKey);
    if (!batch) return 'memory_execution_intent_unbound';
    const { intent, index, base } = batch;
    if (intent.status !== 'running') return 'memory_execution_intent_not_running';
    if (snapshot.pendingIntent !== base) return 'memory_execution_intent_superseded';
    // The WHOLE call (name, callId, arguments) must match the ledger's call.
    // A same callId with mutated arguments, or a different name, is rejected.
    const ledgerCall = intent.payload.calls[index];
    if (!ledgerCall || canonical(ledgerCall) !== canonical(request.call))
      return 'memory_execution_call_unbound';
    // The request.definition must match the CURRENT locked formal in the
    // frozen configuration.tools: name, schema (parameters), effect
    // (readOnly/concurrentSafe/permissions), and the locked executionPolicyDigest.
    // A forged or trimmed definition (e.g. readOnly flipped, permissions emptied)
    // cannot reproduce another call's authority even with the same name.
    if (!request.definition) return 'memory_execution_definition_unbound';
    const lockedFormal = loaded.configuration.tools.find(tool => tool.name === request.call.name);
    if (!lockedFormal || canonical(lockedFormal) !== canonical(request.definition))
      return 'memory_execution_definition_unbound';
    if (!loaded.lease || loaded.lease.expiresAt <= Date.now()) return 'memory_execution_lease_expired';
    if (intent.claimedFence === undefined || intent.claimedFence !== loaded.lease.fence
      || request.executionFence !== intent.claimedFence) return 'memory_execution_fence_unbound';
    // Bind the original Build identity from the frozen Host recovery capsule
    // AND compare its sealed identity (revision, buildId, systemPrompt, source,
    // messages) to the identity THIS Host sealed at binding. A legitimately
    // advanced/replaced Run or a new owner changes the capsule; that is not the
    // same authority that approved this Memory owner. Without a sealed capsule
    // the guard fails closed (no write).
    let capsule;
    try { capsule = readNativeRecoveryBinding(loaded, { agentId: boundScope.agentId, sessionId, runId: request.runId }); }
    catch { return 'memory_execution_capsule_unbound'; }
    if (!boundCapsule) return 'memory_execution_capsule_unbound';
    if (capsule.agentRevision !== record.metadata.revision || capsule.buildId !== boundBuildId)
      return 'memory_execution_build_unbound';
    if (boundBuildId !== null && snapshot.buildId !== boundBuildId) return 'memory_execution_build_unbound';
    if (capsule.systemPrompt !== boundCapsule.systemPrompt
      || canonical(capsule.source) !== canonical(boundCapsule.source)
      || canonical(capsule.messages) !== canonical(boundCapsule.messages))
      return 'memory_execution_capsule_changed';
    return null;
  }

  // Trusted base authorizer: the complete DSH pre/guard/around/post pipeline
  // already authorized this call before the Memory tool body runs, AND the bound
  // ledger/fence/capsule must still authorize it NOW. This acknowledges that;
  // it grants nothing the pipeline did not already grant and rejects a stale
  // execution that moved on while a deferred approval was in flight.
  const authorize = async () => {
    const dispatch = currentDispatch();
    if (!dispatch) return denial('memory_dispatch_unbound');
    const code = verifyToolExecution(dispatch.request);
    return code ? denial(code) : 'allow';
  };

  // manage_memory consent: only a non-shadow write that is not a recognized
  // exact explicit user command reaches here. forget never qualifies as
  // explicit, so it always requires this exact-call consent. The real Host
  // approval service decides; a denied or missing service blocks the write.
  // After the async approval returns, the ledger/fence/capsule is re-verified
  // (item 3) so a late allow arriving after the Run moved on cannot write.
  const consent = async request => {
    const dispatch = currentDispatch();
    if (!dispatch) return denial('memory_dispatch_unbound');
    const signal = dispatch.signal ?? lifetime.signal;
    if (dispatch.boundPolicyApproved === true) {
      signal?.throwIfAborted?.();
      const code = verifyToolExecution(dispatch.request);
      return code ? denial(code) : 'allow';
    }
    const approval = ctx?.get?.('approval') ?? ctx?.approval;
    if (typeof approval?.request !== 'function') return denial('policy_denied');
    let outcome;
    try {
      outcome = await approval.request({ agent: dispatch.agent, toolName: request.call.name,
        callId: request.call.callId, signal, reason: `Memory ${request.call.arguments?.action} requires exact-call approval.` });
    } catch { signal?.throwIfAborted?.(); return denial('policy_denied'); }
    signal?.throwIfAborted?.();
    if (outcome !== 'allowed-once') return denial('policy_denied');
    const code = verifyToolExecution(dispatch.request);
    return code ? denial(code) : 'allow';
  };

  // Real async token planner: counts the whole tool-result envelope against the
  // Build's recall budget using the current model's context counter. Reads its
  // own signal from the per-call ALS dispatch (a parallel search cannot have its
  // cancellation count bleed into a sibling). No character estimator is invented.
  // The Memory tool passes a single {role:'tool', tool_call_id, content} message,
  // but the real protocol counter (model-openai-chat/anthropic/responses) requires
  // a tool message to follow an assistant turn carrying its toolCalls, and it
  // reads profile.maxOutputTokens. Wrap the lone tool message in a legal replay
  // batch — assistant.toolCalls:[the exact call] + the tool message with its
  // native callId — and forward the bound profile + original signal. This
  // over-counts one real assistant envelope (conservative for the recall
  // budget); a parallel search's cancellation stays per-call via ALS.
  const planner = policy.recall.maxTokens ? { countMessage: async message => {
    const dispatch = currentDispatch();
    const signal = dispatch?.signal ?? lifetime.signal;
    const call = dispatch?.request?.call;
    const replay = call ? [
      { role: 'assistant', content: '', toolCalls: [copy(call)] },
      { role: 'tool', callId: call.callId, content: typeof message.content === 'string' ? message.content : canonical(message.content) },
    ] : [message];
    const count = await context.port.tokens.countRequest({ profile: context.profile, messages: replay, tools: [], signal });
    return count;
  } } : null;

  // Wrap the real provider so the synchronous provider.applyMutation dispatch
  // is re-verified (item 3) right before the durable write. The wrapper reads the
  // complete original request from the per-call ALS; a guard failure throws a
  // bounded guard error (caught by the gateway body → clean error, no write, no
  // uncertain) and the real applyMutation is never reached. Only applyMutation
  // (writes) is guarded here; get/search/reconcile are read-only and already
  // bound by definition/scope/signal in the locked tool port.
  const wrapProvider = realProvider => {
    const wrapApply = original => function applyMutation(payload) {
      const dispatch = currentDispatch();
      if (!dispatch) throw guardError('memory_dispatch_unbound');
      const code = verifyToolExecution(dispatch.request);
      if (code) throw guardError(code);
      return original.call(this, payload);
    };
    return new Proxy(realProvider, {
      get(target, prop) {
        if (prop === 'applyMutation') return wrapApply(target.applyMutation);
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      getPrototypeOf: () => SqliteNativeMemoryProvider.prototype,
    });
  };

  const memoryTools = composeStudioNativeMemoryTools({ record, scope: boundScope, store, storeDir,
    bundleDigest, profileDigest, pluginLockDigest, authorize, consent, planner,
    providerFactory: (filename, options) => wrapProvider(new SqliteNativeMemoryProvider(filename, options)) });
  const port = memoryTools; // null when tools are disabled
  const provider = port?.provider ?? null;

  // Owner read/receipt adapter for the explicit-Memory acceptance verifier. read
  // queries the actual current record; receipt reconciles the exact scoped call
  // against the actual database via the locked tool port. The verifier passes
  // the full call context; the adapter forwards all of it, defaulting scope to
  // the Host's bound scope (the verifier's owner.receipt API may omit scope) and
  // rejecting a non-matching passed scope. A tool JSON body or a committed
  // string claim is never substituted for the real owner receipt.
  const assertOpen = () => { if (closed || lifetime.signal.aborted) throw guardError('memory_host_closed'); };
  const memoryOwner = provider ? {
    read: async (id, { signal } = {}) => {
      assertOpen();
      const sig = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      sig.throwIfAborted();
      return provider.get(id);
    },
    receipt: async ({ scope: receiptScope, runId, operationKey, call, definition, signal } = {}) => {
      assertOpen();
      if (receiptScope !== undefined && canonical(receiptScope) !== canonical(boundScope)) return null;
      const sig = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      sig.throwIfAborted();
      const result = await port.reconcile({ call, definition, scope: copy(boundScope), operationKey, signal: sig });
      if (result.status !== 'ok') return null;
      return result.content.receipt ?? null;
    },
  } : null;

  const memoryTurn = bindStudioNativeMemoryTurn({ record, buildId: boundBuildId, scope: boundScope, sessionId,
    store, storeDir, contextWindow: context.profile.contextWindow });

  // The verification wrapper is always present for a local-default Build so an
  // explicit Memory task fails closed when the owner/tools are not installed.
  const wrapVerification = baseline => createStudioNativeMemoryVerification({ record,
    buildId: boundBuildId, scope: boundScope, sessionId, store, baseline,
    memoryOwner, definitions: port ? copy(port.definitions) : [] });

  const verificationDigest = hash({ verifier: MEMORY_VERIFIER_REF, version: MEMORY_VERIFIER_VERSION,
    revision: record.metadata.revision, buildId: boundBuildId, principal: boundScope, sessionId,
    policy, definitions: port ? copy(port.definitions) : [] });

  const hostBindingDigest = hash({ contract: STUDIO_NATIVE_MEMORY_HOST,
    providerRef: policy.providerRef, revision: record.metadata.revision, buildId: boundBuildId,
    principal: boundScope, sessionId, policy,
    lockedDigest: port?.lockedDigest ?? null, verificationDigest,
    turnDigest: memoryTurn?.bindingDigest ?? null });

  const close = () => {
    if (closed) return; closed = true;
    lifetime.abort(new Error('studio_native_memory_host_closed'));
    memoryTurn?.close();
    port?.close();
  };

  return { contract: STUDIO_NATIVE_MEMORY_HOST, policy, port, provider, memoryOwner, memoryTurn,
    scope: boundScope, sessionId, buildId: boundBuildId,
    withDispatch, wrapVerification, verificationDigest, hostBindingDigest,
    manageMemoryToolNames: DEFAULT_MANAGE_MEMORY_TOOL_NAMES, close };
}

export { extendNativeMemoryGoal, explicitMemoryTarget, MEMORY_VERIFIER_REF, MEMORY_VERIFIER_VERSION };
