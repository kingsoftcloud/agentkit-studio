/**
 * AgentKit Studio brand primitives.
 *
 * The host owns typography and global chrome. These values are intentionally
 * scoped to Studio surfaces so installing the plugin cannot recolor DSH.
 */
export const AGENTKIT_STUDIO_BRAND = Object.freeze({
  name: 'AgentKit Studio',
  shortName: 'AgentKit',
  mark: 'A',
  colors: Object.freeze({
    ink: '#0b1220',
    inkMuted: '#526174',
    canvas: '#f6f9fc',
    surface: '#ffffff',
    border: '#dbe5ef',
    accent: '#0aa6a6',
    accentStrong: '#087f86',
    accentSoft: '#dff7f4',
    signal: '#f0ad4e',
    danger: '#c44747',
  }),
  style: 'industrial-cloud',
});

/** Inline SVG path data shared by the browser mark and exported assets. */
export const AGENTKIT_STUDIO_MARK_PATH = 'M32 6 7 54h11l5-10h18l5 10h11L32 6Zm0 18 5 10H27l5-10Z';
