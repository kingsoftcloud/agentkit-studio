/** Link admission for assistant Markdown and the disposable browser graph. */
export function assistantBrowserUrl(value, applicationOrigin) {
  if (typeof value !== 'string' || value.length > 16 * 1024) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (applicationOrigin && applicationOrigin !== 'null') {
    try { if (url.origin === new URL(applicationOrigin).origin) return null; } catch { return null; }
  }
  return url.href;
}

/** Capture only transcript Markdown activation, including keyboard and modified clicks. */
export function interceptAssistantLink(event, { applicationOrigin, open, refuse }) {
  const anchor = event.target?.closest?.('[data-assistant-markdown] a[href]');
  if (!anchor || !event.currentTarget?.contains(anchor) || anchor.hasAttribute('download')) return false;
  event.preventDefault(); event.stopPropagation();
  const url = assistantBrowserUrl(anchor.getAttribute('href'), applicationOrigin);
  if (url) open(url); else refuse?.();
  return true;
}
