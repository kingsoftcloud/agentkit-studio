export default String.raw`
/*
 * Model & credential settings surface.
 *
 * Tokens are scoped to the section so every distance, radius, hairline and
 * control height comes from one scale. Consumers: pages/model-settings.mjs.
 * Values resolve through DSH aliases first so the sheet follows the active
 * theme instead of hard-coding a palette.
 */
[data-studio-model-settings] {
  --ms-space-1: 4px;
  --ms-space-2: 8px;
  --ms-space-3: 12px;
  --ms-space-4: 16px;
  --ms-space-5: 20px;
  --ms-space-6: 24px;
  --ms-space-8: 32px;

  --ms-radius-sm: 8px;
  --ms-radius-md: 10px;
  --ms-radius-lg: 16px;

  --ms-h-sm: 32px;
  --ms-h: 36px;
  --ms-h-lg: 40px;

  --ms-ink: var(--dsw-alias-label-primary, #0f1115);
  --ms-ink-2: var(--dsw-alias-label-secondary, #61666b);
  --ms-ink-3: var(--dsw-alias-label-tertiary, #81858c);
  --ms-line: var(--dsw-alias-border-l2, #0000001a);
  --ms-line-strong: var(--dsw-alias-border-l3, #0000001f);
  --ms-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --ms-fill: light-dark(#26314808, #ffffff08);
  --ms-fill-hover: light-dark(#2631480f, #ffffff12);
  --ms-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --ms-accent-ink: light-dark(#2f5ccc, #9dbcf5);
  --ms-accent-soft: light-dark(#e9f0fd, #16233a);
  --ms-success: light-dark(#157f4a, #5fd08a);
  --ms-success-soft: light-dark(#e8f8ee, #10281a);
  --ms-warn: light-dark(#946200, #f0c169);
  --ms-warn-soft: light-dark(#fdf3e2, #2b2111);
  --ms-danger: light-dark(#b42318, #ff8f86);
  --ms-shadow-1: 0 1px 2px light-dark(rgba(15, 17, 21, .04), rgba(0, 0, 0, .32));
  --ms-focus-ring: 0 0 0 3px light-dark(rgba(65, 118, 230, .18), rgba(122, 165, 255, .26));

  container: ms / inline-size;
  min-width: 0;
  color: var(--ms-ink);
  font-size: 13px;
  line-height: 20px;
  letter-spacing: 0;
}

/*
 * Frame: one hairline-bordered panel owns the whole surface. The list and the
 * editor are two regions of that panel, so no card sits inside another card.
 */
[data-studio-model-settings] .ms-form {
  display: grid;
  gap: var(--ms-space-5);
  width: 100%;
  max-width: 1040px;
  margin: 0;
}

[data-studio-model-settings] .ms-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ms-space-4);
  flex-wrap: wrap;
}

[data-studio-model-settings] .ms-intro h3 {
  margin: 0;
  color: var(--ms-ink);
  font-size: 17px;
  font-weight: 600;
  line-height: 24px;
  letter-spacing: -.01em;
}

[data-studio-model-settings] .ms-intro p {
  max-width: 62ch;
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-ink-3);
  font-size: 12px;
  line-height: 18px;
}

/* Running default: a status strip, not a card. Detail lives in the list. */
[data-studio-model-settings] .ms-status {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
  min-height: var(--ms-h);
  padding: var(--ms-space-2) var(--ms-space-3);
  border-radius: var(--ms-radius-md);
  background: var(--ms-fill);
}

[data-studio-model-settings] .ms-status-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ms-success);
}

[data-studio-model-settings] .ms-status-label {
  color: var(--ms-ink-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
}

[data-studio-model-settings] .ms-status-model {
  min-width: 0;
  color: var(--ms-ink);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

[data-studio-model-settings] .ms-status-meta {
  margin-left: auto;
  color: var(--ms-ink-3);
  font-size: 12px;
  white-space: nowrap;
}

[data-studio-model-settings] .ms-panel {
  display: grid;
  grid-template-columns: 252px minmax(0, 1fr);
  border: 1px solid var(--ms-line);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-surface);
  box-shadow: var(--ms-shadow-1);
  overflow: hidden;
}

[data-studio-model-settings] .ms-panel[data-rail="false"] {
  grid-template-columns: minmax(0, 1fr);
}

/* List rail */
[data-studio-model-settings] .ms-rail {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  min-width: 0;
  padding: var(--ms-space-3) var(--ms-space-2);
  border-right: 1px solid var(--ms-line);
  background: var(--ms-fill);
}

[data-studio-model-settings] .ms-rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
  padding: 0 var(--ms-space-2) var(--ms-space-1);
  color: var(--ms-ink-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
}

[data-studio-model-settings] .ms-rail-count {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}

[data-studio-model-settings] .ms-rail-items {
  display: grid;
  gap: 2px;
  min-width: 0;
}

[data-studio-model-settings] .ms-rail-item {
  display: grid;
  gap: 1px;
  width: 100%;
  min-width: 0;
  padding: var(--ms-space-2) var(--ms-space-2);
  border: 1px solid transparent;
  border-radius: var(--ms-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

[data-studio-model-settings] .ms-rail-item:hover {
  background: var(--ms-fill-hover);
}

[data-studio-model-settings] .ms-rail-item[data-selected="true"] {
  border-color: var(--ms-line);
  background: var(--ms-surface);
  box-shadow: var(--ms-shadow-1);
}

[data-studio-model-settings] .ms-rail-item:focus-visible {
  outline: 2px solid var(--ms-accent);
  outline-offset: 1px;
}

[data-studio-model-settings] .ms-rail-name-row {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  min-width: 0;
}

[data-studio-model-settings] .ms-rail-name {
  overflow: hidden;
  flex: 1 1 auto;
  color: var(--ms-ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-studio-model-settings] .ms-rail-item[data-selected="true"] .ms-rail-name {
  font-weight: 600;
}

[data-studio-model-settings] .ms-rail-foot {
  margin: var(--ms-space-2) 0 0;
  padding: 0 var(--ms-space-2);
  margin-top: auto;
  color: var(--ms-ink-3);
  font-size: 11px;
  line-height: 16px;
}

[data-studio-model-settings] .ms-rail-sub {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  overflow: hidden;
  color: var(--ms-ink-3);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

[data-studio-model-settings] .ms-rail-sub > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Editor */
[data-studio-model-settings] .ms-detail {
  display: grid;
  gap: var(--ms-space-4);
  align-content: start;
  min-width: 0;
  padding: var(--ms-space-5) var(--ms-space-6) var(--ms-space-6);
}

[data-studio-model-settings] .ms-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ms-space-3);
  flex-wrap: wrap;
}

[data-studio-model-settings] .ms-detail-title {
  min-width: 0;
}

[data-studio-model-settings] .ms-detail-name {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

[data-studio-model-settings] .ms-detail-name h4 {
  min-width: 0;
  margin: 0;
  color: var(--ms-ink);
  font-size: 15px;
  font-weight: 600;
  line-height: 22px;
  letter-spacing: -.01em;
  overflow-wrap: anywhere;
}

[data-studio-model-settings] .ms-detail-name-text {
  font-weight: inherit;
}

[data-studio-model-settings] .ms-detail-meta {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-ink-3);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

[data-studio-model-settings] .ms-detail-actions {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  flex-wrap: wrap;
}

/* Sections */
[data-studio-model-settings] .ms-section {
  display: grid;
  gap: var(--ms-space-3);
  min-width: 0;
  padding-top: var(--ms-space-4);
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-section-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  min-height: 20px;
}

[data-studio-model-settings] .ms-step {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 6px;
  background: var(--ms-fill);
  color: var(--ms-ink-3);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

[data-studio-model-settings] .ms-section-title {
  margin: 0;
  color: var(--ms-ink);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}

[data-studio-model-settings] .ms-section-extra {
  margin-left: auto;
  color: var(--ms-ink-3);
  font-size: 12px;
}

[data-studio-model-settings] .ms-grid {
  display: grid;
  gap: var(--ms-space-3);
  min-width: 0;
}

[data-studio-model-settings] .ms-grid-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

/* Fields */
[data-studio-model-settings] .ms-field {
  display: grid;
  gap: 6px;
  align-content: start;
  min-width: 0;
}

[data-studio-model-settings] .ms-label {
  color: var(--ms-ink-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}

[data-studio-model-settings] .ms-input,
[data-studio-model-settings] .ms-select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: var(--ms-h);
  padding: 0 10px;
  border: 1px solid var(--ms-line-strong);
  border-radius: var(--ms-radius-md);
  background: var(--ms-surface);
  color: var(--ms-ink);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
}

[data-studio-model-settings] .ms-select {
  padding-right: 30px;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%2381858c' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  cursor: pointer;
}

[data-studio-model-settings] .ms-input:hover:not(:disabled),
[data-studio-model-settings] .ms-select:hover:not(:disabled) {
  border-color: var(--ms-ink-3);
}

[data-studio-model-settings] .ms-input:focus,
[data-studio-model-settings] .ms-select:focus {
  outline: none;
  border-color: var(--ms-accent);
  box-shadow: var(--ms-focus-ring);
}

[data-studio-model-settings] .ms-input:disabled,
[data-studio-model-settings] .ms-select:disabled {
  background: var(--ms-fill);
  color: var(--ms-ink-3);
  cursor: not-allowed;
}

[data-studio-model-settings] .ms-input::placeholder {
  color: var(--dsw-alias-label-dimmed, #a9adb5);
}

[data-studio-model-settings] .ms-static {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
  box-sizing: border-box;
  min-height: var(--ms-h);
  padding: 0 10px;
  border: 1px dashed var(--ms-line-strong);
  border-radius: var(--ms-radius-md);
  background: var(--ms-fill);
  color: var(--ms-ink-2);
  font-size: 12px;
  line-height: 16px;
}

[data-studio-model-settings] .ms-static > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-studio-model-settings] .ms-static .ms-chip {
  flex: 0 0 auto;
}

[data-studio-model-settings] .ms-hint {
  margin: 0;
  color: var(--ms-ink-3);
  font-size: 12px;
  line-height: 18px;
}

[data-studio-model-settings] .ms-actions {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

[data-studio-model-settings] .ms-meta {
  margin-left: auto;
  color: var(--ms-ink-3);
  font-size: 11px;
  line-height: 16px;
}

[data-studio-model-settings] .ms-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--ms-ink-2);
  font-size: 12px;
  line-height: 18px;
}

[data-studio-model-settings] .ms-note::before {
  content: "";
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ms-success);
}

[data-studio-model-settings] .ms-note[data-tone="warn"]::before {
  background: var(--ms-warn);
}

[data-studio-model-settings] .ms-note[data-tone="danger"] {
  color: var(--ms-danger);
}

[data-studio-model-settings] .ms-note[data-tone="danger"]::before {
  background: var(--ms-danger);
}

/* Chips: the only status surface on this page. */
[data-studio-model-settings] .ms-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 var(--ms-space-2);
  border-radius: 999px;
  background: var(--ms-fill);
  color: var(--ms-ink-2);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

[data-studio-model-settings] .ms-chip[data-size="xs"] {
  height: 16px;
  padding: 0 6px;
  font-size: 10px;
}

[data-studio-model-settings] .ms-chip[data-tone="accent"] {
  background: var(--ms-accent-soft);
  color: var(--ms-accent-ink);
}

[data-studio-model-settings] .ms-chip[data-tone="success"] {
  background: var(--ms-success-soft);
  color: var(--ms-success);
}

[data-studio-model-settings] .ms-chip[data-tone="warn"] {
  background: var(--ms-warn-soft);
  color: var(--ms-warn);
}

[data-studio-model-settings] .ms-chip[data-tone="danger"] {
  color: var(--ms-danger);
}

/*
 * 方案 C draft marker: the same chip without a leading dot would read as another
 * status; the dot makes “this is unsaved memory state” scannable at a glance.
 */
[data-studio-model-settings] .ms-chip[data-unsaved="true"]::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

[data-studio-model-settings] .ms-rail-draft {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border: 1.5px solid var(--ms-accent);
  border-radius: 50%;
  background: transparent;
}

[data-studio-model-settings] .ms-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ms-ink-3);
}

[data-studio-model-settings] .ms-dot[data-tone="success"] {
  background: var(--ms-success);
}

[data-studio-model-settings] .ms-dot[data-tone="warn"] {
  background: var(--ms-warn);
}

[data-studio-model-settings] .ms-dot[data-tone="danger"] {
  background: var(--ms-danger);
}

/* Capability row: metadata, never another banded box. */
[data-studio-model-settings] .ms-capability {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  flex-wrap: wrap;
  min-height: 20px;
}

[data-studio-model-settings] .ms-capability-label {
  margin-right: var(--ms-space-1);
  color: var(--ms-ink-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
}

[data-studio-model-settings] .ms-capability .ms-hint {
  margin-left: var(--ms-space-1);
}

/* Buttons */
[data-studio-model-settings] .ms-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ms-space-1);
  box-sizing: border-box;
  height: var(--ms-h);
  padding: 0 var(--ms-space-3);
  border: 1px solid var(--ms-line-strong);
  border-radius: var(--ms-radius-md);
  background: var(--ms-surface);
  color: var(--ms-ink);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}

[data-studio-model-settings] .ms-btn:hover:not(:disabled) {
  background: var(--ms-fill-hover);
  border-color: var(--ms-ink-3);
}

[data-studio-model-settings] .ms-btn:focus-visible {
  outline: 2px solid var(--ms-accent);
  outline-offset: 2px;
}

[data-studio-model-settings] .ms-btn:disabled {
  opacity: .45;
  cursor: not-allowed;
}

[data-studio-model-settings] .ms-btn[data-size="sm"] {
  height: var(--ms-h-sm);
  padding: 0 10px;
  border-radius: var(--ms-radius-sm);
  font-size: 12px;
}

[data-studio-model-settings] .ms-btn[data-variant="primary"] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #0f1115);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
  font-weight: 500;
}

[data-studio-model-settings] .ms-btn[data-variant="primary"]:hover:not(:disabled) {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-hover, #43454a);
}

/*
 * 方案 C: while memory drafts exist the primary save is the one action that
 * resolves them, so it gains an accent ring instead of a new colour or a modal.
 */
[data-studio-model-settings] .ms-btn[data-variant="primary"][data-dirty="true"] {
  border-color: var(--ms-accent);
  box-shadow: var(--ms-focus-ring);
}

[data-studio-model-settings] .ms-btn[data-variant="danger"] {
  color: var(--ms-danger);
}

[data-studio-model-settings] .ms-btn[data-size="lg"] {
  height: var(--ms-h-lg);
  padding: 0 var(--ms-space-4);
}

[data-studio-model-settings] .ms-link {
  color: var(--ms-accent-ink);
  font-size: 12px;
  text-decoration: none;
}

[data-studio-model-settings] .ms-link:hover {
  text-decoration: underline;
}

[data-studio-model-settings] .ms-link:focus-visible {
  outline: 2px solid var(--ms-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* Advanced disclosure */
[data-studio-model-settings] .ms-advanced {
  min-width: 0;
  padding-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-advanced > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ms-ink-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  list-style: none;
  cursor: pointer;
}

[data-studio-model-settings] .ms-advanced > summary::-webkit-details-marker {
  display: none;
}

[data-studio-model-settings] .ms-advanced > summary::before {
  content: "";
  width: 6px;
  height: 6px;
  border-right: 1.4px solid currentColor;
  border-bottom: 1.4px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

[data-studio-model-settings] .ms-advanced[open] > summary::before {
  transform: rotate(45deg);
}

[data-studio-model-settings] .ms-advanced > summary:focus-visible {
  outline: 2px solid var(--ms-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

[data-studio-model-settings] .ms-advanced[open] > summary {
  margin-bottom: var(--ms-space-3);
}

/* Cloud credentials sit below the model panel on a quieter layer. */
[data-studio-model-settings] .ms-cloud {
  display: grid;
  gap: var(--ms-space-3);
  min-width: 0;
  padding-top: var(--ms-space-5);
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-cloud[data-solo="true"] {
  padding-top: 0;
  border-top: 0;
}

[data-studio-model-settings] .ms-cloud-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ms-space-3);
  flex-wrap: wrap;
}

[data-studio-model-settings] .ms-cloud-title {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

[data-studio-model-settings] .ms-cloud-head h4 {
  margin: 0;
  color: var(--ms-ink);
  font-size: 14px;
  font-weight: 600;
  line-height: 20px;
}

[data-studio-model-settings] .ms-cloud-head p {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-ink-3);
  font-size: 12px;
  line-height: 18px;
}

/* Footer */
[data-studio-model-settings] .ms-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
  padding-top: var(--ms-space-4);
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-footer-notes {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
  min-width: 0;
  margin-right: auto;
}

[data-studio-model-settings] .ms-footer-note {
  color: var(--ms-success);
  font-size: 12px;
  line-height: 18px;
}

[data-studio-model-settings] .ms-footer-note[data-tone="danger"] {
  color: var(--ms-danger);
}

[data-studio-model-settings] .ms-footer-note[data-tone="draft"] {
  color: var(--ms-warn);
}

[data-studio-model-settings] .ms-alert {
  margin: 0;
  color: var(--ms-danger);
  font-size: 12px;
  line-height: 18px;
}

/*
 * Narrow containers: the rail becomes a horizontal switcher above the editor,
 * the two-column form grids collapse, and the running-default strip wraps.
 */
@container ms (max-width: 760px) {
  [data-studio-model-settings] .ms-panel {
    grid-template-columns: minmax(0, 1fr);
  }

  [data-studio-model-settings] .ms-rail {
    padding: var(--ms-space-2);
    border-right: 0;
    border-bottom: 1px solid var(--ms-line);
  }

  [data-studio-model-settings] .ms-rail-items {
    display: flex;
    gap: var(--ms-space-1);
    overflow-x: auto;
    padding-bottom: 2px;
  }

  [data-studio-model-settings] .ms-rail-item {
    flex: 0 0 auto;
    width: 232px;
  }

  [data-studio-model-settings] .ms-detail {
    padding: var(--ms-space-4);
  }

  [data-studio-model-settings] .ms-grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }

  [data-studio-model-settings] .ms-status-meta {
    width: 100%;
    margin-left: 0;
  }
}

@container ms (max-width: 520px) {
  [data-studio-model-settings] .ms-intro h3 {
    font-size: 16px;
  }

  [data-studio-model-settings] .ms-detail-head {
    flex-direction: column;
  }

  [data-studio-model-settings] .ms-meta {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-studio-model-settings] .ms-advanced > summary::before {
    transition: none;
  }
}
`;
