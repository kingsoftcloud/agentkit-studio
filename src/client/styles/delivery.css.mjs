export default String.raw`
/* Build & deployment surfaces: layout classes that delivery.mjs needs on top of
   the shared af-* form primitives. Every color is a DSH alias token so the page
   follows the host theme instead of Studio's own brand values. */
[data-studio-delivery] { container-type: inline-size; container-name: studio-delivery; max-width: 960px; margin: 0 auto; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; min-width: 0; }
[data-studio-delivery] [data-studio-heading] { margin-bottom: 20px; align-items: center; }
[data-studio-delivery] .af-section { padding: 0; margin-bottom: 24px; border: 0; }
[data-studio-delivery] .af-section-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
[data-studio-delivery] .af-section-head { margin-bottom: 8px; }
.ad-subject { margin-bottom: 28px; }
[data-studio-delivery] .ad-agent-picker { width: 180px; max-width: 100%; height: 32px; text-overflow: ellipsis; }
[data-delivery-step] > .af-section-head .af-section-title { display: inline-flex; align-items: center; gap: 10px; color: var(--dsw-alias-label-primary); font-size: 14px; }
.ad-step-number { display: inline-grid; place-items: center; box-sizing: border-box; width: 22px; height: 22px; border: .5px solid var(--dsw-alias-border-l3); border-radius: 50%; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; }
.ad-step-number[data-current] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); border-color: transparent; }
.ad-step-number[data-done] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-border-l3); }
.ad-step-dimmed > .ad-panel > :is(.studio-srow,.studio-cfoot) { opacity: .55; }
[data-studio-delivery] .af-note { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ad-panel { padding: 0 16px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xl,16px); }
.ad-panel > .af-row { box-sizing: border-box; min-height: 56px; padding: 12px 0; }
.ad-panel > .af-row:last-child { border-bottom: 0; }
[data-studio-delivery] .af-row-title { font-size: 14px; line-height: 22px; }
[data-studio-delivery] .af-row-desc { font-size: 12px; line-height: 18px; }
[data-studio-delivery] .af-row-control { min-width: 0; max-width: min(55%,360px); }
[data-studio-delivery] .af-row-control :is(.af-select,.af-input) { height: 32px; max-width: 360px; min-width: 0; width: 100%; text-overflow: ellipsis; }
[data-studio-delivery] .af-btn { height: 32px; padding: 0 12px; border-radius: 12px; font-size: 13px; }
[data-studio-delivery] .af-btn[data-size="sm"] { height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px; }
[data-studio-delivery] .af-btn.ad-build-primary[data-variant="primary"]:disabled { background: var(--dsw-alias-button-primary-fill,#0b0b0d) !important; color: var(--dsw-alias-label-primary-foreground,#fff) !important; }
[data-studio-delivery] .af-btn[data-variant="ghost"] { border-color: transparent; background: transparent; }
[data-studio-delivery] .studio-cfoot { justify-content: flex-end; margin: 0 -16px; padding: 12px 16px; }
.ad-panel > :is(.af-details,.ad-actions,.af-note) { margin-block: 12px; }
[data-studio-delivery] :is(.af-input,.af-select,.af-btn,.af-switch):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }

/* static, non-editable values (fixed storage, runtime of the selected agent) */
.ad-value { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: right; }
.ad-value-sub { display: block; margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ad-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
.ad-rollback-picker { width: 260px; max-width: 100%; margin: 8px; }
.ad-head-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

/* build history */
.ad-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ad-table th { padding: 8px 12px; text-align: left; font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-tertiary); border-bottom: .5px solid var(--dsw-alias-border-l2); background: transparent; }
.ad-table th:first-child { border-top-left-radius: var(--dsw-radius-sm,8px); }
.ad-table th:last-child { border-top-right-radius: var(--dsw-radius-sm,8px); }
.ad-table td { padding: 9px 12px; border-bottom: .5px solid var(--dsw-alias-border-l2); vertical-align: middle; }
.ad-table tr:last-child td { border-bottom: 0; }
.ad-table tr[data-selected="true"] td { background: var(--dsw-alias-interactive-bg-hover); }
.ad-table-cell-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ad-table-scroll { overflow-x: auto; }
.ad-records-table { width: 100%; min-width: 640px; }
.ad-local-records { width: 100%; }
.ad-records-table td { vertical-align: middle; }
.ad-records-table .ad-record-actions { flex-wrap: nowrap; margin: 0; }
.ad-records-table .ad-record-title { font-size: 13px; }
.ad-records-table .ad-record-meta { display: block; max-width: 260px; }
.ad-record-scope > .studio-tabs { flex-wrap: wrap; gap: 4px; padding: 0; margin-bottom: 16px; background: transparent; }
.ad-record-scope > .studio-tabs > button { height: 28px; padding: 0 10px; border-radius: 8px; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.ad-record-scope > .studio-tabs > button[aria-selected="true"] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-module-platform); box-shadow: none; }
.ad-radio { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; cursor: pointer; }

/* checked deployment plan */
.ad-preview { margin: 0 0 24px; padding: 16px 16px 0; border: .5px solid var(--dsw-alias-border-l2); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); }
.ad-preview .af-summary { margin-bottom: 16px; }
.ad-checks { display: flex; flex-wrap: wrap; gap: 12px 24px; padding: 0; margin: 16px 0; list-style: none; font-size: 13px; }
.ad-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; font-size: 14px; font-weight: 500; }
.ad-warnings { margin: 10px 0 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ad-warnings > li + li { margin-top: 2px; }
.ad-warnings > li { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* deployment records */
.ad-list { border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md,12px); overflow: hidden; }
.ad-record { padding: 14px 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
.ad-record:first-child { border-top: 0; }
.ad-record-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ad-record-title { font-size: 14px; font-weight: 500; line-height: 22px; }
.ad-record-meta { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.ad-record-failure { color: var(--dsw-alias-state-error-primary,#b42318); }
.ad-record-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.ad-detail { display: grid; grid-template-columns: max-content minmax(0,1fr); gap: 8px 20px; margin: 12px 0 0; padding: 12px 14px; border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2)); font-size: 12px; line-height: 18px; }
.ad-detail dt { color: var(--dsw-alias-label-tertiary); }
.ad-detail dd { margin: 0; overflow-wrap: anywhere; }
.ad-log { margin: 12px 0 0; padding: 12px 14px; max-height: 280px; overflow: auto; border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2)); white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; }
.ad-pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-top: .5px solid var(--dsw-alias-border-l2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ad-pager-actions { display: flex; align-items: center; gap: 8px; }

@container studio-delivery (max-width: 820px) {
  [data-studio-delivery] .af-row { flex-wrap: wrap; gap: 6px; }
  [data-studio-delivery] .af-row-control { width: 100%; max-width: 100%; justify-content: flex-start; }
  [data-studio-delivery] .af-row-control .af-select,
  [data-studio-delivery] .af-row-control .af-input { width: 100%; min-width: 0; }
  [data-studio-delivery] .af-value { text-align: left; }
  [data-studio-delivery] .af-section-head { flex-wrap: wrap; }
  [data-studio-delivery] .ad-actions { justify-content: flex-start; }
  [data-studio-delivery] .ad-head-actions { width: 100%; justify-content: space-between; }
}
@container studio-delivery (max-width: 640px) {
  .ad-detail { grid-template-columns: minmax(0,1fr); }
  .ad-table { font-size: 12px; }
  .ad-table th, .ad-table td { padding: 8px; }
  .ad-pager { flex-direction: column; align-items: flex-start; }
}
`;
