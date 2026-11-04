/** Render the cold-start bridge notice without owning any Studio product surface. */

const NOTICE_ID = 'agentkit-studio-bridge-startup';
const STARTING_TEXT = '正在启动本地服务…';

/**
 * Show a small non-blocking pill while the Host webserver finishes registering
 * the `/agentkit` control channel, then remove it when the bridge answers.
 *
 * @param {{ window?: any, document?: any }} [scope] - renderer globals, injectable for tests.
 * @returns {() => void} teardown for the Studio application scope.
 */
export function installBridgeStartupNotice({ window = globalThis.window, document = globalThis.document } = {}) {
  if (!window?.addEventListener || !document?.createElement) return () => {};
  const hide = () => { document.getElementById(NOTICE_ID)?.remove(); };
  const show = detail => {
    hide();
    const pill = document.createElement('div');
    pill.id = NOTICE_ID;
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    pill.textContent = String(detail?.message || STARTING_TEXT);
    pill.style.cssText = 'position:fixed;top:44px;right:18px;z-index:2147483001;padding:6px 12px;border-radius:999px;'
      + 'background:rgba(17,24,39,.86);color:#fff;font:12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;'
      + 'box-shadow:0 4px 16px rgba(15,23,42,.18);pointer-events:none;transition:opacity .2s ease;';
    document.body.append(pill);
  };
  const onStarting = event => show(event?.detail);
  const onSettled = () => hide();
  window.addEventListener('agentkit-studio:bridge-starting', onStarting);
  window.addEventListener('agentkit-studio:bridge-ready', onSettled);
  window.addEventListener('agentkit-studio:bridge-exhausted', onSettled);
  return () => {
    window.removeEventListener('agentkit-studio:bridge-starting', onStarting);
    window.removeEventListener('agentkit-studio:bridge-ready', onSettled);
    window.removeEventListener('agentkit-studio:bridge-exhausted', onSettled);
    hide();
  };
}
