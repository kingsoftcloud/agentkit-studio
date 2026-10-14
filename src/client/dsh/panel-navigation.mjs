import { PANELS } from '../theme.mjs';

export const ACTIVE_PANEL_KEY = 'agentkit-studio:active-panel';

export function registerPanelNavigation(ctx, { window = globalThis.window, panels = PANELS, storageKey = ACTIVE_PANEL_KEY, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
  ctx.effect(() => {
    let restoring = true;
    let closed = false;
    const subscription = ctx.layout.panelInfo?.subscribe?.(() => {
      if (closed || restoring) return;
      try {
        const info = ctx.layout.panelInfo.getSnapshot?.();
        const id = String(info?.activePanelId || '');
          if (id) window.localStorage.setItem(storageKey, id);
          else window.localStorage.removeItem(storageKey);
      } catch { /* layout store unavailable */ }
    });
    const timer = setTimeout(() => {
      if (closed) return;
      try {
          const last = window.localStorage.getItem(storageKey);
          const next = panels.find(item => item.id === last);
        if (next) ctx.layout.selectPanel(next.id);
      } catch { /* private mode */ }
      finally { restoring = false; }
    }, 0);
    return () => {
      closed = true;
      clearTimeout(timer);
      subscription?.unsubscribe?.();
    };
  }, 'agentkit-studio:active-panel-restore');
}
