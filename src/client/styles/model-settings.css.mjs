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

  --ms-radius-sm: 8px;
  --ms-radius-md: 10px;
  --ms-radius-lg: 16px;

  --ms-h-sm: 30px;
  --ms-h: 34px;

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

[data-studio-model-settings] .ms-form {
  display: grid;
  gap: var(--ms-space-3);
  width: 100%;
  max-width: 1040px;
  margin-inline: auto;
}

[data-studio-model-settings] .ms-form-content {
  display: grid;
  gap: var(--ms-space-3);
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

[data-studio-model-settings] .ms-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-3);
  flex-wrap: wrap;
  margin-bottom: var(--ms-space-3);
}

[data-studio-model-settings] .ms-intro h3 {
  margin: 0;
  color: var(--ms-ink);
  font-size: 17px;
  font-weight: 600;
  line-height: 24px;
  letter-spacing: -.01em;
  overflow-wrap: anywhere;
}

[data-studio-model-settings] .ms-intro p {
  margin: 2px 0 0;
  color: var(--ms-ink-2);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

[data-studio-model-settings] .ms-panel {
  border: 1px solid var(--ms-line);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-surface);
  box-shadow: var(--ms-shadow-1);
  overflow: hidden;
}

[data-studio-model-settings] :is(.ms-directory-toolbar, .ms-import-toolbar) {
  display: grid;
  gap: var(--ms-space-2);
  padding: 10px 12px;
  border-bottom: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-search {
  position: relative;
  display: block;
  min-width: 0;
  color: var(--ms-ink-2);
}

[data-studio-model-settings] .ms-search::before,
[data-studio-model-settings] .ms-search::after {
  position: absolute;
  z-index: 1;
  inset-inline-start: 10px;
  content: "";
  pointer-events: none;
}

[data-studio-model-settings] .ms-search::before {
  top: 10px;
  box-sizing: border-box;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
}

[data-studio-model-settings] .ms-search::after {
  top: 20px;
  inset-inline-start: 18px;
  width: 5px;
  height: 1.5px;
  border-radius: 1px;
  background: currentColor;
  transform: rotate(45deg);
}

[data-studio-model-settings] .ms-search .ms-input {
  padding-inline-start: 31px;
  border-color: transparent;
  background: var(--ms-fill);
}

[data-studio-model-settings] :is(.ms-group-list, .ms-catalog-list) {
  max-block-size: min(51vh, 480px);
  overflow-y: auto;
  overscroll-behavior-block: contain;
  scrollbar-width: thin;
}

[data-studio-model-settings] .ms-provider-row + .ms-provider-row {
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] :is(.ms-provider-row, .ms-model-row, .ms-back) {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

[data-studio-model-settings] .ms-provider-row {
  min-height: 56px;
  padding: 8px 14px;
}

[data-studio-model-settings] :is(.ms-provider-row, .ms-model-row, .ms-back):hover,
[data-studio-model-settings] .ms-catalog-row:not([data-configured="true"]):hover {
  background: var(--ms-fill-hover);
}

[data-studio-model-settings] :is(.ms-provider-row, .ms-model-row, .ms-back):focus-visible {
  outline: 2px solid var(--ms-accent);
  outline-offset: -2px;
}

[data-studio-model-settings] .ms-chevron {
  box-sizing: border-box;
  flex: none;
  width: 6px;
  height: 6px;
  margin-inline: 2px 3px;
  border-right: 1.4px solid currentColor;
  border-top: 1.4px solid currentColor;
  color: var(--ms-ink-2);
  transform: rotate(45deg);
}

[data-studio-model-settings] .ms-connection-text {
  flex: 1;
  min-width: 0;
}

[data-studio-model-settings] .ms-connection-name {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--ms-space-1);
  color: var(--ms-ink);
  font-weight: 600;
  line-height: 18px;
}

[data-studio-model-settings] :is(.ms-connection-address, .ms-connection-count, .ms-connection-warning, .ms-row-status) {
  color: var(--ms-ink-2);
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
}

[data-studio-model-settings] .ms-connection-address {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-studio-model-settings] :is(.ms-connection-count, .ms-connection-warning, .ms-row-status) {
  flex-shrink: 0;
  white-space: nowrap;
}

[data-studio-model-settings] :is(.ms-connection-warning, .ms-row-status[data-tone="draft"]) {
  color: var(--ms-warn);
}

[data-studio-model-settings] :is(.ms-model-list, .ms-catalog-list) {
  margin: 0;
  padding: 0;
  list-style: none;
}

[data-studio-model-settings] .ms-model-row {
  min-height: 36px;
  padding: 4px 14px;
}

[data-studio-model-settings] .ms-provider-model-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  padding: 10px 14px;
  border-bottom: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-provider-model-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

[data-studio-model-settings] .ms-provider-model-head button { margin-inline-start: auto; }

[data-studio-model-settings] .ms-remove-confirm {
  margin-bottom: var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-line);
  border-radius: var(--ms-radius-md);
  background: var(--ms-fill);
}

[data-studio-model-settings] .ms-remove-confirm p {
  margin: 4px 0 var(--ms-space-2);
  color: var(--ms-ink-2);
  font-size: 12px;
}

[data-studio-model-settings] .ms-manual-entry {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--ms-space-2);
}

[data-studio-model-settings] .ms-model-list li + li,
[data-studio-model-settings] .ms-catalog-list li + li {
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-studio-model-settings] .ms-back {
  width: fit-content;
  min-height: 30px;
  padding: 0 8px;
  margin: 0 0 var(--ms-space-2) -8px;
  border-radius: var(--ms-radius-sm);
  color: var(--ms-ink-2);
  font-size: 12px;
}

[data-studio-model-settings] .ms-back .ms-chevron {
  transform: rotate(-135deg);
}

[data-studio-model-settings] :is(.ms-catalog-row, .ms-catalog-message) {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
}

[data-studio-model-settings] .ms-provider-catalog {
  margin-top: var(--ms-space-3);
}

[data-studio-model-settings] .ms-provider-catalog .ms-catalog-list {
  max-block-size: min(31vh, 238px);
}

[data-studio-model-settings] .ms-catalog-meta {
  max-width: 49%;
  white-space: normal;
  text-align: end;
}

[data-studio-model-settings] .ms-effort-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

[data-studio-model-settings] .ms-effort-report {
  margin: 0;
  overflow-wrap: anywhere;
}

[data-studio-model-settings] .ms-catalog-list .ms-effort-report {
  padding: 0 14px 8px 40px;
}

[data-studio-model-settings] .ms-catalog-row {
  min-height: 38px;
  padding: 4px 14px;
  box-sizing: border-box;
  cursor: pointer;
}

[data-studio-model-settings] .ms-catalog-row[data-configured="true"] {
  color: var(--ms-ink-2);
  cursor: default;
}

[data-studio-model-settings] .ms-catalog-row:has(input:checked:not(:disabled)) {
  background: var(--ms-accent-soft);
}

[data-studio-model-settings] .ms-catalog-row input {
  width: 14px;
  height: 14px;
  margin: 0 4px 0 0;
  flex: none;
  accent-color: var(--ms-accent);
}

[data-studio-model-settings] :is(.ms-empty, .ms-catalog-message) {
  margin: 0;
  padding: var(--ms-space-4);
  color: var(--ms-ink-2);
}

[data-studio-model-settings] .ms-catalog-message {
  flex-wrap: wrap;
}

/* Editor */
[data-studio-model-settings] .ms-detail {
  display: grid;
  gap: var(--ms-space-3);
  align-content: start;
  min-width: 0;
  padding: var(--ms-space-4);
}

[data-studio-model-settings] .ms-editor-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ms-space-2);
  padding-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-editor-section-head h5 {
  margin: 0;
  font: inherit;
  font-weight: 600;
}

[data-studio-model-settings] .ms-detail-head {
  display: flex;
  align-items: center;
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

[data-studio-model-settings] .ms-advanced-group {
  display: grid;
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-grid {
  display: grid;
  gap: var(--ms-space-3);
  min-width: 0;
}

[data-studio-model-settings] .ms-grid-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

[data-studio-model-settings] .ms-grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

[data-studio-model-settings] .ms-model-fields { row-gap: var(--ms-space-2); }

/* Fields */
[data-studio-model-settings] .ms-field-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--ms-space-1);
}
[data-studio-model-settings] .ms-field {
  display: grid;
  gap: var(--ms-space-1);
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
  color: var(--ms-ink-3);
}

[data-studio-model-settings] .ms-static {
  box-sizing: border-box;
  height: var(--ms-h);
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--ms-line);
  border-radius: var(--ms-radius-md);
  background: var(--ms-fill);
  color: var(--ms-ink-2);
  font-size: 12px;
  line-height: calc(var(--ms-h) - 2px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

[data-studio-model-settings] .ms-capability {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  flex-wrap: wrap;
  min-height: 20px;
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
}

[data-studio-model-settings] .ms-advanced > summary,
[data-studio-model-settings] details > .ms-cloud-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ms-ink-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  min-height: 30px;
  list-style: none;
  cursor: pointer;
}

[data-studio-model-settings] .ms-advanced > summary::-webkit-details-marker,
[data-studio-model-settings] .ms-cloud-title::-webkit-details-marker {
  display: none;
}

[data-studio-model-settings] .ms-advanced > summary::before,
[data-studio-model-settings] details > .ms-cloud-title::before {
  content: "";
  width: 6px;
  height: 6px;
  flex: none;
  margin-inline: 2px 3px;
  border-right: 1.4px solid currentColor;
  border-bottom: 1.4px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 120ms ease;
}

[data-studio-model-settings] :is(.ms-advanced[open] > summary, .ms-cloud[open] > summary)::before {
  transform: rotate(45deg);
}

[data-studio-model-settings] :is(.ms-advanced > summary, .ms-cloud-title):focus-visible {
  outline: 2px solid var(--ms-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

[data-studio-model-settings] .ms-advanced[open] > summary {
  margin-bottom: var(--ms-space-3);
}

[data-studio-model-settings] .ms-advanced + .ms-advanced {
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings] .ms-advanced > .ms-hint {
  margin: var(--ms-space-2) 0;
}

/*
 * Custom request headers: one row per header, name and value on one line with
 * its own remove action. Rows are the editing shape of the profile header
 * record; the hint explains that empty rows never reach the configuration file.
 */
[data-studio-model-settings] .ms-headers {
  display: grid;
  gap: var(--ms-space-2);
  min-width: 0;
  margin-top: var(--ms-space-3);
}

[data-studio-model-settings] .ms-headers-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
}

[data-studio-model-settings] .ms-header-row {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.4fr) auto;
  align-items: center;
  gap: var(--ms-space-2);
  min-width: 0;
}

[data-studio-model-settings] .ms-header-row > .ms-btn {
  white-space: nowrap;
}

[data-studio-model-settings] .ms-cloud {
  min-width: 0;
  padding: 0 var(--ms-space-3);
  border: 1px solid var(--ms-line);
  border-radius: var(--ms-radius-md);
  background: var(--ms-surface);
}

[data-studio-model-settings] .ms-cloud-title {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  min-height: 36px;
  color: var(--ms-ink);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}

[data-studio-model-settings] details > .ms-cloud-title {
  min-height: 38px;
  color: var(--ms-ink);
  font-size: 13px;
}

[data-studio-model-settings] .ms-cloud-body {
  display: grid;
  gap: var(--ms-space-2);
  padding: var(--ms-space-2) 0 var(--ms-space-3);
  border-top: 1px solid var(--ms-line);
}

/* Footer */
[data-studio-model-settings] .ms-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
  padding: var(--ms-space-2) 0 var(--ms-space-1);
  border-top: 1px solid var(--ms-line);
}

[data-studio-model-settings][data-onboarding-mode="all"] .ms-footer {
  position: sticky;
  bottom: 0;
  z-index: 1;
  background: var(--ms-surface);
}

[data-studio-model-settings][data-onboarding-mode="all"] :is(input, select, summary, .ms-advanced button) {
  scroll-margin-block-end: 56px;
}

[data-studio-model-settings] .ms-footer-actions {
  display: flex;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
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

[data-studio-model-settings] .ms-footer-note[data-tone="count"] {
  color: var(--ms-ink-2);
}

[data-studio-model-settings] .ms-alert {
  margin: 0;
  color: var(--ms-danger);
  font-size: 12px;
  line-height: 18px;
}

@container ms (max-width: 395px) {
  [data-studio-model-settings] .ms-grid-2,
  [data-studio-model-settings] .ms-grid-3 {
    grid-template-columns: minmax(0, 1fr);
  }

  [data-studio-model-settings] .ms-header-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  [data-studio-model-settings] .ms-header-row > .ms-input:first-child {
    grid-column: 1 / -1;
  }

  [data-studio-model-settings] .ms-detail { padding: var(--ms-space-3); }
}

/* Wire probe: a button plus its verdict, on one line that wraps on narrow
   hosts instead of overflowing the settings grid. */
[data-studio-model-settings] .ms-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

@media (prefers-reduced-motion: reduce) {
  [data-studio-model-settings] .ms-advanced > summary::before {
    transition: none;
  }
}
`;
