export default String.raw`
@keyframes agentkitCredentialOnboardingIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.agentkit-onboarding-dialog { position: fixed; inset: var(--dsh-frame-chrome-top, 0px) 0 0; width: 100%; height: calc(100% - var(--dsh-frame-chrome-top, 0px)); max-height: none; border-radius: 0; padding: 0; overflow: auto; background: var(--studio-theme-surface); }
.agentkit-credential-onboarding-content { display: grid; grid-template-columns: minmax(300px, .9fr) minmax(400px, 1.1fr); min-height: 100%; font-family: inherit; color: var(--studio-theme-ink); animation: agentkitCredentialOnboardingIn 180ms ease-out both; }
.agentkit-onboarding-copy { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; padding: clamp(40px, 7vw, 120px); }
.agentkit-onboarding-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; font-size: 14px; font-weight: 500; }
.agentkit-onboarding-copy h1 { margin: 0; font-size: 28px; line-height: 1.5; font-weight: 500; letter-spacing: -.02em; }
.agentkit-onboarding-intro { margin: 16px 0 0; font-size: 15px; line-height: 1.8; color: var(--studio-theme-inkMuted); }
.agentkit-onboarding-status { margin: 16px 0 0; font-size: 12px; line-height: 1.6; color: var(--studio-theme-inkMuted); }
.agentkit-onboarding-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 32px; width: 100%; }
.agentkit-onboarding-actions .agentkit-onboarding-primary { width: 100%; height: 44px; border-radius: 12px; font-size: 14px; }
.agentkit-onboarding-actions .agentkit-onboarding-secondary { border: 0; padding: 0; background: transparent; color: var(--studio-theme-inkMuted); font-size: 12px; }
.agentkit-credential-guide { display: flex; flex-direction: column; justify-content: center; gap: 24px; padding: 40px; background: var(--studio-theme-canvas); border-left: .5px solid var(--studio-theme-border); }
.agentkit-onboarding-form { display: flex; flex-direction: column; justify-content: center; padding: clamp(28px, 5vw, 80px); background: var(--studio-theme-canvas); border-left: .5px solid var(--studio-theme-border); }
.agentkit-onboarding-form [data-studio-model-settings] { width: 100%; max-width: 640px; margin-inline: auto; }
.agentkit-onboarding-form [data-onboarding-mode=cloud] form > section { border: 0 !important; padding: 0 !important; background: transparent !important; }
.agentkit-credential-guide ol { display: flex; gap: 16px; list-style: none; padding: 0; margin: 0; }
.agentkit-credential-guide li { flex: 1; }
.agentkit-guide-step { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; width: 100%; padding: 0; border: 0; background: transparent; color: var(--studio-theme-inkMuted); text-align: left; font: inherit; font-size: 12px; cursor: pointer; }
.agentkit-guide-step[aria-current=step] { color: var(--studio-theme-ink); }
.agentkit-guide-number { display: grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--studio-theme-border); border-radius: 50%; font-size: 12px; }
.agentkit-guide-step[aria-current=step] .agentkit-guide-number { border-color: var(--studio-theme-primaryFill); background: var(--studio-theme-primaryFill); color: var(--studio-theme-primaryText); }
.agentkit-guide-preview { padding: 24px; border: .5px solid var(--studio-theme-border); border-radius: 16px; background: var(--studio-theme-surface); box-shadow: var(--dsw-elevation-subtle, 0 8px 24px rgb(0 0 0 / .04)); }
.agentkit-guide-preview-header { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; margin-bottom: 24px; }
.agentkit-guide-preview label { display: block; font-size: 12px; color: var(--studio-theme-inkMuted); margin: 16px 0 8px; }
.agentkit-guide-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; border: .5px solid var(--studio-theme-controlBorder); border-radius: 10px; padding: 0 12px; font-size: 13px; }
.agentkit-guide-field[data-active=true] { border-color: #1858d6; outline: 2px solid light-dark(#edf3ff, #15243e); }
.agentkit-guide-caption { margin: 0; color: var(--studio-theme-inkMuted); font-size: 12px; line-height: 1.7; }
.agentkit-guide-next { align-self: flex-start; color: var(--studio-theme-ink); background: transparent; border: 0; padding: 0; font: inherit; font-size: 12px; cursor: pointer; }
.agentkit-onboarding-dialog button:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #1858d6); outline-offset: 4px; }
@media (max-width: 760px) { .agentkit-credential-onboarding-content { grid-template-columns: 1fr; min-height: 0; } .agentkit-onboarding-copy { padding: 28px; } .agentkit-onboarding-brand { margin-bottom: 20px; } .agentkit-onboarding-copy h1 { font-size: 24px; } .agentkit-credential-guide { padding: 28px; border-left: 0; border-top: .5px solid var(--studio-theme-border); } }
@media (prefers-reduced-motion: reduce) { .agentkit-credential-onboarding-content { animation: none; } }
`;
