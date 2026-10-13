/**
 * AgentKit Studio brand primitives.
 *
 * The host owns typography and global chrome. These values are intentionally
 * scoped to Studio surfaces so installing the plugin cannot recolor DSH.
 */
export const AGENTKIT_STUDIO_BRAND = Object.freeze({
  name: 'AgentKit Studio',
  shortName: 'AgentKit',
  mark: 'Nexus',
  colors: Object.freeze({
    ink: '#0b1220',
    inkMuted: '#526174',
    canvas: '#f6f9fc',
    surface: '#ffffff',
    border: '#dbe5ef',
    accent: '#1858d6',
    accentStrong: '#144ab5',
    accentSoft: '#edf3ff',
    node: '#78dfec',
    signal: '#f0ad4e',
    danger: '#c44747',
  }),
  style: 'dsh-native',
});

/** One vector source for the sidebar, hero, favicon and packaged macOS icon. */
export const AGENTKIT_STUDIO_MARK_BODY = '<rect width="64" height="64" rx="16" fill="#1858d6"/><path d="M32 16v12M26 36l-11 6M38 36l11 6" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><circle cx="32" cy="32" r="8.6" fill="#fff"/><circle cx="32" cy="32" r="3.45" fill="#1858d6"/><circle cx="15.5" cy="42" r="5.2" fill="#fff"/><circle cx="48.5" cy="42" r="5.2" fill="#fff"/><circle cx="32" cy="13" r="5.2" fill="#78dfec"/>';
export const AGENTKIT_STUDIO_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="AgentKit Studio">${AGENTKIT_STUDIO_MARK_BODY}</svg>`;
