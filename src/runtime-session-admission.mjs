/** Bounded per-Session turn admission for the managed runtime transport.
 *
 * One Session executes one turn at a time. A second request waits behind the
 * active turn instead of failing immediately: only a full wait queue or an
 * expired wait is refused, and the refusal names the current holder.
 *
 * A turn owns the Session as `{ turnId, owner }` with a heartbeat and a
 * wall-clock deadline. The deadline is the reclamation path for a handler that
 * stopped making progress after an abnormal interruption (aborted client, hung
 * native flush, sandbox bootstrap failure): the turn is aborted and, after a
 * fence grace, its lease is revoked so the queued turn can start. A revoked
 * turn can no longer release the Session, so a late zombie cannot admit a
 * second turn concurrently.
 *
 * This lease lives in one runtime process. Durable cross-process ownership
 * (resume/takeover of an open native turn) remains with the DSH external-turn
 * seam; `owner` and `onReclaim` are the hand-off points for that layer.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export const SESSION_ADMISSION_DEFAULTS = Object.freeze({
  /** Waiting turns admitted per Session before refusing with RUNTIME_SESSION_BUSY. */
  queueLimit: 8,
  /** Maximum time a turn may wait for its Session to become idle. */
  waitTimeoutMs: 120_000,
  /** Wall-clock deadline for one admitted turn; 0 disables reclamation.
   *  It must stay above the turn engine's own timeout so a live engine is
   *  never mistaken for a stuck handler. */
  turnTimeoutMs: 10 * 60_000,
  /** Grace after the deadline abort before the lease is revoked. */
  fenceGraceMs: 15_000,
  /** Owner liveness beat recorded while the turn is admitted. */
  heartbeatMs: 5_000,
  /** Suggested retry delay returned with a refusal. */
  retryAfterMs: 5_000,
});

const fail = (code, status, message, extra = {}) => Object.assign(new Error(message || code), { code, status, ...extra });
const unref = timer => { timer?.unref?.(); return timer; };
const elapsed = (from, now) => Math.max(0, Math.round(now() - from));

/** Process identity recorded as the turn owner. */
export function runtimeOwner({ instanceId = randomUUID(), pid = process.pid, host = hostname(), startedAt = Date.now() } = {}) {
  return Object.freeze({ instanceId, pid, host, startedAt });
}

function deferred() {
  const result = {};
  result.promise = new Promise((resolve, reject) => { result.resolve = resolve; result.reject = reject; });
  result.promise.catch(() => {});
  return result;
}

export function createSessionAdmission(options = {}) {
  const queueLimit = options.queueLimit ?? SESSION_ADMISSION_DEFAULTS.queueLimit;
  const waitTimeoutMs = options.waitTimeoutMs ?? SESSION_ADMISSION_DEFAULTS.waitTimeoutMs;
  const turnTimeoutMs = options.turnTimeoutMs ?? SESSION_ADMISSION_DEFAULTS.turnTimeoutMs;
  const fenceGraceMs = options.fenceGraceMs ?? SESSION_ADMISSION_DEFAULTS.fenceGraceMs;
  const heartbeatMs = options.heartbeatMs ?? SESSION_ADMISSION_DEFAULTS.heartbeatMs;
  const retryAfterMs = options.retryAfterMs ?? SESSION_ADMISSION_DEFAULTS.retryAfterMs;
  const now = options.now ?? Date.now;
  const owner = options.owner ?? runtimeOwner();
  const onReclaim = options.onReclaim ?? (() => {});
  for (const [name, value] of Object.entries({ queueLimit, waitTimeoutMs, turnTimeoutMs, fenceGraceMs, heartbeatMs, retryAfterMs }))
    if (!Number.isSafeInteger(value) || value < 0) throw fail('RUNTIME_SESSION_ADMISSION_INVALID', 500, `invalid ${name}`);
  if (typeof onReclaim !== 'function') throw fail('RUNTIME_SESSION_ADMISSION_INVALID', 500, 'invalid onReclaim');

  /** sessionId -> { sessionId, holder, queue } */
  const lanes = new Map();
  const totals = { admitted: 0, queued: 0, refused: 0, waitedOut: 0, reclaimed: 0 };
  let closed = null;
  let closedError = null;

  const laneFor = sessionId => {
    let lane = lanes.get(sessionId);
    if (!lane) { lane = { sessionId, holder: null, queue: [] }; lanes.set(sessionId, lane); }
    return lane;
  };

  const holderView = holder => holder && {
    runId: holder.turnId,
    requestId: holder.requestId,
    owner: holder.owner,
    admittedAt: holder.admittedAt,
    elapsedMs: elapsed(holder.admittedAt, now),
    heartbeatAt: holder.heartbeatAt,
    heartbeatAgeMs: elapsed(holder.heartbeatAt, now),
    expiring: holder.expiring === true,
  };

  const waiting = lane => lane.queue.filter(waiter => !waiter.cancelled);
  const laneView = lane => ({
    sessionId: lane.sessionId,
    holder: holderView(lane.holder),
    queue: { length: waiting(lane).length, limit: queueLimit,
      oldestWaitMs: waiting(lane).length ? elapsed(waiting(lane)[0].enqueuedAt, now) : 0 },
    retryAfterMs,
  });

  const describe = sessionId => {
    const lane = lanes.get(sessionId);
    return lane ? laneView(lane) : { sessionId, holder: null, queue: { length: 0, limit: queueLimit, oldestWaitMs: 0 }, retryAfterMs };
  };

  function refusal(code, lane, message) {
    const view = laneView(lane);
    const holder = view.holder;
    const detail = { ...view,
      ...(holder ? { holder: { ...holder, ...(turnTimeoutMs > 0
        ? { remainingMs: Math.max(0, holder.admittedAt + turnTimeoutMs - now()) } : {}) } } : {}) };
    return fail(code, 409, message, { detail, retryAfterMs });
  }

  function busy(lane) {
    const holder = lane.holder;
    const held = holder ? `运行 ${holder.turnId}（请求 ${holder.requestId}）已执行 ${Math.round(elapsed(holder.admittedAt, now) / 1000)}s` : '另一轮次';
    return refusal('RUNTIME_SESSION_BUSY', lane,
      `会话 ${lane.sessionId} 正被${held}占用；等待队列已满（${waiting(lane).length}/${queueLimit}），请约 ${Math.ceil(retryAfterMs / 1000)}s 后重试`);
  }

  function waitedOut(lane, waitedMs) {
    const holder = lane.holder;
    const held = holder ? `，当前持有者 ${holder.turnId}（请求 ${holder.requestId}）` : '';
    return refusal('RUNTIME_SESSION_WAIT_TIMEOUT', lane,
      `会话 ${lane.sessionId} 等待 ${Math.round(waitedMs / 1000)}s 仍未空闲${held}；请稍后重试`);
  }

  function clearHolderTimers(holder) {
    clearInterval(holder.heartbeatTimer);
    clearTimeout(holder.expiryTimer);
    clearTimeout(holder.fenceTimer);
    holder.heartbeatTimer = holder.expiryTimer = holder.fenceTimer = null;
  }

  /** Settle one holder exactly once and wake duplicate waiters. */
  function settleHolder(holder, outcome) {
    if (holder.settled) return false;
    holder.settled = true;
    holder.outcome = outcome;
    clearHolderTimers(holder);
    holder.done.resolve(outcome);
    return true;
  }

  function fence(lane, holder) {
    if (holder.settled || lane.holder !== holder) return;
    holder.fenced = true;
    totals.reclaimed++;
    settleHolder(holder, 'fenced');
    lane.holder = null;
    try { onReclaim({ sessionId: lane.sessionId, turnId: holder.turnId, requestId: holder.requestId,
      owner: holder.owner, admittedAt: holder.admittedAt, elapsedMs: elapsed(holder.admittedAt, now) }); } catch { /* diagnostics cannot change admission */ }
    try { holder.onFence?.(); } catch { /* the fenced handler owns its transport cleanup */ }
    dispatch(lane);
  }

  function expire(lane, holder) {
    if (holder.settled || holder.expiring) return;
    holder.expiring = true;
    try { holder.onTurnTimeout?.(); } catch { /* the abort below still fences the lease */ }
    holder.fenceTimer = unref(setTimeout(() => fence(lane, holder), fenceGraceMs));
  }

  function createHolder(lane, { turnId, requestId, onTurnTimeout, onFence, waitedMs = 0 }) {
    const admittedAt = now();
    const holder = { turnId, requestId, owner, admittedAt, heartbeatAt: admittedAt, waitedMs,
      settled: false, fenced: false, expiring: false, outcome: null, onTurnTimeout, onFence,
      done: deferred(), heartbeatTimer: null, expiryTimer: null, fenceTimer: null };
    lane.holder = holder;
    totals.admitted++;
    if (heartbeatMs > 0) holder.heartbeatTimer = unref(setInterval(() => { holder.heartbeatAt = now(); }, heartbeatMs));
    if (turnTimeoutMs > 0) holder.expiryTimer = unref(setTimeout(() => expire(lane, holder), turnTimeoutMs));
    return Object.freeze({
      sessionId: lane.sessionId, turnId, requestId, owner, admittedAt, waitedMs, queued: waitedMs > 0,
      release: () => release(lane, holder),
      describe: () => holderView(holder),
    });
  }

  function dispatch(lane) {
    while (!lane.holder && lane.queue.length) {
      const waiter = lane.queue.shift();
      if (waiter.cancelled) continue;
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
      const handle = createHolder(lane, { ...waiter, waitedMs: elapsed(waiter.enqueuedAt, now) });
      waiter.done.resolve('admitted');
      waiter.resolve(handle);
    }
    if (!lane.holder && lane.queue.length === 0 && lanes.get(lane.sessionId) === lane) lanes.delete(lane.sessionId);
  }

  function release(lane, holder) {
    if (lane.holder !== holder || holder.settled) {
      // The lease was revoked (fenced) or already released: a zombie turn must
      // never admit the next turn while another one owns the Session.
      return false;
    }
    settleHolder(holder, 'released');
    lane.holder = null;
    dispatch(lane);
    return true;
  }

  function cancelWaiter(lane, waiter, error) {
    if (waiter.cancelled) return;
    waiter.cancelled = true;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
    waiter.done.resolve('cancelled');
    waiter.reject(error);
    if (!lane.holder && lanes.get(lane.sessionId) === lane) {
      const index = lane.queue.indexOf(waiter);
      if (index >= 0) lane.queue.splice(index, 1);
      if (lane.queue.length === 0) lanes.delete(lane.sessionId);
    }
  }

  function duplicateFor(sessionId, turnId) {
    const lane = lanes.get(sessionId);
    if (!lane) return null;
    if (lane.holder?.turnId === turnId) return lane.holder.done.promise;
    const queued = lane.queue.find(waiter => !waiter.cancelled && waiter.turnId === turnId);
    return queued ? queued.done.promise : null;
  }

  /** Wait for the duplicate turn to settle, bounded by the same wait budget. */
  function awaitDuplicate(sessionId, settled, signal, deadline) {
    const late = message => fail('RUNTIME_SESSION_WAIT_TIMEOUT', 409, message,
      { detail: { ...describe(sessionId) }, retryAfterMs });
    return new Promise((resolve, reject) => {
      const remaining = deadline - now();
      if (remaining <= 0) return reject(late('等待原轮次结束超时'));
      let timer, onAbort;
      const finish = (action, value) => {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        action(value);
      };
      timer = unref(setTimeout(() => finish(reject, late(`等待原轮次 ${waitTimeoutMs / 1000}s 仍未结束`)), remaining));
      if (signal) {
        onAbort = () => finish(reject, signal.reason || fail('RUNTIME_CLIENT_DISCONNECTED', 499, 'client disconnected'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      settled.then(() => finish(resolve), error => finish(reject, error));
    });
  }

  function enter({ sessionId, turnId, requestId, signal, onTurnTimeout, onFence }, deadline) {
    if (closed) return Promise.reject(closedError);
    const lane = laneFor(sessionId);
    if (!lane.holder && lane.queue.length === 0) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return Promise.resolve(createHolder(lane, { turnId, requestId, onTurnTimeout, onFence }));
    }
    if (waiting(lane).length >= queueLimit) {
      totals.refused++;
      return Promise.reject(busy(lane));
    }
    return new Promise((resolve, reject) => {
      const waiter = { turnId, requestId, onTurnTimeout, onFence, enqueuedAt: now(), timer: null,
        cancelled: false, done: deferred(), resolve, reject, signal, onAbort: null };
      const remaining = deadline - now();
      if (remaining <= 0) { totals.waitedOut++; return reject(waitedOut(lane, 0)); }
      waiter.timer = unref(setTimeout(() => {
        totals.waitedOut++;
        cancelWaiter(lane, waiter, waitedOut(lane, now() - waiter.enqueuedAt));
      }, remaining));
      if (signal) {
        waiter.onAbort = () => cancelWaiter(lane, waiter, signal.reason || fail('RUNTIME_CLIENT_DISCONNECTED', 499, 'client disconnected'));
        signal.addEventListener('abort', waiter.onAbort, { once: true });
        if (signal.aborted) cancelWaiter(lane, waiter, signal.reason);
      }
      totals.queued++;
      lane.queue.push(waiter);
    });
  }

  return Object.freeze({
    owner,
    metrics: () => ({ ...totals, sessions: lanes.size, queueLimit, waitTimeoutMs, turnTimeoutMs, fenceGraceMs }),
    describe,
    /** Take the Session: wait behind the holder, refuse only when full or late. */
    async acquire({ sessionId, turnId, requestId, signal, onTurnTimeout, onFence } = {}) {
      if (typeof sessionId !== 'string' || !sessionId || typeof turnId !== 'string' || !turnId) throw fail('RUNTIME_SESSION_ADMISSION_INVALID', 500, 'sessionId and turnId are required');
      if (closed) throw closedError;
      if (signal?.aborted) throw signal.reason;
      const deadline = now() + waitTimeoutMs;
      // A retried request owns the same turn: wait for the original to settle
      // instead of starting a second execution, then take the Session.
      for (;;) {
        const duplicate = duplicateFor(sessionId, turnId);
        if (!duplicate) break;
        await awaitDuplicate(sessionId, duplicate, signal, deadline);
        if (closed) throw closedError;
      }
      return enter({ sessionId, turnId, requestId, signal, onTurnTimeout, onFence }, deadline);
    },
    /** Refuse every waiter for a deleted Session; the holder is aborted by its run. */
    cancelSession(sessionId, error = fail('RUNTIME_CANCELLED', 409, 'session cancelled')) {
      const lane = lanes.get(sessionId);
      if (!lane) return;
      for (const waiter of [...lane.queue]) cancelWaiter(lane, waiter, error);
      if (!lane.holder && lanes.get(sessionId) === lane) lanes.delete(sessionId);
    },
    close() {
      if (closed) return;
      closedError = fail('RUNTIME_STOPPING', 503, 'runtime is stopping');
      closed = true;
      for (const lane of [...lanes.values()]) {
        for (const waiter of [...lane.queue]) cancelWaiter(lane, waiter, closedError);
        if (lane.holder) { clearHolderTimers(lane.holder); settleHolder(lane.holder, 'closed'); lane.holder = null; }
      }
      lanes.clear();
    },
  });
}
