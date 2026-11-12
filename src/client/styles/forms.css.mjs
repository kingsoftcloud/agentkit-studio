export default String.raw`
[data-agentkit-studio="product-application"] [data-studio-header] { padding-top: 28px; }
[data-platform="darwin"] [data-agentkit-studio="product-application"] [data-studio-header] { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.studio-host-status { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, #676767); font-size: 13px; line-height: 20px; white-space: nowrap; }
.studio-status-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.studio-page-actions { display: flex; align-items: center; gap: 8px; }
.studio-tabs, .ak-segmented.studio-tabs { display: inline-flex; max-width: 100%; box-sizing: border-box; gap: 2px; padding: 2px; margin-bottom: 24px; border: 0; border-radius: 14px; background: var(--dsw-alias-bg-module-platform); }
.studio-tabs > button, .ak-segmented.studio-tabs > button { flex: none; height: 30px; border: 0; border-radius: 12px; padding: 0 14px; color: var(--dsw-alias-label-secondary); background: transparent; font: inherit; font-size: 14px; font-weight: 400; white-space: nowrap; cursor: pointer; }
.studio-tabs > button:hover { color: var(--dsw-alias-label-primary); }
.studio-tabs > button:is([aria-selected="true"],[aria-current="page"]), .ak-segmented.studio-tabs > button[aria-current="page"] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: 0 0 0 .5px var(--dsw-alias-border-l3); }
.studio-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 16px; }
.studio-chips > button { height: 28px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px; cursor: pointer; }
.studio-chips > button:hover { color: var(--dsw-alias-label-primary); }
.studio-chips > button[aria-current="page"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font-weight: 500; }
.studio-st { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 13px; white-space: nowrap; }
.studio-st::before { content: ''; width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--dsw-alias-label-dimmed); }
.studio-st[data-tone="ok"]::before { background: var(--dsw-alias-state-success-primary); }
.studio-st[data-tone="warn"]::before { background: var(--dsw-alias-state-warn-primary); }
.studio-st[data-tone="err"]::before { background: var(--dsw-alias-state-error-primary); }
.studio-st[data-tone="run"]::before { background: var(--dsw-alias-state-business-primary); }
.studio-rows { display: flex; flex-direction: column; gap: 2px; }
.studio-row { display: flex; align-items: center; gap: 14px; margin: 0 -8px; padding: 10px 8px; border-radius: 16px; }
.studio-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.studio-tile { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border: .5px solid var(--dsw-alias-border-l3); border-radius: 12px; color: var(--dsw-alias-label-secondary); }
.studio-row-main { flex: 1; min-width: 0; }
.studio-row-title { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; font-weight: 500; }
.studio-row-id { font: 400 12px/18px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--dsw-alias-label-tertiary); }
.studio-row-meta { margin-top: 2px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.studio-row-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.studio-panel { border: .5px solid var(--dsw-alias-border-l3); border-radius: 16px; background: var(--dsw-alias-bg-layer-1); }
.studio-panel-padded { padding: 16px; }
.studio-srow { display: flex; align-items: center; gap: 16px; min-height: 56px; padding: 12px 16px; box-sizing: border-box; }
.studio-srow + .studio-srow, .studio-panel > .studio-cfoot { border-top: .5px solid var(--dsw-alias-border-l2); }
.studio-srow-label { flex: 1; min-width: 0; font-size: 14px; line-height: 20px; }
.studio-srow-detail { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.studio-srow-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; max-width: 55%; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.studio-cfoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.studio-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.studio-tbl th, .studio-tbl td { padding: 11px 12px; text-align: left; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.studio-tbl th { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.studio-menu, .studio-toast { padding: 4px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 14px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-alias-shadow-l2, 0 3px 16px var(--dsw-alias-border-l2)); }
.studio-menu button { display: flex; width: 100%; padding: 8px 10px; border: 0; border-radius: 10px; background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; }
.studio-menu button:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
.studio-toast { padding: 12px 16px; font-size: 13px; }
.studio-help { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; border: .5px solid var(--dsw-alias-border-l3, #d4d4d4); border-radius: 50%; color: var(--dsw-alias-label-tertiary, #999); font-size: 11px; line-height: 1; font-style: normal; cursor: help; }
.studio-operational-surface { min-width: 0; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }
.studio-operational-surface form label { font-size: 14px !important; font-weight: 500 !important; }
.studio-operational-surface form :is(input:not([type=checkbox]):not([type=radio]),select,textarea) { border-radius: 10px !important; border-width: .5px !important; margin-top: 8px !important; }
.studio-operational-surface button, .studio-operational-table button { border-radius: 12px !important; font-weight: 400; }
.studio-operational-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
.studio-task-row:hover, .studio-plugin-row:hover { background: var(--dsw-alias-interactive-bg-hover) !important; }
.studio-task-row button { background: transparent !important; height: 28px !important; padding: 0 8px !important; }
[data-studio-settings] .agentkit-form-heading > div, .sq-toolbar > div { display: flex; align-items: center; gap: 8px; }
:where([data-studio-settings], [data-studio-model-settings], [data-studio-agent-form], .agentkit-start-checks) {
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
  container-type: inline-size; min-width: 0;
}
.agentkit-form-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.agentkit-form-heading h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.agentkit-form-heading p, .agentkit-form-note { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
[data-studio-settings] [data-studio-settings-group] { margin-bottom: 24px; }
[data-studio-settings] [data-studio-settings-group] > h3 { margin: 0 0 8px; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.studio-settings-panel { padding: 0 16px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xl,16px); }
.studio-settings-panel > [data-studio-settings-row]:last-child { border-bottom: 0; }
.studio-automation-surface > [data-studio-heading] { justify-content: flex-end !important; gap: 8px !important; }
.studio-automation-surface > [data-studio-heading] h2 { display: none; }
[data-studio-settings-row] { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
[data-studio-settings-row] > div { flex: 1; min-width: 0; }
[data-studio-settings-row] .agentkit-check-label { font-size: 14px; font-weight: 400; line-height: 22px; }
[data-studio-settings-row] > span { max-width: 55%; text-align: right; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 13px; }
[data-studio-settings] .agentkit-guide-entry { margin-top: 8px; padding-top: 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
:where([data-studio-settings], [data-studio-model-settings], [data-studio-agent-form], .agentkit-start-checks) button { font: inherit; }
:where([data-studio-settings], .agentkit-start-checks) button:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
:where([data-studio-settings], [data-studio-agent-form], .agentkit-start-checks) :is(button,input,select,textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
/* The model settings surface owns its layout, control and chip styles in
   styles/model-settings.css.mjs; keep this sheet free of overrides for it. */
/* The Agent form owns its layout and controls in styles/agent-form.css.mjs. */
.agentkit-check-toggle { display: flex; justify-content: flex-end; margin-top: 12px; }
.agentkit-check-toggle button { font-size: 12px; padding: 5px 10px !important; }
.agentkit-start-checks { margin: 12px 0; padding: 18px 20px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-bg-layer-3); }
.agentkit-check-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; border-top: .5px solid var(--dsw-alias-border-l2); }
.agentkit-check-row > div:first-child { min-width: 0; }
.agentkit-check-label { font-size: 14px; line-height: 22px; }
.agentkit-check-actions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.agentkit-check-state { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
[data-check-state=confirmed] .agentkit-check-state { color: var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary)); }
[data-check-state=missing] .agentkit-check-state { color: var(--dsw-alias-state-warn-primary); }
@container (max-width: 540px) {
  [data-studio-settings-row], .agentkit-check-row { flex-wrap: wrap; gap: 8px; }
  [data-studio-settings-row] > div { flex-basis: 100%; }
  [data-studio-settings-row] > span { max-width: 100%; text-align: left; }
  .agentkit-form-heading { flex-wrap: wrap; gap: 8px; }
  .agentkit-check-actions { flex-wrap: wrap; }
}
@media (max-width: 640px) {
  .studio-row, .studio-srow, .studio-cfoot { flex-wrap: wrap; }
  .studio-row-main { flex-basis: calc(100% - 56px); }
  .studio-srow-label { flex-basis: 100%; }
  .studio-srow-control { max-width: 100%; flex-wrap: wrap; }
}
`;
