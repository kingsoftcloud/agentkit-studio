export const BRAND = {
  // Use the established Studio neutral console tokens. The AgentKit mark,
  // layout and product surfaces remain owned by this application.
  ink: 'var(--dsw-alias-label-primary, #0d0d0d)',
  inkMuted: 'var(--dsw-alias-label-secondary, #676767)',
  canvas: 'var(--dsw-alias-bg-layer-2, #f4f5f6)',
  surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
  border: 'var(--dsw-alias-border-l3, #d4d4d4)',
  controlBorder: 'var(--dsw-alias-border-l4, #d4d4d4)',
  accent: 'var(--dsw-alias-brand-primary, #0d0d0d)',
  accentStrong: 'var(--dsw-alias-label-primary, #000000)',
  primaryFill: 'var(--dsw-alias-button-primary-fill, #0b0b0d)',
  primaryText: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  accentSoft: 'var(--dsw-alias-interactive-bg-hover, #f0f0f0)',
  signal: 'var(--dsw-alias-state-warn-primary, #946200)',
  danger: 'var(--dsw-alias-state-error-primary, #b42318)',
};

export const PANELS = [
  { id: 'studio-overview', page: 'overview', label: '总览', note: '工作区状态', glyph: '⌂' },
  { id: 'studio-assistant', page: 'assistant', label: '个人助理', note: '云端持续运行，记忆随你积累', glyph: '✧' },
  { id: 'studio-agents', page: 'agents', label: '智能体', note: '我的智能体与模板广场', glyph: '✦' },
  { id: 'studio-resources', page: 'resource-hub', label: '资源库', note: '模型、工具与运行资源', glyph: '◈' },
  { id: 'studio-operations', page: 'operations', label: '运行中心', note: '构建、部署与观测', glyph: '↗' },
];

export const ALLOWED_RUNTIME_TYPES = ['dsh-native', 'harness', 'codex'];

export const RUNTIME_LABELS = {
  'dsh-native': 'DSH Native Harness',
  harness: 'Star Harness',
  codex: 'Codex Agent',
};
