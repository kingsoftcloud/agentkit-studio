/** Independent presentation of a host's content-free, committed context quote. */
export function createContextStatus(React) {
  const h = React.createElement;
  return function ContextStatus({ value, runId, labels = {} }) {
    if (!value || value.contract !== 'agentkit.native-context-status/v1' || value.runId !== runId) return null;
    const l = { context: 'Context', automatic: 'Automatic compaction', disabled: 'Disabled', trigger: 'Trigger',
      reserved: 'Reserved output', lastRequest: 'Last prepared request (estimated)', unknown: 'Not measured',
      compacting: 'Compacting context…', interrupted: 'Context compaction interrupted', blocked: 'Context budget blocked',
      completed: 'Compactions completed', ...labels };
    const input = Number.isSafeInteger(value.lastRequestInputTokens) && value.lastRequestInputTokens >= 0 ? value.lastRequestInputTokens : null;
    const window = Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0 ? value.contextWindow : null;
    const count = Number.isSafeInteger(value.compactions) && value.compactions >= 0 ? value.compactions : 0;
    const reserved = Number.isSafeInteger(value.reservedOutputTokens) && value.reservedOutputTokens >= 0 ? `${value.reservedOutputTokens.toLocaleString()} tokens` : l.unknown;
    const threshold = Number.isFinite(value.thresholdRatio) ? `${Math.round(value.thresholdRatio * 100)}%` : l.unknown;
    const summary = value.state === 'compacting' ? l.compacting : value.state === 'interrupted' ? l.interrupted
      : value.state === 'blocked' ? l.blocked : `${l.context} · ${input === null ? l.unknown : input.toLocaleString() + (window ? ' / ' + window.toLocaleString() : '')}${count ? ' · ' + l.completed + ' ' + count : ''}`;
    return h('details', { className: 'harness-context-status', 'data-testid': 'context-status', 'data-state': value.state },
      h('summary', { role: value.state === 'compacting' ? 'status' : undefined }, summary),
      h('dl', null,
        h('dt', null, l.lastRequest), h('dd', null, input === null ? l.unknown : `${input.toLocaleString()} tokens`),
        h('dt', null, l.reserved), h('dd', null, reserved),
        h('dt', null, l.automatic), h('dd', null, value.enabled ? `${l.trigger} ${threshold}` : l.disabled),
        h('dt', null, l.completed), h('dd', null, count)));
  };
}
export const contextStatusStyles = `
.harness-context-status { color: var(--harness-fg-muted, #888); font-size: 12px; margin: 12px 0; }
.harness-context-status > summary { cursor: pointer; }
.harness-context-status[data-state="compacting"] > summary { animation: harness-context-pulse 1.5s ease-in-out infinite; }
.harness-context-status dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; margin: 8px 0; }
.harness-context-status dd { margin: 0; }
@keyframes harness-context-pulse { 50% { opacity: .5; } }
@media (prefers-reduced-motion: reduce) { .harness-context-status > summary { animation: none !important; } }
`;
