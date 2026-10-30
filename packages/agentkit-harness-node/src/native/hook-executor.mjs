// Scoped Native HookPort callback executor.
//
// The Kernel owns effect admission, sealed intent+receipt/state, input/output
// budgets, argument-schema checks, the separate bounded Stop continuation and
// unknown-effect recovery. This executor only owns the *callback lifetime* for a
// single HookPort: it binds pinned definitions to a host policy, authorizes and
// drives a single host callback per invocation under an absolute deadline, and
// reports a sealed HookInvocationResult. It is not a command/HTTP sandbox, a
// Python process, a legacy hook bridge, a tool-approval path, a verification
// success, an execution budget or a replay authority.
//
// Behavior reference: ksadk/harness/native/hook_executor.py (ScopedHookExecutor),
// branch feat-ksadk-harness-2. JS cannot forcibly cancel an uncooperative
// callback, so an invocation owns its pending work until terminal; late values
// are discarded and close() latency is bounded by the declared cleanup wait.

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  hookExecutionPolicy, hookResult, validateHookResult, validateHookInvocation, validateHookDefinition,
  hookBytes, canonical, copy, NativeError,
} from '@kingsoftcloud/agentkit-harness-core';

// The Kernel and these contracts compute every digest over canonical JSON with
// SHA-256. The executor re-derives the request digest with the same canonical
// SHA-256 (hex, no prefix) so it can fully revalidate a sealed request exactly as
// the Python reference does via Pydantic.
const canonicalSha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');

/** Deterministic host policy digest bound into every binding definition. */
export function nativeHookExecutionPolicyDigest({ cleanupTimeoutMs }) {
  return 'sha256:' + createHash('sha256').update(canonical(hookExecutionPolicy(cleanupTimeoutMs))).digest('hex');
}

// Normalize a callback-supplied output: default omitted fields exactly as the
// source HookOutput contract does, and reject any unexpected field. The callback
// can never mint execution/permission/replay authority through an extra key.
function normalizeOutput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new NativeError('invalid_hook_output');
  const { action, additionalContext, updatedArguments, ...rest } = raw;
  if (Object.keys(rest).length !== 0) throw new NativeError('invalid_hook_output');
  return {
    action: action === undefined ? 'continue' : action,
    additionalContext: additionalContext === undefined ? [] : additionalContext,
    updatedArguments: updatedArguments === undefined ? null : updatedArguments,
  };
}

// Wait for `promise` to settle, but never longer than `timeoutMs`. JS cannot
// cancel the underlying work; this only bounds how long a caller waits for it.
const safeWait = (promise, timeoutMs) => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
  const timer = setTimeout(finish, Math.max(0, timeoutMs));
  promise.then(finish, finish);
});

/**
 * Create a scoped Native HookPort callback executor.
 *
 * @param {object} options
 * @param {object} options.scope               RunScope all invocations must match.
 * @param {Array<{definition: object, callback: Function, available?: Function}>} options.bindings
 * @param {Function|null} options.authorize    async (request, signal) => 'allow' | 'deny'.
 * @param {number} options.cleanupTimeoutMs     Bounded close wait for owned work.
 * @returns {{invoke: Function, close: Function, pending: Set<object>}}
 */
export function createNativeHookExecutor({ scope, bindings, authorize, cleanupTimeoutMs }) {
  // Eagerly validate the cleanup policy (mirrors hookExecutionPolicy invariant).
  const policyDigest = nativeHookExecutionPolicyDigest({ cleanupTimeoutMs });
  const executorScope = copy(scope);
  const authorizer = authorize == null ? null : authorize;
  const cleanupTimeout = cleanupTimeoutMs;

  const bindingMap = new Map();
  if (!Array.isArray(bindings)) throw new NativeError('invalid_hook_bindings');
  for (const item of bindings) {
    if (item === null || typeof item !== 'object') throw new NativeError('invalid_hook_binding');
    // validateHookDefinition returns a deep, structurally-validated copy.
    const definition = validateHookDefinition(item.definition);
    if (definition.executionPolicyDigest !== policyDigest) throw new NativeError('hook_execution_policy_mismatch');
    if (typeof item.callback !== 'function'
      || bindingMap.has(definition.hookId)
      || (item.available != null && typeof item.available !== 'function')) {
      throw new NativeError('invalid_or_duplicate_hook_binding');
    }
    bindingMap.set(definition.hookId, { definition, callback: item.callback, available: item.available ?? null });
  }

  const state = { closed: false };
  const pending = new Set();

  // Availability is a host-owned boolean, never a permission. A closed executor or
  // a non-true answer (or a thrown check) is binding loss. No signal is passed:
  // availability is a quick host assertion, bounded by the invocation deadline.
  const available = async (binding) => {
    if (state.closed) return false;
    if (binding.available == null) return true;
    try {
      const value = await binding.available();
      return value === true && !state.closed;
    } catch {
      return false;
    }
  };

  async function invoke(request) {
    request.signal?.throwIfAborted();
    // Detach and fully revalidate the request; callbacks never receive live state.
    const incoming = request.signal;
    const rest = { ...request };
    delete rest.signal;
    const sealed = copy(rest);
    validateHookInvocation(sealed, canonicalSha256);
    if (canonical(sealed.scope) !== canonical(executorScope)) throw new NativeError('hook_scope_mismatch');
    const binding = bindingMap.get(sealed.definition.hookId);
    if (!binding || canonical(binding.definition) !== canonical(sealed.definition)) {
      throw new NativeError('hook_definition_mismatch');
    }
    const readOnly = sealed.definition.readOnly === true;
    const holder = { revoked: false, executed: false };
    // Before execution, every rejection is a definite failure; after the callback
    // is entered, a mutating producer's missing/invalid outcome stays uncertain.
    const reject = (reason) => hookResult(sealed, holder.executed && !readOnly ? 'uncertain' : 'failed', null, reason);
    if (hookBytes(sealed.input) > sealed.definition.maxInputBytes) return reject('input_budget_exceeded');

    const start = performance.now();
    const deadline = start + sealed.definition.timeoutMs;
    const lifetime = new AbortController();
    const scopedSignal = incoming ? AbortSignal.any([incoming, lifetime.signal]) : lifetime.signal;
    // Absolute deadline covers availability, authorization, recheck, callback and
    // output validation. A monotonic clock also handles wall-clock correction.
    // Cancellation revokes authority immediately, before any race continuation.
    const expired = () => holder.revoked || scopedSignal.aborted || state.closed || performance.now() >= deadline;

    const work = async () => {
      if (!await available(binding)) return reject('binding_unavailable');
      if (expired()) return reject('producer_timeout');
      if (authorizer === null) return reject('policy_denied');
      let decision;
      try {
        decision = await authorizer(copy(sealed), scopedSignal);
      } catch (error) {
        // An abort (caller/close/timeout) propagates so invoke can settle; any other
        // authorizer exception is a definite policy error.
        if (scopedSignal.aborted) throw error;
        return reject('policy_error');
      }
      if (expired()) return reject('producer_timeout');
      if (typeof decision !== 'string' || (decision !== 'allow' && decision !== 'deny')) return reject('policy_error');
      if (decision === 'deny') return reject('policy_denied');
      // Recheck availability after authorization: a binding that goes away before
      // the callback runs must not publish data.
      if (!await available(binding)) return reject('binding_unavailable');
      if (expired()) return reject('producer_timeout');
      holder.executed = true;
      let raw;
      try {
        raw = await binding.callback({ ...copy(sealed), signal: scopedSignal });
      } catch (error) {
        if (scopedSignal.aborted) throw error;
        return reject('producer_failed');
      }
      // Recheck availability after the callback: a binding lost while publishing
      // cannot surface its result even if the callback already returned.
      if (!await available(binding)) return reject('binding_unavailable');
      if (expired()) return reject('producer_timeout');
      try {
        const output = copy(normalizeOutput(raw));
        if (hookBytes(output) > sealed.definition.maxOutputBytes) return reject('output_budget_exceeded');
        const result = hookResult(sealed, 'ok', output, null);
        validateHookResult(sealed, result);
        if (expired()) return reject('producer_timeout');
        return result;
      } catch (error) {
        if (scopedSignal.aborted) throw error;
        return reject('producer_invalid');
      }
    };

    const workPromise = work();
    const entry = { promise: workPromise, lifetime };
    pending.add(entry);
    const remove = () => { pending.delete(entry); };
    workPromise.then(remove, remove);

    // Terminal race: deadline, caller abort, or close(). Whichever fires first
    // revokes further authority; the callback's late result is always discarded.
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      if (incoming) incoming.removeEventListener('abort', onAbort);
      lifetime.signal.removeEventListener('abort', onAbort);
    };
    const finishTerminal = (value) => { dispose(); resolveTerminal(value); };
    const onAbort = () => {
      if (incoming && incoming.aborted) finishTerminal({ kind: 'caller_abort', reason: incoming.reason ?? new NativeError('effect_aborted') });
      else finishTerminal({ kind: 'closed' });
    };
    const timer = setTimeout(() => finishTerminal({ kind: 'timeout' }), Math.max(0, deadline - performance.now()));
    if ((incoming && incoming.aborted) || lifetime.signal.aborted) onAbort();
    else {
      if (incoming) incoming.addEventListener('abort', onAbort, { once: true });
      lifetime.signal.addEventListener('abort', onAbort, { once: true });
    }

    const raced = await Promise.race([
      workPromise.then((result) => ({ kind: 'work', result }), (error) => ({ kind: 'work_error', error })),
      terminal,
    ]);
    dispose();

    if (raced.kind === 'work' && incoming?.aborted) throw incoming.reason;
    if (raced.kind === 'work') return raced.result;
    if (raced.kind === 'work_error') throw raced.error;

    // Terminal fired. Revoke authority, abort scoped work, and own the pending
    // task for at most the declared cleanup wait before settling.
    holder.revoked = true;
    const abortReason = raced.kind === 'caller_abort' ? raced.reason
      : raced.kind === 'timeout' ? new NativeError('producer_timeout')
      : new NativeError('hook_closed');
    try { lifetime.abort(abortReason); } catch { /* a controller never throws on abort */ }
    await safeWait(workPromise, cleanupTimeout);

    if (raced.kind === 'caller_abort') throw raced.reason;
    if (raced.kind === 'closed') {
      // A close-cancelled task that already entered its callback has an unknown
      // outcome (even read-only); one that never entered is a clean binding loss.
      return hookResult(sealed, holder.executed ? 'uncertain' : 'failed', null, 'binding_unavailable');
    }
    return reject('producer_timeout');
  }

  async function close() {
    state.closed = true;
    const entries = [...pending];
    for (const entry of entries) {
      try { entry.lifetime.abort(new NativeError('hook_closed')); } catch { /* already aborted */ }
    }
    if (entries.length) await Promise.all(entries.map((entry) => safeWait(entry.promise, cleanupTimeout)));
  }

  return { invoke, close, pending };
}
