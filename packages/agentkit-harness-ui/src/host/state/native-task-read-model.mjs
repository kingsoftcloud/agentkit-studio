import { validateNativeRecoveryStatus } from './native-recovery.mjs';

const id = value => typeof value === 'string' && value.trim() && value.length <= 256;
const check = (value, message) => { if (!value) throw Error(message); };
const loading = () => ({ phase: 'loading', observation: null, refreshing: false, error: null });

/** One coherent presentation snapshot per Agent/Session. It never resumes work.
 * SDK content supplies text deltas; only a complete authenticated read snapshot
 * supplies Native outcomes, historical receipt states and child bindings.
 */
export function createNativeTaskReadModel({ hostRemote, agentId, sessionId }) {
  check(id(agentId) && id(sessionId), '任务读取身份无效');
  const identity = { agentId, sessionId }, listeners = new Set(), lifetime = new AbortController();
  let state = loading(), active = null, timer = null, disposed = false, polling = false;
  const publish = change => {
    if (disposed) return;
    state = { ...state, ...change };for (const listener of listeners) listener(state);
  };
  const readStatus = async () => validateNativeRecoveryStatus(
    await hostRemote.nativeRecoveryStatus(identity, lifetime.signal), identity);
  const readChildren = async () => {
    const first = await hostRemote.nativeChildHistory({ ...identity, limit: 64 }, lifetime.signal);
    check(first?.contract === 'agentkit.studio-native-child-history/v1' && first.sessionId === sessionId
      && (first.runId === null || id(first.runId)) && /^[a-f0-9]{64}$/.test(first.inventoryDigest ?? '')
      && Number.isSafeInteger(first.totalTasks) && first.totalTasks >= 0 && first.totalTasks <= 10000,
    '子任务目录与原会话不一致');
    const tasks = [], seen = new Set();let offset = 0, page = first;
    while (true) {
      check(page.contract === first.contract && page.sessionId === sessionId && page.runId === first.runId
        && page.inventoryDigest === first.inventoryDigest && page.totalTasks === first.totalTasks
        && page.offset === offset && Array.isArray(page.tasks) && page.tasks.length <= 64
        && page.nextOffset === offset + page.tasks.length && page.nextOffset <= first.totalTasks
        && page.complete === (page.nextOffset === first.totalTasks), '子任务目录读取期间发生变化');
      for (const task of page.tasks) {
        check(id(task?.childRunId) && id(task.parentRunId) && id(task.sessionId) && id(task.role)
          && Number.isSafeInteger(task.snapshotRevision) && task.snapshotRevision >= 0 && !seen.has(task.childRunId),
        '子任务目录包含无效或重复身份');
        seen.add(task.childRunId);tasks.push(task);
      }
      if (page.complete) break;
      check(page.nextOffset > offset, '子任务目录未取得进展');
      offset = page.nextOffset;
      page = await hostRemote.nativeChildHistory({ ...identity, limit: 64, offset,
        inventoryDigest: first.inventoryDigest }, lifetime.signal);
      lifetime.signal.throwIfAborted();
    }
    return { runId: first.runId, inventoryDigest: first.inventoryDigest, tasks };
  };
  const refresh = ({ fresh = false } = {}) => {
    if (disposed) return Promise.resolve();
    if (active) return fresh ? active.then(() => refresh()) : active;
    publish({ refreshing: true, ...(state.observation ? {} : { phase: 'loading' }), error: null });
    active = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = await readStatus();lifetime.signal.throwIfAborted();
          const inventory = await readChildren();lifetime.signal.throwIfAborted();
          const status = await readStatus();lifetime.signal.throwIfAborted();
          // A new turn can be admitted between reads. Never combine its status
          // with the prior turn's directory; read the current owner again.
          if (status.runId !== before.runId || inventory.runId !== status.runId) continue;
          publish({ phase: 'ready', observation: { status, children: inventory.tasks,
            inventoryDigest: inventory.inventoryDigest }, error: null });
          return;
        }
        throw Error('任务运行已变化，正在重新同步');
      } catch {
        if (!disposed) publish({ phase: state.observation ? 'ready' : 'error', error: '任务过程同步失败，请重试。' });
      } finally { active = null;publish({ refreshing: false }); }
    })();
    return active;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener);return () => listeners.delete(listener); },
    refresh,
    startPolling(intervalMs = () => 1500) {
      check(!polling, '任务读取已在轮询');polling = true;
      let stopped = false;
      const poll = async () => {
        await refresh();
        if (!stopped && !disposed) timer = setTimeout(poll, Math.max(100, Number(intervalMs()) || 1500));
      };
      void poll();
      return () => { stopped = true;polling = false;clearTimeout(timer);timer = null; };
    },
    dispose() { disposed = true;lifetime.abort();clearTimeout(timer);listeners.clear(); },
  };
}
