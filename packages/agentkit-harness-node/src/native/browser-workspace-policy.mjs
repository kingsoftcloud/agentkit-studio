/** The workspace browser owner supplies both its URL policy and its immutable
 * capability description. Neither description nor a model argument grants a URL. */
export const WORKSPACE_BROWSER_BOUNDARY = Object.freeze({
  contract: 'agentkit.workspace-browser-capability/v1', toolName: 'browser_inspect_workspace',
  networkPolicy: 'workspace-origin/v1', servedFiles: 'entry-directory/v1',
  externalNetwork: false, viewport: Object.freeze([1280, 720]),
});

export function workspaceBrowserCapability({ available = true } = {}) {
  if (typeof available !== 'boolean') throw Error('invalid_workspace_browser_availability');
  return { ...WORKSPACE_BROWSER_BOUNDARY, viewport: [...WORKSPACE_BROWSER_BOUNDARY.viewport],
    availability: available ? 'available' : 'unavailable' };
}

/** A per-page origin and opaque path grant remain private execution data. */
export function allowsWorkspaceBrowserUrl(value, { origin, prefix, closed = false }) {
  if (closed || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && url.pathname.startsWith(prefix);
  } catch { return false; }
}
