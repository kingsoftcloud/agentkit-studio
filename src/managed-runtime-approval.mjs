/**
 * Present managed DSH approval asks as Interaction/v1 records.
 *
 * A managed Host runs DSH with the approval policy the caller requested
 * (`tool_approval_mode`). While such a run is live, every DSH
 * `approval/request` is published on the run's Responses stream as an
 * `mcp_approval_request` item and held until the platform resolves it through
 * `SubmitInteraction` (or its Responses `mcp_approval_response` compatibility
 * input). The bridge owns the only mutable map between a presented interaction
 * and the DSH promise waiting for its outcome; closing a run settles whatever
 * is still pending as `cancelled` so a disconnected client cannot pin a tool.
 */
import { randomUUID } from 'node:crypto';
import { runtimeError } from './runtime-responses-contract.mjs';

/** Product approval modes; both are satisfied by the interactive DSH policy. */
export const MANAGED_APPROVAL_MODES = ['ask', 'risk'];
const INTERACTION_PREFIX = 'appr_';
const ACTION_DECISIONS = new Map([['approve', 'approved'], ['reject', 'rejected'], ['cancel', 'cancelled']]);
const TERMINAL_DECISIONS = new Set(['approved', 'rejected', 'cancelled']);
const DEFAULT_TIMEOUT_MS = 120000;
const SETTLED_LIMIT = 256;
const RECEIPT_LIMIT = 256;

/**
 * Registries created in this Host process. A provider that runs beside the
 * managed run (the Codex App Server bridge) asks through the module-level
 * helpers so it never needs the HTTP layer's registry instance.
 */
const activeRegistries = new Set();

/** True when an interactive managed run is live for this DSH session id. */
export function hasManagedApprovalRun(sessionId) {
  for (const registry of activeRegistries) {
    try {
      if (registry.hasRun(sessionId)) return true;
    } catch { /* A racing dispose cannot own a live run. */ }
  }
  return false;
}

/**
 * Ask the first live managed run that owns the session to present an
 * interaction. `undefined` means no managed run is waiting, so a provider must
 * keep its own fail-closed behavior (Codex declines the App Server request).
 */
export function requestManagedApproval(request = {}) {
  for (const registry of activeRegistries) {
    let outcome;
    try {
      outcome = registry.request(request);
    } catch { outcome = undefined; }
    if (outcome !== undefined) return outcome;
  }
  return undefined;
}

export function createManagedApprovalRegistry({ ctx, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const runs = new Map();
  const sessions = new Map();
  const pending = new Map();
  const settled = new Map();
  const receipts = new Map();
  let disposed = false;
  const release = typeof ctx?.on === 'function'
    ? ctx.on('approval/request', (request, next) => {
      let answer;
      try { answer = answerRequest(request); } catch { answer = undefined; }
      return answer || next();
    }, { prepend: true })
    : undefined;

  function remember(map, key, value) {
    map.set(key, value);
    if (map.size > SETTLED_LIMIT) map.delete(map.keys().next().value);
  }

  function settle(entry, decision) {
    if (entry.settled || !TERMINAL_DECISIONS.has(decision)) return undefined;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(entry.interactionId);
    entry.run.pending.delete(entry.interactionId);
    const receipt = {
      schema_version: 1,
      command_id: `interaction:${entry.interactionId}:revision-${entry.revision}`,
      status: 'accepted',
      message_id: null,
      run_id: entry.run.runId,
      accepted_seq: null,
      error: null,
      interaction_id: entry.interactionId,
      session_id: entry.run.sessionId,
      decision,
      revision: entry.revision + 1,
      settled_at: new Date(now()).toISOString(),
    };
    remember(settled, entry.interactionId, receipt);
    try { entry.run.publishDone?.(entry.interactionId, decision, entry.revision + 1); } catch { /* A lost presentation cannot strand the DSH promise. */ }
    entry.resolve(decision === 'approved' ? 'allowed-once' : decision === 'rejected' ? 'rejected' : 'cancelled');
    return receipt;
  }

  /**
   * An idempotency key is chosen by the caller and forwarded verbatim by the
   * platform, so it can collide across sessions or runs. Scope the replay cache
   * to the interaction the key names: a receipt may only be replayed to the
   * same session, run and interaction that produced it.
   */
  function receiptKeyOf(idempotencyKey, sessionId, runId, interactionId) {
    return `${idempotencyKey}\u0000${sessionId}\u0000${runId}\u0000${interactionId}`;
  }

  function answerRequest(request) {
    if (disposed || !request) return undefined;
    return presentInteraction(sessions.get(request.agent?.session?.id), {
      toolName: request.toolName,
      callId: request.callId,
      reason: request.reason,
      signal: request.signal,
    });
  }

  /**
   * Present one interaction on a live run and hold the caller's outcome until
   * SubmitInteraction, the 120s timeout or the run's abort signal settles it.
   * This is the single presentation seam shared by the DSH `approval/request`
   * answerer and providers that ask through `request()`.
   */
  function presentInteraction(run, { toolName, callId, reason, signal } = {}) {
    if (disposed || !run || run.closed || typeof run.publish !== 'function') return undefined;
    if (signal?.aborted) return Promise.resolve('cancelled');
    const interactionId = `${INTERACTION_PREFIX}${randomUUID().replaceAll('-', '')}`;
    const entry = { interactionId, revision: 1, run, settled: false, timer: undefined, resolve: undefined };
    const outcome = new Promise(resolve => { entry.resolve = resolve; });
    entry.timer = setTimeout(() => { settle(entry, 'cancelled'); }, Math.max(1000, timeoutMs));
    entry.timer.unref?.();
    pending.set(interactionId, entry);
    run.pending.add(interactionId);
    try {
      run.publish({
        id: interactionId,
        type: 'mcp_approval_request',
        status: 'in_progress',
        name: typeof toolName === 'string' && toolName ? toolName : 'approval',
        ...(callId ? { call_id: String(callId) } : {}),
        ...(typeof reason === 'string' && reason ? { reason } : {}),
        run_id: run.runId,
        session_id: run.sessionId,
      });
    } catch { /* Presentation failure fails the ask closed through the normal answerer chain. */ }
    signal?.addEventListener?.('abort', () => settle(entry, 'cancelled'), { once: true });
    return outcome;
  }

  /** True when a live run owns the DSH session id or the platform session id. */
  function hasRun(sessionId) {
    if (disposed || typeof sessionId !== 'string' || !sessionId) return false;
    const direct = sessions.get(sessionId);
    if (direct && !direct.closed) return true;
    for (const run of runs.values()) if (!run.closed && run.sessionId === sessionId) return true;
    return false;
  }

  /**
   * Ask on behalf of a provider that runs inside the native Host process. The
   * caller names the run by DSH session id (`nativeSessionId`, also accepted as
   * `sessionId` because that is the id the provider knows) or by the platform
   * session id; ownership is the registry's live-run map, never request data.
   */
  function requestExternal(request = {}) {
    if (disposed || !request) return undefined;
    const native = typeof request.nativeSessionId === 'string' && request.nativeSessionId
      ? request.nativeSessionId : undefined;
    const platform = typeof request.sessionId === 'string' && request.sessionId
      ? request.sessionId : undefined;
    let run = native ? sessions.get(native) : undefined;
    if (!run && platform) run = sessions.get(platform);
    if (!run && platform) {
      for (const candidate of runs.values()) {
        if (!candidate.closed && candidate.sessionId === platform) { run = candidate; break; }
      }
    }
    if (!run || run.closed) return undefined;
    return presentInteraction(run, request);
  }

  function closeRun(runId) {
    const run = runs.get(runId);
    if (!run || run.closed) return;
    run.closed = true;
    for (const interactionId of [...run.pending]) {
      const entry = pending.get(interactionId);
      if (entry) settle(entry, 'cancelled');
    }
    runs.delete(runId);
    if (sessions.get(run.nativeSessionId) === run) sessions.delete(run.nativeSessionId);
  }

  const api = {
    /**
     * Register one live interactive run; `null` means this run gets no
     * interactive approvals (unmanaged policy or no stream to present on).
     * @param {{runId: string, sessionId: string, nativeSessionId: string, mode: string,
     *   publish?: (item: object) => void, publishDone?: (id: string, decision: string, revision: number) => void,
     *   signal?: AbortSignal}} request - live run facts owned by the HTTP layer.
     * @returns {{policy: 'ask', close: () => void} | null} run handle.
     */
    begin({ runId, sessionId, nativeSessionId, mode, publish, publishDone, signal } = {}) {
      if (disposed || !MANAGED_APPROVAL_MODES.includes(mode) || !runId || !nativeSessionId || typeof publish !== 'function') return null;
      const existing = sessions.get(nativeSessionId);
      if (existing && !existing.closed) return null;
      const run = { runId, sessionId, nativeSessionId, publish, publishDone, pending: new Set(), closed: false };
      runs.set(runId, run);
      sessions.set(nativeSessionId, run);
      signal?.addEventListener?.('abort', () => closeRun(runId), { once: true });
      return { policy: 'ask', runId, close: () => closeRun(runId) };
    },

    /**
     * Resolve one presented interaction from a `SubmitInteraction` request.
     * Ownership, revision, and lifecycle mismatches are distinct errors so the
     * Server can answer the caller without leaking another session's records.
     * @param {{sessionId: string, nativeSessionId: string, runId: string, interactionId: string,
     *   expectedRevision: number, action: string, response?: object,
     *   idempotencyKey?: string}} request - verified platform submission.
     * @returns {Promise<object> | object} canonical receipt fields.
     */
    resolve(request = {}) {
      const { sessionId, nativeSessionId, runId, interactionId, expectedRevision, action, response, idempotencyKey } = request;
      const receiptKey = typeof idempotencyKey === 'string' && idempotencyKey
        ? receiptKeyOf(idempotencyKey, sessionId, runId, interactionId) : undefined;
      const replay = receiptKey ? receipts.get(receiptKey) : undefined;
      if (replay) return { ...replay, status: 'duplicate', duplicate: true };
      if (!ACTION_DECISIONS.has(action)) throw runtimeError('RUNTIME_INTERACTION_ACTION_UNSUPPORTED', 400);
      if (typeof interactionId !== 'string' || !interactionId.startsWith(INTERACTION_PREFIX)
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw runtimeError('RUNTIME_INTERACTION_NOT_FOUND', 404);
      const entry = pending.get(interactionId);
      if (!entry) {
        if (settled.has(interactionId)) throw runtimeError('RUNTIME_INTERACTION_ALREADY_RESOLVED', 409);
        throw runtimeError('RUNTIME_INTERACTION_NOT_FOUND', 404);
      }
      const run = entry.run;
      if (run.closed || run.sessionId !== sessionId || run.nativeSessionId !== nativeSessionId || run.runId !== runId) {
        throw runtimeError('RUNTIME_INTERACTION_NOT_FOUND', 404);
      }
      if (entry.revision !== expectedRevision) throw runtimeError('RUNTIME_INTERACTION_REVISION_CONFLICT', 409);
      const decision = ACTION_DECISIONS.get(action);
      const claimed = response?.decision ?? response?.Decision;
      if (claimed !== undefined && String(claimed).toLowerCase() !== action && String(claimed).toLowerCase() !== decision) {
        throw runtimeError('RUNTIME_INTERACTION_RESPONSE_INVALID', 400);
      }
      const receipt = settle(entry, decision);
      if (receiptKey && receipt) remember(receipts, receiptKey, receipt);
      return receipt;
    },

    /**
     * Resolve one presented interaction from the Responses compatibility input
     * (`mcp_approval_response`). The interaction id is globally unique, so the
     * caller's session pins ownership and the recorded run supplies the rest.
     * @param {{sessionId: string, nativeSessionId: string, interactionId: string, approve: boolean}} request - verified compatibility input.
     * @returns {object} canonical receipt fields.
     */
    resolveInput({ sessionId, nativeSessionId, interactionId, approve } = {}) {
      const entry = typeof interactionId === 'string' ? pending.get(interactionId) : undefined;
      if (!entry || entry.run.closed || entry.run.sessionId !== sessionId || entry.run.nativeSessionId !== nativeSessionId) {
        if (settled.has(interactionId)) throw runtimeError('RUNTIME_INTERACTION_ALREADY_RESOLVED', 409);
        throw runtimeError('RUNTIME_INTERACTION_NOT_FOUND', 404);
      }
      return settle(entry, approve === true ? 'approved' : 'rejected');
    },

    /** Settle pending asks of one closed run and release its bridge state. */
    close: closeRun,

    /**
     * Provider-facing ask: present an interaction on the run that owns this
     * session and wait for its outcome (`allowed-once` | `rejected` |
     * `cancelled`). `undefined` means no managed run is live.
     */
    request: requestExternal,

    /** True when a live managed run owns this DSH or platform session id. */
    hasRun,

    /** Release the answerer listener and cancel every still-pending ask. */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const runId of [...runs.keys()]) closeRun(runId);
      release?.();
      settled.clear();
      receipts.clear();
      activeRegistries.delete(api);
    },

    /** Test/observability view of the bridge state. */
    snapshot() {
      return { runs: runs.size, pending: pending.size, settled: settled.size };
    },
  };
  activeRegistries.add(api);
  return api;
}
