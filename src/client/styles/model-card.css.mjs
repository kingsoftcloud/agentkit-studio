export default String.raw`
/* Model cards use the catalog's row dividers and DSH tags and disclosure. */
:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-content {
  display: grid;
  flex: 1;
  min-inline-size: 0;
  gap: 4px;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-title-row,
:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-summary {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  gap: var(--ms-space-2);
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-summary {
  flex-wrap: wrap;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.3;
}

:is([data-studio-model-settings], [data-studio-model-preview]) :is(.ms-card-display, .ms-card-id) {
  overflow: hidden;
  text-overflow: ellipsis;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-id {
  color: var(--ms-ink-2);
  font-size: 11px;
  font-family: var(--ds-font-family-code, monospace);
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-details {
  box-sizing: border-box;
  padding: 0 14px 6px 40px;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-body {
  display: grid;
  gap: var(--ms-space-3);
  padding: var(--ms-space-2) 0;
}

:is([data-studio-model-settings], [data-studio-model-preview]) :is(.ms-card-intro, .ms-card-note) {
  margin: 0;
  color: var(--ms-ink-2);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-section {
  border-block-start: 1px solid var(--ms-line);
  padding-block-start: var(--ms-space-2);
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-heading {
  margin: 0 0 var(--ms-space-1);
  font-size: 13px;
  font-weight: 600;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-facts {
  margin: 0;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-row {
  display: flex;
  justify-content: space-between;
  gap: var(--ms-space-3);
  padding: 6px 0;
  border-block-end: 1px solid var(--ms-line);
  font-size: 12px;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-row:last-child {
  border-block-end: 0;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-value {
  margin: 0;
  color: var(--ms-ink-2);
  text-align: end;
  font-variant-numeric: tabular-nums;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-radar {
  display: block;
  inline-size: min(100%, 340px);
  margin: 0 auto;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-radar-grid {
  fill: none;
  stroke: var(--ms-line);
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-radar-shape {
  fill: color-mix(in srgb, var(--ms-accent) 22%, transparent);
  stroke: var(--ms-accent);
  stroke-width: 1.5;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-radar-dot {
  fill: var(--ms-accent);
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-radar-label {
  fill: var(--ms-ink-2);
  font-size: 10.5px;
}

:is([data-studio-model-settings], [data-studio-model-preview]) .ms-card-radar-value {
  fill: var(--ms-ink);
  font-weight: 600;
}

[data-studio-model-preview] {
  --ms-ink: var(--dsw-alias-label-primary, CanvasText);
  --ms-ink-2: var(--dsw-alias-label-secondary, CanvasText);
  --ms-line: var(--dsw-alias-border-l3, #93949b);
  --ms-accent: var(--dsw-alias-state-business-primary, #5976e8);
  --ms-space-1: 4px;
  --ms-space-2: 8px;
  --ms-space-3: 10px;
  position: fixed;
  z-index: 1101;
  visibility: hidden;
  pointer-events: none;
  box-sizing: border-box;
  inline-size: min(310px, calc(100vw - 16px));
  max-block-size: calc(100dvh - 16px);
  overflow: hidden;
  border: 1px solid var(--ms-line);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-elevated, Canvas);
  color: var(--ms-ink);
  box-shadow: 0 8px 30px rgb(0 0 0 / 18%);
  font-size: 13px;
}
[data-studio-model-preview] .ms-card-radar {
  max-block-size: 145px;
}
`;
