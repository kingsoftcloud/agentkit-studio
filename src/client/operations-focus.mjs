export const OPERATIONS_FOCUS_KEY = 'agentkit-studio:operations-focus';

export function readOperationsFocus(window) {
  try {
    const focus = JSON.parse(window.localStorage.getItem(OPERATIONS_FOCUS_KEY));
    return focus?.tab === 'delivery' && typeof focus.agentId === 'string' && ['build', 'deploy'].includes(focus.section) ? focus : null;
  } catch { return null; }
}

export function focusOperations({ window, agentId, section, onNavigate }) {
  const focus = { tab: 'delivery', agentId, section };
  try { window.localStorage.setItem(OPERATIONS_FOCUS_KEY, JSON.stringify(focus)); } catch { /* Navigation still works without browser storage. */ }
  window.dispatchEvent(new (window.CustomEvent || globalThis.CustomEvent)(OPERATIONS_FOCUS_KEY, { detail: focus }));
  onNavigate('studio-operations');
}

export function consumeOperationsFocus(window, focus) {
  const stored = readOperationsFocus(window);
  if (stored?.agentId === focus?.agentId && stored?.section === focus?.section) {
    try { window.localStorage.removeItem(OPERATIONS_FOCUS_KEY); } catch { /* Browser storage can be disabled. */ }
  }
}
