export default String.raw`
[data-studio-agent-form] { color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; container-type: inline-size; min-width: 0; }
[data-studio-agent-form] [data-studio-heading] { margin-bottom: 24px; align-items: center; }
.af-layout { display: grid; grid-template-columns: 168px minmax(0,1fr); gap: 32px; align-items: start; }
.af-steps { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 0; }
.af-step { display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-md,12px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer; }
.af-step:disabled { cursor: default; color: var(--dsw-alias-label-tertiary); }
.af-step:not(:disabled):hover, .af-step[aria-current="step"] { background: var(--dsw-alias-interactive-bg-hover); }
.af-step[aria-current="step"] { color: var(--dsw-alias-label-primary); font-weight: 500; }
.af-step-index { display: inline-grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3,#ececec); font-size: 12px; font-weight: 500; line-height: 1; }
.af-step[aria-current="step"] .af-step-index, .af-step[data-done] .af-step-index { background: var(--dsw-alias-button-primary-fill,#0b0b0d); color: var(--dsw-alias-label-primary-foreground,#fff); }
.af-body { min-width: 0; max-width: 820px; }
.af-section { padding: 20px 0; border-top: .5px solid var(--dsw-alias-border-l2); }
.af-section:first-child, .af-details-body > .af-section:first-child, .af-section-plain { padding-top: 0; border-top: 0; }
.af-section-plain { padding-bottom: 0; }
.af-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.af-section-title { display: inline-flex; align-items: center; gap: 6px; margin: 0; font-size: 14px; font-weight: 500; line-height: 22px; color: var(--dsw-alias-label-primary); }
.af-section-side { display: flex; align-items: center; gap: 8px; flex: none; }
.af-section-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.af-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.af-row:last-child { border-bottom: 0; }
.af-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.af-row-title { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); }
.af-row-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.af-row-control { display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex: none; max-width: 60%; }
.af-row-control .af-select, .af-row-control .af-input { width: auto; min-width: 200px; max-width: 100%; }
.af-field { display: block; margin: 0 0 16px; min-width: 0; }
.af-field-label { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); }
.af-field-hint { display: block; margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.af-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 0 16px; }
.af-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 0 16px; }
.af-input, .af-textarea, .af-select { display: block; box-sizing: border-box; width: 100%; font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); border-radius: var(--dsw-radius-md,12px); }
.af-input, .af-select { height: 36px; padding: 0 12px; }
.af-input, .af-textarea { border: .5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); }
.af-input:hover, .af-textarea:hover { border-color: var(--dsw-alias-border-l4); }
.af-textarea { min-height: 88px; padding: 8px 12px; resize: vertical; }
.af-textarea[data-mono] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.af-select { appearance: none; -webkit-appearance: none; padding-right: 36px; border: 0; cursor: pointer; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2,#f4f5f6)) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='%23676767' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") no-repeat right 12px center; }
.af-select:not(:disabled):hover { background-color: var(--dsw-alias-interactive-bg-hover); }
.af-input:disabled, .af-textarea:disabled, .af-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: not-allowed; }
.af-input::placeholder, .af-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.af-switch { display: inline-flex; align-items: center; gap: 10px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.af-switch input { appearance: none; -webkit-appearance: none; position: relative; flex: none; width: 40px; height: 22px; margin: 0; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3,#d4d4d4); cursor: pointer; transition: background .15s; }
.af-switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform .15s; }
.af-switch input:checked { background: var(--dsw-alias-button-primary-fill,#0b0b0d); }
.af-switch input:checked::after { transform: translateX(18px); }
.af-switch input:disabled { opacity: .5; cursor: not-allowed; }
.af-choices { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(200px,1fr)); }
.af-choices[data-columns="1"] { grid-template-columns: minmax(0,1fr); }
.af-choice, .af-check { display: flex; align-items: flex-start; gap: 10px; box-sizing: border-box; min-width: 0; padding: 10px 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer; }
.af-choice { width: 100%; }
.af-choice:hover, .af-check:hover { background: var(--dsw-alias-interactive-bg-hover); }
.af-choice[aria-pressed="true"], .af-check[data-checked] { border-color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 .5px var(--dsw-alias-label-primary); }
.af-choice-text, .af-check-text { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.af-choice-title, .af-check-text > strong { font-size: 13px; font-weight: 500; line-height: 20px; }
.af-choice-desc, .af-check-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.af-check-desc { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.af-check input { appearance: none; -webkit-appearance: none; display: grid; place-items: center; flex: none; width: 16px; height: 16px; margin: 2px 0 0; border: 1px solid var(--dsw-alias-border-l4,#c8c8c8); border-radius: var(--dsw-radius-xs,4px); background: var(--dsw-alias-bg-layer-1); cursor: pointer; }
.af-check input:checked { border-color: var(--dsw-alias-button-primary-fill,#0b0b0d); background: var(--dsw-alias-button-primary-fill,#0b0b0d); }
.af-check input:checked::after { content: ''; width: 8px; height: 4px; border: solid var(--dsw-alias-label-primary-foreground,#fff); border-width: 0 0 1.5px 1.5px; transform: translateY(-1px) rotate(-45deg); }
.af-check input:disabled { opacity: .5; cursor: not-allowed; }
.af-check-inline { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; line-height: 22px; cursor: pointer; }
.af-check-inline input { margin: 0; }
.af-details { margin: 0 0 16px; }
.af-details > summary { display: inline-flex; align-items: center; gap: 6px; padding: 4px 0; list-style: none; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); cursor: pointer; user-select: none; }
.af-details > summary::-webkit-details-marker { display: none; }
.af-details > summary::before { content: ''; width: 5px; height: 5px; margin: 0 4px 2px 2px; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: rotate(-45deg); transition: transform .15s; }
.af-details[open] > summary::before { transform: rotate(45deg); margin-bottom: 4px; }
.af-details > summary:hover { color: var(--dsw-alias-label-primary); }
.af-details-body { margin-top: 12px; }
.af-note { margin: 0 0 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.af-note[data-tone="danger"] { color: var(--dsw-alias-state-error-primary,#b42318); }
.af-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary,#946200); }
.af-summary-row { display: flex; justify-content: space-between; gap: 20px; padding: 10px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); font-size: 13px; line-height: 20px; }
.af-summary-row > span { color: var(--dsw-alias-label-tertiary); flex: none; }
.af-summary-row > strong { font-weight: 500; text-align: right; overflow-wrap: anywhere; }
.af-help { display: inline-grid; place-items: center; flex: none; width: 15px; height: 15px; border: 1px solid var(--dsw-alias-border-l4,#c8c8c8); border-radius: 999px; color: var(--dsw-alias-label-tertiary); font-size: 10px; font-style: normal; font-weight: 600; line-height: 1; cursor: help; }
.af-help:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-secondary); }
.af-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.af-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; box-sizing: border-box; height: 36px; padding: 0 14px; border: .5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md,12px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; font-weight: 500; line-height: 22px; white-space: nowrap; cursor: pointer; }
.af-btn:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
.af-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: not-allowed; }
.af-btn[data-variant="primary"] { border-color: transparent; background: var(--dsw-alias-button-primary-fill,#0b0b0d); color: var(--dsw-alias-label-primary-foreground,#fff); }
.af-btn[data-variant="primary"]:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill)); }
.af-btn[data-variant="primary"]:disabled { background: var(--dsw-alias-button-primary-dimmed, var(--dsw-alias-bg-layer-3)); color: var(--dsw-alias-label-primary-foreground,#fff); opacity: .55; }
.af-btn[data-size="sm"] { height: 30px; padding: 0 10px; font-size: 13px; font-weight: 400; border-radius: var(--dsw-radius-sm,8px); }
.af-fieldset { margin: 0 0 12px; padding: 4px 16px 16px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md,12px); }
.af-fieldset > legend { padding: 0 6px; font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.af-fieldset .af-row:last-of-type { border-bottom: 0; }
.af-empty { padding: 4px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.af-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 24px; padding-top: 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
.af-footer-actions { display: flex; align-items: center; gap: 8px; }
.af-stack > * + * { margin-top: 12px; }
[data-studio-agent-form] :is(.af-input,.af-textarea,.af-select,.af-btn,.af-choice,.af-step):focus-visible, [data-studio-agent-form] :is(.af-check,.af-switch) input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
/* Agent list entry page */
.ak-agents-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.ak-agents-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ak-segmented { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2,#f4f5f6)); }
.ak-segmented > button { height: 32px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-sm,8px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap; }
.ak-segmented > button:hover { color: var(--dsw-alias-label-primary); }
.ak-segmented > button[aria-current="page"] { background: var(--dsw-alias-bg-layer-1,#fff); color: var(--dsw-alias-label-primary); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.ak-segmented > button:focus-visible, .ak-agents-toolbar .af-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.ak-agents-notice { margin: 0 0 12px; padding: 10px 12px; border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.ak-agents-list { border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md,12px); background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.ak-agents-list-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.ak-agents-list-head > strong { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.ak-agent-card { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md,12px); cursor: pointer; }
.ak-agent-card:hover { border-color: var(--dsw-alias-border-l4); }
.ak-agent-card:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
@container (max-width: 640px) {
  .af-layout { grid-template-columns: minmax(0,1fr); gap: 16px; }
  .af-steps { position: static; flex-direction: row; flex-wrap: wrap; }
  .af-step { width: auto; }
  .af-grid-2, .af-grid-3 { grid-template-columns: minmax(0,1fr); }
  .af-row { flex-wrap: wrap; gap: 8px; }
  .af-row-control { width: 100%; max-width: 100%; justify-content: flex-start; }
  .af-row-control .af-select, .af-row-control .af-input { width: 100%; }
  .af-section-head { flex-wrap: wrap; }
}
`;
