import { KSXC_CHANGED } from '../pages/ksxc-settings.mjs';

export const KSXC_GATEWAY_POLL_MS = 15_000;

export function installKsxcVisibility({ ctx, hostRemote, window, CustomEvent, render }) {
  if (typeof hostRemote.ksxcStatus !== 'function') return () => {};
  let stopped = false;
  let syncing = false;
  let visible = false;
  let disposeSettings;

  const apply = next => {
    if (stopped || next === visible) return;
    visible = next;
    disposeSettings?.();
    disposeSettings = undefined;
    if (visible) {
      disposeSettings = ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'agentkit-ksxc', order: 195, label: 'KSXC',
      }, render));
    }
    window.dispatchEvent(new CustomEvent(KSXC_CHANGED));
  };
  const sync = async () => {
    if (stopped || syncing) return;
    syncing = true;
    try {
      const status = await hostRemote.ksxcStatus(undefined, { gatewayOnly: true });
      apply(status?.supported === true && status?.gateway?.reachable === true);
    } catch {
      apply(false);
    } finally {
      syncing = false;
    }
  };

  // Start hidden so an unreachable internal runtime never flashes for external
  // users. The same cached Host status is read by the form and runtime catalog.
  void sync();
  const timer = window.setInterval(() => { void sync(); }, KSXC_GATEWAY_POLL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    disposeSettings?.();
  };
}
