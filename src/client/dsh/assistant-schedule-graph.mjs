/** Native Schedule factory in an isolated renderer; no local Session or Host transport. */
import { createAssistantScheduleRemote } from './assistant-schedule-remote.mjs';

export async function createAssistantScheduleGraph({ modules, execute, agentId, sessionId, signal, onConversation }) {
  const { Context, Service, React, renderer, locale, schedule, createSnapshotStore } = modules;
  if (!schedule || !Service || !locale.LocaleRuntime) throw new Error('请更新 Studio 后使用原生计划任务管理');
  const ctx = new Context(), lifetime = new AbortController(); let unmount, disposal;
  const adapter = createAssistantScheduleRemote({ execute, agentId, sessionId, signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]) });
  const dispose = () => disposal ||= (async () => {
    lifetime.abort(); adapter.dispose(); signal?.removeEventListener('abort', aborted);
    await Promise.resolve(); unmount?.(); await ctx.fiber.dispose();
  })();
  const aborted = () => { void dispose(); };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    signal?.throwIfAborted();
    await ctx.plugin(renderer).await();
    class ScopedScheduleRemote extends Service {
      constructor(scope) { super(scope, 'remote'); }
      $on(event, listener) { return adapter.subscribe(event, listener); }
    }
    await ctx.plugin({ inject: ['slots'], apply(scope) {
      new ScopedScheduleRemote(scope);
      scope.provide('remote.schedule', adapter.schedule);
      const dictionary = new locale.LocaleRuntime(scope);
      scope.provide('locale', dictionary); scope.slots.installLocale(dictionary);
      const absentSession = createSnapshotStore({ key: undefined, hooks: {}, keyedHooks: {}, props: { sessionId: undefined } });
      scope.slots.installScope('session', { current: absentSession, bindingSource(target) { if (target !== undefined) throw new Error('任务管理不打开本地会话'); return absentSession; } });
      scope.slots.provideRoot({ hooks: {
        sessions: createSnapshotStore({ phase: 'ready', ids: [sessionId], byId: { [sessionId]: { id: sessionId, title: '个人助理', displayTitle: '个人助理', running: false, blank: false, updatedAt: 0, retainedBy: {} } }, projectionsBySession: {} }),
        workspaces: createSnapshotStore({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }),
      } });
      scope.slots.register({ name: 'root', children: { 'shell.overlay': { kind: 'list', scope: 'root' } } }, function AssistantTasks({ renderFactorySlot, renderSlot }) {
        return React.createElement(React.Fragment, null,
          renderFactorySlot('schedule.manager', { onNewTask: onConversation, onOpenSession: id => { if (id === sessionId) onConversation(); } }),
          renderSlot('shell.overlay', {}));
      });
    } }).await();
    await ctx.plugin(schedule).await();
    lifetime.signal.throwIfAborted();
    return { ctx, dispose, mount(container) { lifetime.signal.throwIfAborted(); if (unmount) throw new Error('任务面板已打开'); unmount = ctx.get('uiRenderer').mount(container); } };
  } catch (error) { await dispose(); throw error; }
}
