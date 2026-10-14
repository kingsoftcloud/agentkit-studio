export default String.raw`
[data-agentkit-studio="product-application"] [data-studio-shell-main] { padding-top: max(24px,var(--dsh-frame-top-clearance,0px)) !important; }
:where([data-studio-settings], [data-studio-model-settings], [data-studio-agent-form], .agentkit-start-checks) {
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px;
  container-type: inline-size; min-width: 0;
}
.agentkit-form-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.agentkit-form-heading h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.agentkit-form-heading p, .agentkit-form-note { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
[data-studio-settings] [data-studio-settings-group] { margin-bottom: 24px; }
[data-studio-settings] [data-studio-settings-group] > h3 { margin: 0 0 4px; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
[data-studio-settings-row] { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
[data-studio-settings-row] > div { flex: 1; min-width: 0; }
[data-studio-settings-row] .agentkit-check-label { font-size: 14px; font-weight: 400; line-height: 22px; }
[data-studio-settings-row] > span { max-width: 55%; text-align: right; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 13px; }
[data-studio-settings] .agentkit-guide-entry { margin-top: 8px; padding-top: 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
:where([data-studio-settings], [data-studio-model-settings], [data-studio-agent-form], .agentkit-start-checks) button { font: inherit; }
:where([data-studio-settings], .agentkit-start-checks) button:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
:where([data-studio-settings], [data-studio-agent-form], .agentkit-start-checks) :is(button,input,select,textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
[data-studio-model-settings] form { gap: 24px !important; }
[data-studio-model-settings] article { padding: 18px 0 !important; }
[data-studio-model-settings] :is(label,input,select) { font-weight: 400 !important; }
[data-studio-model-settings] [data-model-input-capability] { padding: 8px 0; border-block: .5px solid var(--dsw-alias-border-l2); }
[data-studio-model-settings] details summary { font-size: 13px; font-weight: 400 !important; }
[data-studio-model-settings] [data-studio-form-footer] { justify-content: flex-start !important; padding-top: 16px; }
[data-studio-agent-form] [data-studio-heading] h2 { font-size: 18px !important; font-weight: 500; }
[data-studio-agent-form] [data-studio-heading] p { font-size: 12px !important; }
[data-studio-agent-form] [data-agent-form-layout] { grid-template-columns: 170px minmax(0,1fr) !important; gap: 24px !important; }
[data-studio-agent-form] [data-agent-form-steps] { border: 0 !important; background: transparent !important; padding: 0 !important; }
[data-studio-agent-form] [data-agent-form-body] { border: 0 !important; border-left: .5px solid var(--dsw-alias-border-l2) !important; border-radius: 0 !important; padding: 0 0 0 24px !important; background: transparent !important; }
[data-studio-agent-form] label { font-size: 13px !important; font-weight: 400 !important; }
[data-studio-agent-form] :is(input,select,textarea) { font-size: 14px !important; }
[data-studio-agent-form] h3 { font-size: 16px !important; font-weight: 500; }
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
  [data-studio-agent-form] [data-agent-form-layout] { grid-template-columns: minmax(0,1fr) !important; }
  [data-studio-agent-form] [data-agent-form-body] { border-left: 0 !important; padding-left: 0 !important; }
  [data-studio-agent-form] [data-agent-form-steps] > div:nth-child(2) { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  [data-studio-agent-form] [style*="grid-template-columns"] { grid-template-columns: minmax(0,1fr) !important; }
  [data-studio-settings-row], .agentkit-check-row { flex-wrap: wrap; gap: 8px; }
  [data-studio-settings-row] > div { flex-basis: 100%; }
  [data-studio-settings-row] > span { max-width: 100%; text-align: left; }
  .agentkit-form-heading { flex-wrap: wrap; gap: 8px; }
  .agentkit-check-actions { flex-wrap: wrap; }
}
`;
