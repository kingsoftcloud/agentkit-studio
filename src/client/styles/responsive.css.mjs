export default String.raw`
.agentkit-settings-launcher {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px;
  height: 42px; padding: 0 10px 0 8px; margin: 0; box-sizing: border-box;
  border: 0; border-radius: var(--dsw-radius-md, 12px); background: transparent;
  color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 14px;
}
.agentkit-settings-launcher:hover { background: var(--dsw-alias-interactive-bg-hover); }
.agentkit-settings-launcher:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4b73e8); outline-offset: 2px; }
.agentkit-settings-launcher[data-wide="false"] { flex: none; width: 36px; height: 36px; padding: 0; gap: 0; justify-content: center; }
/* Secondary buttons keep their own label color on the neutral hover surface.
   Primary buttons are excluded here so their white label never lands on it. */
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button:not(:disabled):not([style*="--dsw-alias-label-primary-foreground"]):not([style*="--dsw-alias-button-primary-fill"]):not([data-variant="primary"]):not(.sq-btn.primary):hover {
  background: var(--dsw-alias-interactive-bg-hover, #f0f0f0) !important;
}
/* Primary buttons (white label on a dark fill) keep a dark hover fill and the
   same label color. This must cover inline token styles, class-styled
   .sq-btn.primary buttons and the af-btn/ms-btn primary variants. */
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button[style*="--dsw-alias-label-primary-foreground"]:not(:disabled):hover,
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button[style*="--dsw-alias-button-primary-fill"]:not(:disabled):hover,
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button[data-variant="primary"]:not(:disabled):hover,
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button.sq-btn.primary:not(:disabled):hover {
  background: var(--dsw-alias-button-primary-hover, #303030) !important;
  color: var(--dsw-alias-label-primary-foreground, #ffffff) !important;
}
/* Native confirmation actions opt into an explicit variant so the shared
   secondary-button hover rule cannot turn white text invisible on a light
   surface. Informational confirmations use the primary dark action by
   default; destructive confirmations retain the red action and white text. */
:where([data-studio-controls]) button[data-confirmation-variant="primary"]:not(:disabled):hover {
  background: var(--dsw-alias-button-primary-hover, #303030) !important;
  color: var(--dsw-alias-label-primary-foreground, #ffffff) !important;
}
:where([data-studio-controls]) button[data-confirmation-variant="danger"]:not(:disabled):hover {
  background: var(--dsw-alias-state-danger-hover, var(--dsw-alias-state-danger-primary, #c2402a)) !important;
  color: var(--dsw-static-neutral-00, #ffffff) !important;
}
/* A disabled primary keeps a readable label instead of fading white onto a pale fill. */
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button[data-variant="primary"]:disabled {
  opacity: 1 !important;
  color: var(--dsw-alias-label-secondary, #61666b) !important;
  background: var(--dsw-alias-button-primary-dimmed, var(--dsw-alias-bg-layer-3, #f4f4f4)) !important;
  border-color: transparent !important;
}
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) button:disabled { opacity: .4; cursor: not-allowed !important; }
:where([data-agentkit-studio="product-application"], [data-studio-model-settings], [data-studio-controls], .agentkit-credential-onboarding-content) :is(button, input, select, textarea):focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4b73e8); outline-offset: 2px; }
:where([data-agentkit-studio="product-application"], [data-studio-model-settings]) :is(input, select, textarea)::placeholder { color: var(--dsw-alias-label-dimmed, #999); }
[data-agentkit-studio="product-application"] [data-studio-tabs] { overflow-x: auto; scrollbar-width: thin; }
[data-agentkit-studio="product-application"] [data-studio-tabs] > button { flex: 0 0 auto; white-space: nowrap; }
[data-agentkit-studio="product-application"] [data-studio-heading],
[data-agentkit-studio="product-application"] [data-studio-content-intro] { flex-wrap: wrap; align-items: flex-start; }
[data-studio-model-settings] { container-type: inline-size; }
[data-studio-model-settings] input, [data-studio-model-settings] select { min-width: 0; box-sizing: border-box; }
[data-studio-model-settings] { font-size: 14px; line-height: 22px; }
[data-studio-model-settings] label { font-size: 14px !important; font-weight: 500 !important; }
[data-studio-model-settings] input, [data-studio-model-settings] select { height: 32px; font: inherit !important; border-radius: var(--dsw-radius-md, 12px) !important; }
[data-studio-model-settings] details { font-size: 13px !important; }
[data-studio-model-settings] form > section:last-of-type { border: 0 !important; border-top: 1px solid var(--dsw-alias-border-l3, #d4d4d4) !important; border-radius: 0 !important; padding: 20px 0 0 !important; background: transparent !important; }
[data-studio-model-settings] h3 { font-size: 16px !important; font-weight: 600 !important; }
[data-studio-model-settings] section > div > div > p { font-size: 13px !important; line-height: 1.5; margin-top: 6px !important; }
@container (max-width: 540px) {
  [data-studio-model-settings] [style*="grid-template-columns"] { grid-template-columns: minmax(0, 1fr) !important; }
}
@media (max-width: 960px) {
  [data-agentkit-studio="product-application"] [style*="grid-template-columns"] { grid-template-columns: minmax(0, 1fr) !important; }
  [data-agentkit-studio="product-application"] [data-studio-agent-grid],
  [data-agentkit-studio="product-application"] [data-studio-resource-grid] { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  [data-agentkit-studio="product-application"] [data-studio-heading],
  [data-agentkit-studio="product-application"] [data-studio-content-intro] { align-items: flex-start; }
  [data-agentkit-studio="product-application"] [data-studio-header] { gap: 14px !important; }
  [data-agentkit-studio="product-application"] [data-studio-pager] { flex-wrap: wrap !important; }
}
@media (max-width: 760px) {
  [data-agentkit-studio="product-application"] > main { padding-inline: 20px !important; }
  [data-agentkit-studio="product-application"] [data-studio-header] { flex-wrap: wrap !important; gap: 12px !important; margin-bottom: 16px !important; }
  [data-agentkit-studio="product-application"] [data-studio-header] > div:last-child { width: 100%; justify-content: flex-start; }
  [data-agentkit-studio="product-application"] [style*="display: flex"] { flex-wrap: wrap !important; }
  [data-agentkit-studio="product-application"] [data-studio-pager] { align-items: flex-start !important; }
  [data-agentkit-studio="product-application"] [data-studio-pager] > div { width: 100%; justify-content: flex-start !important; flex-wrap: wrap !important; }
  [data-agentkit-studio="product-application"] [data-studio-pager] select { max-width: 100%; }
  [data-agentkit-studio="product-application"] [data-studio-dialog] { width: calc(100vw - 20px) !important; max-height: calc(100vh - 20px) !important; padding: 14px !important; }
  [data-agentkit-studio="product-application"] table { font-size: 11px !important; }
}
@media (max-width: 560px) {
  [data-agentkit-studio="product-application"] [data-studio-agent-grid],
  [data-agentkit-studio="product-application"] [data-studio-resource-grid] { grid-template-columns: minmax(0, 1fr) !important; }
}
`;
