import { assistantBrowserUrl } from './assistant-links.mjs';

/** The native browser runs in its own graph with no Session, Workspace or Host transport. */
export async function createAssistantBrowserGraph({ modules, window, url, container, signal }) {
  const target = assistantBrowserUrl(url, window.location.origin);
  if (!target) throw new Error('此链接不能在助理浏览器中打开。');
  const { Context, React, renderer, locale, browser, createSnapshotStore } = modules;
  if (!browser?.apply || browser.inject?.includes('sidebarRight')) throw new Error('请更新 Studio 后使用内置浏览器。');
  const ctx = new Context();
  let unmount, disposal;
  const dispose = () => {
    if (disposal) return disposal;
    signal?.removeEventListener('abort', aborted);
    disposal = Promise.resolve().then(async () => { unmount?.(); unmount = undefined; await ctx.fiber.dispose(); });
    return disposal;
  };
  const aborted = () => { void dispose(); };
  signal?.addEventListener('abort', aborted, { once: true });
  const active = () => { signal?.throwIfAborted(); if (disposal) throw new Error('浏览器已关闭。'); };
  try {
    active();
    await ctx.plugin(renderer).await();
    active();
    const absent = createSnapshotStore({ key: undefined, hooks: {}, keyedHooks: {}, props: {} });
    ctx.slots.installScope('session', { current: absent, bindingSource: () => absent });
    await ctx.plugin({ inject: ['slots'], apply(scope) {
      const dictionaries = new locale.LocaleRuntime(scope);
      scope.provide('locale', dictionaries);
      scope.slots.installLocale(dictionaries);
    } }).await();
    active();
    await ctx.plugin(browser).await();
    active();
    ctx.slots.register({ name: 'root' }, function AssistantBrowserRoot({ renderFactorySlot }) {
      return React.createElement('div', { style: { height: '100%', minHeight: 0 } }, renderFactorySlot('browser.content', { url: target }));
    });
    unmount = ctx.get('uiRenderer').mount(container);
    return { dispose };
  } catch (error) { await dispose(); throw error; }
}
