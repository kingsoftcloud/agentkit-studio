export default String.raw`
/* Model cards use the catalog's row dividers and DSH tags and disclosure. */
[data-studio-model-settings] .ms-card-content {
  display: grid;
  flex: 1;
  min-inline-size: 0;
  gap: 4px;
}

[data-studio-model-settings] .ms-card-title-row,
[data-studio-model-settings] .ms-card-summary {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  gap: var(--ms-space-2);
}

[data-studio-model-settings] .ms-card-summary {
  flex-wrap: wrap;
}

[data-studio-model-settings] .ms-card-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.3;
}

[data-studio-model-settings] :is(.ms-card-display, .ms-card-id) {
  overflow: hidden;
  text-overflow: ellipsis;
}

[data-studio-model-settings] .ms-card-id {
  color: var(--ms-ink-2);
  font-size: 11px;
  font-family: var(--ds-font-family-code, monospace);
}

[data-studio-model-settings] .ms-card-details {
  box-sizing: border-box;
  padding: 0 14px 6px 40px;
}

[data-studio-model-settings] .ms-card-body {
  display: grid;
  gap: var(--ms-space-3);
  padding: var(--ms-space-2) 0;
}

[data-studio-model-settings] :is(.ms-card-intro, .ms-card-note) {
  margin: 0;
  color: var(--ms-ink-2);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

[data-studio-model-settings] .ms-card-section {
  border-block-start: 1px solid var(--ms-line);
  padding-block-start: var(--ms-space-2);
}

[data-studio-model-settings] .ms-card-heading {
  margin: 0 0 var(--ms-space-1);
  font-size: 13px;
  font-weight: 600;
}

[data-studio-model-settings] .ms-card-facts {
  margin: 0;
}

[data-studio-model-settings] .ms-card-row {
  display: flex;
  justify-content: space-between;
  gap: var(--ms-space-3);
  padding: 6px 0;
  border-block-end: 1px solid var(--ms-line);
  font-size: 12px;
}

[data-studio-model-settings] .ms-card-row:last-child {
  border-block-end: 0;
}

[data-studio-model-settings] .ms-card-value {
  margin: 0;
  color: var(--ms-ink-2);
  text-align: end;
  font-variant-numeric: tabular-nums;
}

[data-studio-model-settings] .ms-card-radar {
  display: block;
  inline-size: min(100%, 340px);
  margin: 0 auto;
}

[data-studio-model-settings] .ms-card-radar-grid {
  fill: none;
  stroke: var(--ms-line);
}

[data-studio-model-settings] .ms-card-radar-shape {
  fill: color-mix(in srgb, var(--ms-accent) 22%, transparent);
  stroke: var(--ms-accent);
  stroke-width: 1.5;
}

[data-studio-model-settings] .ms-card-radar-dot {
  fill: var(--ms-accent);
}

[data-studio-model-settings] .ms-card-radar-label {
  fill: var(--ms-ink-2);
  font-size: 10.5px;
}

[data-studio-model-settings] .ms-card-radar-value {
  fill: var(--ms-ink);
  font-weight: 600;
}
`;
