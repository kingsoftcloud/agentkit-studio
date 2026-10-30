import type { ToolResult } from './contracts.mjs';
import { NativeError, isNativeError } from './values.mjs';
import { effectFailureCause } from './effect-diagnostics.mjs';

export interface ToolExecutionLifecycle {
  /** Call immediately before the first effect, after all permission waits.
   * This may be called once; repeated notifications never renew a deadline. */
  dispatched(): void;
}

/** Live-only proof. No receipt can be inferred from its absence after a crash. */
export interface ToolDispatchProof { dispatched: boolean }
export interface ToolFailureObservation {
  cause: string; signalAborted: boolean; dispatchEvidence: 'unavailable' | 'none_dispatched' | 'some_dispatched';
}

/** A host permission wait is distinct from executing a tool. The enclosing
 * effect and run wall limits still bound preflight; cancellation still aborts
 * it. Only a negotiated host boundary may prove that dispatch has not begun.
 * A crash without a receipt remains uncertain under normal recovery rules. */
export async function executeTimedTool({ signal, timeoutMs, dispatchTimed, lifecycleAvailable, now, execute, dispatchProof, onFailure }: {
  signal: AbortSignal; timeoutMs: number; dispatchTimed: boolean; lifecycleAvailable: boolean;
  now: () => number;
  execute: (signal: AbortSignal, lifecycle?: ToolExecutionLifecycle) => Promise<ToolResult>;
  dispatchProof?: ToolDispatchProof | undefined;
  onFailure?: (observation: ToolFailureObservation) => void | Promise<void>;
}): Promise<ToolResult> {
  if (dispatchTimed && !lifecycleAvailable)
    return { status: 'error', content: { code: 'tool_dispatch_lifecycle_unavailable', executed: false } };
  const deadline = new AbortController(), toolSignal = AbortSignal.any([signal, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined, started: number | undefined, dispatched = false;
  const startTimer = () => {
    if (started !== undefined) return;
    started = now();
    timer = setTimeout(() => deadline.abort(new NativeError('tool_timeout')), timeoutMs);
  };
  const lifecycle = { dispatched() {
    toolSignal.throwIfAborted();
    if (dispatchProof) dispatchProof.dispatched = true;
    dispatched = true; startTimer();
  } };
  if (!dispatchTimed) startTimer();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(toolSignal.reason);
    if (toolSignal.aborted) onAbort(); else toolSignal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    toolSignal.throwIfAborted();
    const result = await Promise.race([execute(toolSignal, dispatchTimed ? lifecycle : undefined), aborted]);
    toolSignal.throwIfAborted();
    if (started !== undefined && now() - started >= timeoutMs) throw new NativeError('tool_timeout');
    return result;
  } catch (error) {
    try { void Promise.resolve(onFailure?.({ cause: effectFailureCause(isNativeError(error) ? error.code : 'effect_port_error', isNativeError(error)),
      signalAborted: toolSignal.aborted, dispatchEvidence: !dispatchProof ? 'unavailable' : dispatchProof.dispatched ? 'some_dispatched' : 'none_dispatched' })).catch(() => {}); }
    catch { /* Observation cannot change settlement or grant replay. */ }
    return dispatchTimed && !dispatched
      ? { status: 'error', content: { code: signal.aborted ? 'tool_preflight_aborted' : 'tool_preflight_failed', executed: false } }
      : { status: 'uncertain', content: { code: 'tool_outcome_unknown' } };
  } finally { clearTimeout(timer); toolSignal.removeEventListener('abort', onAbort); }
}
