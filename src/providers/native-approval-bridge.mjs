/** Live answerer and read model for Studio Native one-shot approvals. */
import { randomUUID } from 'node:crypto';

export const STUDIO_NATIVE_APPROVAL_CONTRACT = 'agentkit.studio-native-approval/v1';
const DECISIONS = new Map([['allow', 'allowed-once'], ['deny', 'rejected']]);
const MAX_TEXT = 256;
const text = value => typeof value === 'string' && value.trim() && value.length <= MAX_TEXT && !value.includes('\0');
const keyOf = value => `${value.runId}\u0000${value.interactionId}`;
const copy = value => structuredClone(value);

function validNativeRequest(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.contract === STUDIO_NATIVE_APPROVAL_CONTRACT
    && ['agentId', 'sessionId', 'runId', 'interactionId', 'hostInteractionId', 'callId', 'toolName']
      .every(key => text(value[key]))
    && (value.reason === undefined || typeof value.reason === 'string' && value.reason.length <= 2048)
    && (value.assertCurrent === undefined || typeof value.assertCurrent === 'function');
}

/**
 * Native Kernel owns the durable command and audit projection. This bridge only
 * holds the live DSH approval waterfall promise until the authenticated Studio
 * RPC supplies the exact one-shot decision.
 */
export function createNativeApprovalBridge({ ctx, timeoutMs = 120000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000 || typeof now !== 'function') {
    throw new TypeError('Invalid Studio Native approval configuration');
  }
  const generation = randomUUID();
  const pending = new Map();
  let disposed = false;

  const settle = (entry, outcome) => {
    if (pending.get(keyOf(entry.view)) !== entry) return false;
    pending.delete(keyOf(entry.view));
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.abort);
    entry.resolve(outcome);
    return true;
  };

  const refresh = () => {
    for (const entry of [...pending.values()]) {
      if (entry.signal?.aborted) settle(entry, 'cancelled');
      else if (now() >= entry.view.expiresAt) settle(entry, 'unavailable');
    }
  };

  const answer = (request, next) => {
    const native = request?.studioNativeApproval;
    if (!native) return next();
    if (disposed || !validNativeRequest(native)) return Promise.resolve('unavailable');
    if (request.signal?.aborted) return Promise.resolve('cancelled');
    const view = Object.freeze({
      contract: STUDIO_NATIVE_APPROVAL_CONTRACT,
      generation,
      requestId: typeof request?.requestId === 'string' && request.requestId.length > 0
        ? request.requestId
        : `native-appr-${randomUUID().replaceAll('-', '')}`,
      agentId: native.agentId,
      sessionId: native.sessionId,
      runId: native.runId,
      interactionId: native.interactionId,
      hostInteractionId: native.hostInteractionId,
      callId: native.callId,
      toolName: native.toolName,
      ...(native.reason ? { reason: native.reason.slice(0, 2048) } : {}),
      choices: ['allow', 'deny'],
      expiresAt: now() + timeoutMs,
    });
    const key = keyOf(view);
    const current = pending.get(key);
    if (current) return current.promise;
    let resolve;
    const promise = new Promise(answered => { resolve = answered; });
    const entry = { view, promise, resolve, signal: request.signal, assertCurrent: native.assertCurrent };
    entry.abort = () => settle(entry, 'cancelled');
    entry.timer = setTimeout(() => settle(entry, 'unavailable'), timeoutMs);
    entry.timer.unref?.();
    pending.set(key, entry);
    request.signal?.addEventListener('abort', entry.abort, { once: true });
    if (request.signal?.aborted) entry.abort();
    return promise;
  };

  // The public DSH SessionController approvalDecision RPC reaches the
  // approval service's scoped decision waterfall. Resolve the Studio Native
  // presentation there, while the approval service remains responsible for
  // the waiting request and its paired durable audit event.
  const decision = (request, next) => {
    const entry = [...pending.values()].find(candidate => candidate.view.requestId === request?.requestId);
    if (!entry) return next();
    const outcome = request?.decision;
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return next();
    refresh();
    if (pending.get(keyOf(entry.view)) !== entry) return { accepted: false, reason: 'request-stale' };
    if (disposed || entry.signal?.aborted || now() >= entry.view.expiresAt) {
      settle(entry, 'cancelled');
      return { accepted: false, reason: 'request-stale' };
    }
    try { entry.assertCurrent?.(); }
    catch {
      settle(entry, 'cancelled');
      return { accepted: false, reason: 'request-stale' };
    }
    settle(entry, outcome);
    return { accepted: true, outcome };
  };

  const release = typeof ctx?.on === 'function'
    ? ctx.on('approval/request', answer, { prepend: true })
    : undefined;
  const decisionRelease = typeof ctx?.on === 'function'
    ? ctx.on('approval/decision', decision, { prepend: true })
    : undefined;

  const api = {
    snapshot({ agentId, sessionId, runId } = {}) {
      refresh();
      const rows = [...pending.values()].filter(entry => entry.view.agentId === agentId
        && entry.view.sessionId === sessionId && (runId === undefined || entry.view.runId === runId));
      return { contract: STUDIO_NATIVE_APPROVAL_CONTRACT, generation,
        agentId, sessionId, ...(runId === undefined ? {} : { runId }),
        interactive: !disposed && Boolean(release), pending: rows.map(entry => copy(entry.view)) };
    },

    decide({ agentId, sessionId, runId, interactionId, requestId, decision, expectedGeneration } = {}) {
      if (!DECISIONS.has(decision)) throw Object.assign(new Error('Native approval decision is invalid'), {
        code: 'STUDIO_NATIVE_APPROVAL_DECISION_INVALID', status: 400,
      });
      refresh();
      const entry = pending.get(`${runId}\u0000${interactionId}`);
      if (!entry || entry.view.agentId !== agentId || entry.view.sessionId !== sessionId
        || entry.view.requestId !== requestId || entry.view.generation !== expectedGeneration) {
        return { accepted: false, reason: 'request-stale' };
      }
      if (disposed || entry.signal?.aborted || now() >= entry.view.expiresAt) {
        settle(entry, 'cancelled');
        return { accepted: false, reason: 'request-stale' };
      }
      try { entry.assertCurrent?.(); }
      catch {
        settle(entry, 'cancelled');
        return { accepted: false, reason: 'request-stale' };
      }
      settle(entry, DECISIONS.get(decision));
      return { accepted: true, outcome: DECISIONS.get(decision), interactionId, runId };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      release?.();
      decisionRelease?.();
      for (const entry of [...pending.values()]) settle(entry, 'unavailable');
      pending.clear();
    },
  };
  return api;
}
