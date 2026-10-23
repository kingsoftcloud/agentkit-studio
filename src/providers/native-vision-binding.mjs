/**
 * Studio ledger-bound Vision tool wrapper.
 *
 * Wraps an existing DSH ToolPort so that browser_inspect_workspace calls are
 * routed through createNativeVisionBrowser, captioning screenshots via a
 * host-injected vision ModelPort. The caption is untrusted observation data
 * and never an acceptance verdict or execution authority.
 *
 * API: createStudioNativeVisionBinding({scope, sessionId, store, model, profile,
 *   isClosed}) → {contract, binding, wrapTools, close}
 *
 * binding: pure JSON {contract, visionContract, profileDigest} — for recovery
 * binding only, grants no authority. profileDigest covers the full Native
 * ModelProfile (no port/credentials).
 *
 * Ports ksadk/studio/native_product.py:_vision_observation_context + NativeVisionBrowser
 * assembly @355059d to Node.
 */
import { createHash } from 'node:crypto';
import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { effectiveRunConfiguration } from '../../packages/agentkit-harness-core/dist/task-contract.mjs';
import { createNativeVisionBrowser, NATIVE_VISION_BROWSER_CONTRACT, VisionObservationContext } from '../../packages/agentkit-harness/src/native/browser-vision.mjs';
import { createNativeToolAuthority } from './native-tool-authority.mjs';

export const STUDIO_NATIVE_VISION_BINDING = 'agentkit.studio-native-vision/v1';

const digest = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');
const rawDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

// Settle promptly even if a custom browser/model ignores abort. Keep observing
// its promise; the request guard is revoked before late work can be published.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => finish(reject, signal.reason ?? new Error('vision_binding_canceled'));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback(value);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort();
  });
}

/**
 * Create a Vision tool binding for one Build.
 * @param {object} opts
 * @param {object} opts.scope - RunScope (tenantId/workspaceId/userId/agentId)
 * @param {string} opts.sessionId - session ID
 * @param {object} opts.store - RunStore with load()
 * @param {object} opts.model - vision ModelPort (generate)
 * @param {object} opts.profile - full Native ModelProfile (no port/credentials)
 * @param {function} opts.isClosed - sync () => boolean (optional, default false)
 * @returns {object} {contract, binding, wrapTools, close}
 */
export function createStudioNativeVisionBinding({ scope, sessionId, store, model, profile, isClosed = () => false } = {}) {
  invariant(scope && typeof scope === 'object' && ['tenantId', 'workspaceId', 'userId', 'agentId'].every(k => typeof scope[k] === 'string' && scope[k].trim()), 'vision_binding_scope_invalid');
  invariant(typeof sessionId === 'string' && sessionId.trim(), 'vision_binding_session_invalid');
  invariant(store && typeof store.load === 'function', 'vision_binding_store_invalid');
  invariant(model && typeof model.generate === 'function', 'vision_binding_model_invalid');
  invariant(profile && typeof profile === 'object', 'vision_binding_profile_invalid');
  // Profile must explicitly declare native image input — no OR fallback.
  invariant(profile.imageInputMode === 'native', 'vision_binding_profile_image_invalid');
  invariant(typeof isClosed === 'function', 'vision_binding_isClosed_invalid');

  // Deep-lock scope/session/profile at construction.
  const frozenScope = copy(scope);
  const frozenSessionId = sessionId;
  const frozenProfile = copy(profile);

  // Pure JSON binding for recovery — grants no authority.
  const binding = Object.freeze({
    contract: STUDIO_NATIVE_VISION_BINDING,
    visionContract: NATIVE_VISION_BROWSER_CONTRACT,
    profileDigest: digest(frozenProfile),
  });

  // Own closed state — combined with external isClosed for authority.
  let ownClosed = false;
  const combinedIsClosed = () => {
    if (ownClosed) return true;
    const value = isClosed();
    if (value === false || value === true) return value;
    if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
    throw new Error('vision_binding_is_closed_invalid');
  };

  // Real tool authority backed by the SQLite store.
  // The authority checks combinedIsClosed so our own close revokes authority
  // without touching the parent's shared browser port.
  const authority = createNativeToolAuthority({ scope: frozenScope, sessionId: frozenSessionId, store, isClosed: combinedIsClosed });

  // Lifetime AbortController for own work — aborts in-flight vision requests
  // on close without affecting the parent browser or model port.
  const lifetime = new AbortController();

  // observationContext: reads the current Run snapshot from the store.
  function observationContext(request) {
    if (canonical(request.scope) !== canonical(frozenScope))
      throw new Error('vision_observation_scope_mismatch');
    const loaded = store.load(frozenScope, request.runId);
    const snapshot = loaded.snapshot;
    // Validate any steered contract digest, but use the current Run goal:
    // steering may update that goal without replacing the acceptance contract.
    effectiveRunConfiguration(snapshot, loaded.configuration, rawDigest);
    const goal = snapshot.goal;
    const goalRevision = snapshot.goalRevision;

    const failed = [];
    const obs = snapshot.unresolvedInteractionObservation;
    if (obs && typeof obs.error === 'string' && obs.error.trim())
      failed.push(obs.error);

    if (snapshot.verificationToolCalls !== null && snapshot.verification) {
      const checks = snapshot.verification.checks;
      if (Array.isArray(checks)) {
        for (const check of checks) {
          if (check && check.status === 'failed' && typeof check.safeSummary === 'string' && check.safeSummary.trim())
            failed.push(check.safeSummary);
        }
      }
    }

    return new VisionObservationContext({
      scope: frozenScope, runId: snapshot.runId, goalRevision, goal, failedObservations: failed,
    });
  }

  /**
   * Wrap a ToolPort so browser_inspect_workspace goes through vision captioning.
   * All other tools and methods pass through unchanged.
   * The original tools object retains its full surface (recover, resume, read, etc.).
   * @param {object} tools - the original ToolPort with execute and other methods
   * @returns {object} wrapped ToolPort with execute + all original methods
   */
  function wrapTools(tools) {
    invariant(tools && typeof tools.execute === 'function', 'vision_wrap_tools_invalid');
    invariant(!ownClosed, 'vision_binding_closed');

    const guards = new WeakMap();
    const vb = createNativeVisionBrowser({ browser: tools, model, profile: frozenProfile,
      actions: null, assertCurrent: request => guards.get(request)?.(request) === true, observationContext });

    // Wrapped execute: only browser_inspect_workspace gets vision; others pass through.
    // The wrapper checks ownClosed + combinedIsClosed before dispatching to vision.
    const wrappedExecute = async function(request) {
      // Check our own closed state + external isClosed.
      if (combinedIsClosed()) throw new Error('vision_binding_closed');
      // Only browser_inspect_workspace gets vision captioning.
      if (request?.call?.name === 'browser_inspect_workspace') {
        invariant(request.signal instanceof AbortSignal, 'vision_binding_signal_invalid');
        const originalSignal = request.signal;
        const { signal: _signal, ...json } = request;
        const sealed = canonical(json);
        const combinedSignal = AbortSignal.any([originalSignal, lifetime.signal]);
        const bound = { ...copy(json), signal: combinedSignal };
        const assertCurrent = candidate => {
          try {
            const { signal: currentSignal, ...current } = request;
            const { signal: candidateSignal, ...candidateJson } = candidate;
            return !combinedIsClosed() && !combinedSignal.aborted && currentSignal === originalSignal
              && candidateSignal === combinedSignal && canonical(current) === sealed
              && canonical(candidateJson) === sealed && authority(candidate) === true;
          } catch { return false; }
        };
        invariant(assertCurrent(bound), 'vision_guard_failed');
        // The cache belongs to the wrapped port, while each request's full JSON
        // and original signal stay locked across every browser/model await.
        guards.set(bound, assertCurrent);
        try {
          const result = await abortable(vb.execute(bound), combinedSignal);
          invariant(assertCurrent(bound), 'vision_binding_request_drifted');
          return result;
        } finally { guards.delete(bound); }
      }
      // All other tools: pass through to original.
      return tools.execute(request);
    };

    // Proxy: intercept execute, pass everything else through to the original tools.
    const proxy = new Proxy(tools, {
      get(target, prop, receiver) {
        if (prop === 'execute') return wrappedExecute;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    return proxy;
  }

  function close() {
    if (ownClosed) return;
    ownClosed = true;
    // Abort our own in-flight vision work — does NOT close the parent browser/model.
    lifetime.abort(new Error('vision_binding_closed'));
  }

  return { contract: STUDIO_NATIVE_VISION_BINDING, binding, wrapTools, close };
}
