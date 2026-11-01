/**
 * Host coordinator for Native background completion notification watches.
 *
 * Takes the real Native RunStore (`store`) and the persistent watch registry
 * (`watches`). Every tick:
 *  1. Enumerates scopes via listScopes (trusted Host callback).
 *  2. Scans store.list(scope) for completed source Runs with unnotified
 *     background commands, loads the full record, and registers it in watches.
 *  3. Dispatches pending watches to the Host dispatch callback, passing the
 *     original taskId (not the registry hash).
 *
 * Scan errors are collected, not swallowed — old watches are still dispatched
 * (a deleted agent or failed scope enum does not block existing watches), then
 * the tick/start rejects with an AggregateError of the collected errors. The
 * timer continues retrying on subsequent ticks. Persistence errors are never
 * disguised as success.
 *
 * start shares a single startup promise; concurrent callers await it. If the
 * first scan fails, start rejects and allows a retry (started is not locked).
 * status.running reflects whether the timer is actually running. close aborts
 * the lifetime and waits for inFlight to converge before returning; a late
 * callback result after close never writes the registry.
 */
import { invariant } from '@kingsoftcloud/agentkit-harness-core';

const DISPATCH_REASONS = new Set([
  'already_notified', 'source_canceled', 'budget_exhausted', 'task_not_found',
  'binding_invalid', 'sdk_busy', 'sdk_unavailable',
  'notice_terminal', 'command_not_terminal',
]);
function boundDispatchReason(reason) {
  if (typeof reason === 'string' && reason.length <= 64 && DISPATCH_REASONS.has(reason)) return reason;
  return 'unknown';
}

const ERROR_CODES = new Set([
  'list_scopes_failed', 'ledger_scan_failed', 'register_failed',
  'dispatch_exception', 'dispatch_invalid_result', 'dispatch_unknown_status',
  'tick_failed', 'watch_store_closed', 'watcher_closed', 'persist_failed',
  'scan_errors',
]);
function boundErrorCode(code) {
  if (typeof code === 'string' && ERROR_CODES.has(code)) return code;
  return 'tick_failed';
}

/**
 * @param {object} opts
 * @param {object} opts.store Real Native RunStore (store.list, store.load).
 * @param {object} opts.watches Persistent registry (createNativeBackgroundWatchStore).
 * @param {() => Promise<object[]>} opts.listScopes Trusted Host async scope enumerator.
 * @param {(request) => Promise<{status,runId?,reason?}>} opts.dispatch Host dispatch callback.
 * @param {AbortSignal} [opts.signal] Lifetime cancellation signal.
 * @param {number} [opts.intervalMs=1000] Poll interval.
 * @param {(error) => void} [opts.onError] Error observer.
 * @returns {{start():Promise, tick():Promise, close():Promise, status()}}
 */
export function createStudioNativeBackgroundWatcher({ store, watches, listScopes, dispatch, signal, intervalMs = 1000, onError } = {}) {
  invariant(store && typeof store.list === 'function' && typeof store.load === 'function', 'watcher_store_invalid');
  invariant(watches && typeof watches.register === 'function' && typeof watches.list === 'function'
    && typeof watches.recordOutcome === 'function', 'watcher_watches_invalid');
  invariant(typeof listScopes === 'function', 'watcher_list_scopes_required');
  invariant(typeof dispatch === 'function', 'watcher_dispatch_required');
  if (signal !== undefined) invariant(signal instanceof AbortSignal, 'watcher_signal_invalid');
  if (onError !== undefined) invariant(typeof onError === 'function', 'watcher_on_error_invalid');
  invariant(Number.isSafeInteger(intervalMs) && intervalMs >= 100 && intervalMs <= 300000, 'watcher_interval_invalid');

  const externalSignal = signal ?? new AbortController().signal;
  const ownController = new AbortController();
  const lifetime = AbortSignal.any([externalSignal, ownController.signal]);
  let closed = false, timer = null, closing;
  let ticking = false, inFlight = null, startPromise = null;
  let lastError = null, tickCount = 0;

  const checkClosed = () => { if (closed) throw Object.assign(new Error('watcher_closed'), { code: 'watcher_closed' }); };

  function reportError(code) {
    const bounded = boundErrorCode(code);
    lastError = bounded;
    if (onError) { try { onError(Object.assign(new Error(bounded), { code: bounded })); } catch {} }
  }

  /** Race an async operation against the lifetime signal. Removes the abort
   *  listener in finally to prevent leaks. */
  async function raceAbort(operation) {
    if (lifetime.aborted) throw Object.assign(new Error('watcher_closed'), { code: 'watcher_closed' });
    let listener = null;
    const stopped = new Promise((_, reject) => {
      listener = () => reject(Object.assign(new Error('watcher_closed'), { code: 'watcher_closed' }));
      lifetime.addEventListener('abort', listener, { once: true });
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (lifetime.aborted) throw Object.assign(new Error('watcher_closed'), { code: 'watcher_closed' });
        return operation();
      }), stopped]);
    } finally {
      if (listener) lifetime.removeEventListener('abort', listener);
    }
  }

  /** Scan the Native ledger. Collects errors but continues scanning. Returns
   *  the collected errors so the caller can reject after dispatching old
   *  watches — a failed scope does not block existing watches. */
  async function scanLedger(scopes) {
    const errors = [];
    if (!Array.isArray(scopes)) { reportError('ledger_scan_failed'); return [Object.assign(new Error('scopes_not_array'), { code: 'ledger_scan_failed' })]; }
    for (const sc of scopes) {
      if (lifetime.aborted || closed) return errors;
      let snapshots;
      try { snapshots = await raceAbort(() => typeof store.listHeads === 'function' ? store.listHeads(sc) : store.list(sc)); }
      catch (error) {
        if (error.code === 'watcher_closed') throw error;
        reportError('ledger_scan_failed');
        errors.push(error);
        continue;
      }
      if (!Array.isArray(snapshots)) { reportError('ledger_scan_failed'); errors.push(Object.assign(new Error('snapshots_not_array'), { code: 'ledger_scan_failed' })); continue; }
      for (const snap of snapshots) {
        if (lifetime.aborted || closed) return errors;
        if (snap.phase !== 'completed' || !Array.isArray(snap.backgroundCommands)) continue;
        for (const cmd of snap.backgroundCommands) {
          if (cmd.notified) continue;
          if (lifetime.aborted || closed) return errors;
          const ref = cmd.ref;
          if (!ref || ref.sourceRunId !== snap.runId) continue;
          let record;
          try { record = await raceAbort(() => store.load(sc, snap.runId)); }
          catch (error) { if (error.code === 'watcher_closed') throw error; reportError('ledger_scan_failed'); errors.push(error); continue; }
          if (!record) continue;
          try { watches.register(record, ref); }
          catch (error) {
            if (error.code === 'watch_store_closed' || error.code === 'watcher_closed') throw error;
            reportError('register_failed');
            errors.push(error);
          }
        }
      }
    }
    return errors;
  }

  async function dispatchPending() {
    let pending;
    try { pending = watches.list({ pendingOnly: true }); }
    catch (error) { reportError(error.code || 'persist_failed'); throw error; }
    for (const watch of pending) {
      if (lifetime.aborted || closed) return;
      await dispatchOne(watch);
    }
  }

  async function dispatchOne(watch) {
    if (lifetime.aborted || closed) return;
    const key = watch.key;
    let result;
    try {
      result = await raceAbort(() => dispatch({
        scope: watch.scope, sessionId: watch.sessionId,
        sourceRunId: watch.sourceRunId, taskId: watch.taskId,
        signal: lifetime,
      }));
    } catch (error) {
      if (error.code === 'watcher_closed') return;
      reportError('dispatch_exception');
      try { watches.recordOutcome(key, { status: 'pending_admission', reason: 'dispatch_exception' }); }
      catch (persistError) { reportError('persist_failed'); throw persistError; }
      return;
    }
    if (lifetime.aborted || closed) return; // late return after close — do not write
    if (!result || typeof result.status !== 'string') {
      reportError('dispatch_invalid_result');
      try { watches.recordOutcome(key, { status: 'pending_admission', reason: 'dispatch_invalid_result' }); }
      catch (persistError) { reportError('persist_failed'); throw persistError; }
      return;
    }
    try {
      switch (result.status) {
        case 'watching': watches.recordOutcome(key, { status: 'watching' }); break;
        case 'pending_admission': watches.recordOutcome(key, { status: 'pending_admission', reason: boundDispatchReason(result.reason) }); break;
        case 'admitted': watches.recordOutcome(key, { status: 'admitted', noticeRunId: result.runId ?? null }); break;
        case 'discarded': watches.recordOutcome(key, { status: 'discarded', reason: boundDispatchReason(result.reason) }); break;
        default: reportError('dispatch_unknown_status'); watches.recordOutcome(key, { status: 'pending_admission', reason: 'dispatch_unknown_status' });
      }
    } catch (persistError) { reportError('persist_failed'); throw persistError; }
  }

  /** Perform one tick: scan ledger (collect errors), dispatch pending, then
   *  reject if scan collected errors — but only after dispatching old watches. */
  async function tick() {
    checkClosed();
    if (lifetime.aborted) return;
    if (ticking) return inFlight;
    ticking = true;
    inFlight = (async () => {
      tickCount++;
      let scopes = [];
      let scopeError = null;
      try { scopes = await raceAbort(() => listScopes()); }
      catch (error) { if (error.code === 'watcher_closed') throw error; reportError('list_scopes_failed'); scopeError = error; }
      if (lifetime.aborted || closed) return;
      // Scan the ledger — collect errors, do not throw yet.
      const scanErrors = scopeError ? [scopeError] : [];
      if (!scopeError && !Array.isArray(scopes)) {
        // listScopes returned a non-array without throwing — contract violation.
        reportError('list_scopes_failed');
        scanErrors.push(Object.assign(new Error('scopes_not_array'), { code: 'list_scopes_failed' }));
      } else if (Array.isArray(scopes) && scopes.length) {
        const errs = await scanLedger(scopes);
        if (errs.length) scanErrors.push(...errs);
      }
      if (lifetime.aborted || closed) return;
      // Dispatch old watches even if scanning failed.
      await dispatchPending();
      // After dispatching, reject if there were scan errors.
      if (scanErrors.length) {
        const agg = new AggregateError(scanErrors, 'scan_errors');
        agg.code = 'scan_errors';
        throw agg;
      }
    })().catch(error => {
      if (error.code !== 'watcher_closed') reportError(error.code || 'tick_failed');
      throw error;
    }).finally(() => {
      ticking = false;
      inFlight = null;
    });
    return inFlight;
  }

  /** Start polling. Shares a single startup promise across concurrent callers.
   *  If the first scan fails, start rejects and allows a retry. */
  async function start() {
    checkClosed();
    if (startPromise) return startPromise;
    if (lifetime.aborted) return;
    startPromise = (async () => {
      await tick(); // Rejected if first scan fails — timer does not start.
      if (closed || lifetime.aborted) return;
      timer = setInterval(() => {
        if (closed || lifetime.aborted) return;
        void tick().catch(error => {
          if (error.code !== 'watcher_closed') reportError(error.code || 'tick_failed');
        });
      }, intervalMs);
      timer.unref();
    })();
    try { await startPromise; }
    catch (error) { startPromise = null; throw error; } // allow retry on failure
  }

  /** Close: abort lifetime, clear timer, wait for inFlight to converge. A late
   *  callback result after close never writes the registry (checked in
   *  dispatchOne). Does not close external store/watches. */
  function close() {
    if (closing) return closing;
    closed = true;
    ownController.abort(Object.assign(new Error('watcher_closed'), { code: 'watcher_closed' }));
    if (timer) { clearInterval(timer); timer = null; }
    // Wait for any in-flight tick to converge (it should observe the abort).
    return closing = Promise.resolve(inFlight).catch(() => {});
  }

  function status() {
    let pendingCount = 0, pendingError = null;
    try { pendingCount = watches.list({ pendingOnly: true }).length; }
    catch (error) { pendingError = boundErrorCode(error.code); }
    return {
      running: timer !== null && !closed && !lifetime.aborted,
      starting: startPromise !== null && timer === null && !closed,
      closed, tickCount, pendingCount, lastError: lastError ?? pendingError,
    };
  }

  return { start, tick, close, status };
}
