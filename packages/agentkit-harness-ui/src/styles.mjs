// @kingsoftcloud/agentkit-harness-ui — styles
//
// A single CSS string exported for hosts that want the built-in look. It uses
// only the stable class names produced by the view model and adapts to light
// and dark color schemes via `prefers-color-scheme`. Hosts can omit it
// (styleSheet={null}) and own styling entirely, or pass their own string.

export const styles = `
.harness-timeline-shell {
  --harness-fg: currentColor;
  --harness-fg-muted: color-mix(in srgb, currentColor 60%, transparent);
  --harness-bg: transparent;
  --harness-border: color-mix(in srgb, currentColor 14%, transparent);
  --harness-running: #0969da;
  --harness-error: #cf222e;
  --harness-added: #1a7f37;
  --harness-removed: #cf222e;
  --harness-thought: color-mix(in srgb, currentColor 40%, transparent);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: var(--ui-font-size, 14px);
  color: var(--harness-fg);
  background: transparent;
  border: 0;
  overflow: visible;
  box-sizing: border-box;
  container: harness-process / inline-size;
}
@media (prefers-color-scheme: dark) {
  .harness-timeline-shell {
    --harness-running: #4493f8;
    --harness-error: #ff7b72;
    --harness-added: #4ac26b;
    --harness-removed: #ff7b72;
    --harness-thought: color-mix(in srgb, currentColor 30%, transparent);
  }
}
.harness-timeline-shell[data-theme="dark"] { --harness-running: #4493f8; --harness-error: #ff7b72; --harness-added: #4ac26b; --harness-removed: #ff7b72; --harness-thought: color-mix(in srgb, currentColor 30%, transparent); }
.harness-timeline-shell[data-theme="light"] { --harness-running: #0969da; --harness-error: #cf222e; --harness-added: #1a7f37; --harness-removed: #cf222e; --harness-thought: color-mix(in srgb, currentColor 40%, transparent); }
.harness-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0;
}
.harness-plan-dock {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--harness-border);
  font-size: 0.85rem;
}
.harness-plan-count { font-weight: 600; }
.harness-plan-label { color: var(--harness-fg-muted); }
.harness-plan-current { color: var(--harness-running); }
.harness-thinking-placeholder { color: var(--harness-fg-muted); padding: 4px 2px; }
.harness-shimmer {
  background: linear-gradient(90deg, var(--harness-fg-muted), var(--harness-fg), var(--harness-fg-muted));
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: harness-shimmer 1.4s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .harness-shimmer { animation: none; color: var(--harness-fg-muted); }
}
@keyframes harness-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.harness-text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.harness-thought, .harness-tool {
  border: 0;
  padding: 2px 0;
  background: transparent;
}
.harness-thought-details, .harness-tool-details { margin: 0; }
.harness-thought-summary, .harness-tool-summary {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.harness-thought-summary::-webkit-details-marker, .harness-tool-summary::-webkit-details-marker { display: none; }
/* Inline SVG icons (Lucide, ISC — see NOTICE) are sized by font-size so they
   sit on the text baseline; stroke is currentColor so they inherit the line
   color and dim with the muted/failure tokens. */
.harness-icon { width: 16px; height: 16px; display: inline-block; flex: 0 0 auto; vertical-align: -0.15em; }
.harness-tool-kind-icon, .harness-file-icon { color: var(--harness-fg-muted); }
.harness-thought-icon { color: var(--harness-thought); }
.harness-tool-chevron, .harness-thought-chevron {
  color: var(--harness-fg-muted); flex: 0 0 auto; transition: transform 0.2s ease-out, opacity 0.2s ease-out;
  opacity: 0;
}
.harness-tool-summary:hover .harness-tool-chevron,
.harness-thought-summary:hover .harness-thought-chevron { opacity: 1; }
.harness-tool-details[open] .harness-tool-chevron,
.harness-thought-details[open] .harness-thought-chevron { transform: rotate(90deg); opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .harness-tool-chevron, .harness-thought-chevron { transition: none; }
}
.harness-thought-label { color: var(--harness-thought); font-weight: 500; flex-shrink: 0; white-space: nowrap; }
.harness-thought-preview { color: var(--harness-fg-muted); font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60ch; }
.harness-thought-body { margin: 12px 0 0 8px; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; padding-left: 14px; border-left: 1px solid var(--harness-border); color: var(--harness-thought); }
.harness-thought-label-streaming { color: var(--harness-running); }
.harness-thought-preview {
  color: var(--harness-fg-muted); font-style: normal; overflow: hidden; white-space: nowrap;
  text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; max-width: 60ch;
}
.harness-thought-preview-text { display: inline-block; min-width: 100%; }
.harness-tool-title { font-weight: 500; color: var(--harness-fg-muted); flex-shrink: 0; white-space: nowrap; }
/* Running tool kind/title takes the streaming gradient text (matches the
   desktop ToolLayout running kindLabel); reduced-motion falls back to the
   running color without the sweep. */
.harness-tool-title-streaming {
  background: linear-gradient(90deg, var(--harness-fg-muted), var(--harness-running), var(--harness-fg-muted));
  background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: harness-shimmer 1.4s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .harness-tool-title-streaming { animation: none; color: var(--harness-running); }
}
.harness-search-primary, .harness-tool-primary { color: var(--harness-fg); font-weight: 400; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.harness-tool-command-summary {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem;
  color: var(--harness-fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 50ch;
}
.harness-tool-secondary { font-size: 0.8rem; color: var(--harness-fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
.harness-tool-status { font-size: 0.8rem; color: var(--harness-fg-muted); text-transform: lowercase; }
.harness-tool-status-running { color: var(--harness-running); }
.harness-tool-status-failed { color: var(--harness-error); }
.harness-tool-status-completed { display: none; }
.harness-tool-details-static > summary { cursor: default; list-style: none; }
.harness-tool-details-static > summary::-webkit-details-marker { display: none; }
.harness-tool-action {
  border: 1px solid var(--harness-border); background: transparent; color: var(--harness-fg-muted);
  border-radius: 6px; padding: 2px 8px; font-size: 0.75rem; cursor: pointer;
}
.harness-tool-action:hover { border-color: var(--harness-running); color: var(--harness-running); }
.harness-inspect-action { padding: 1px 6px; }
.harness-copy-action { font-family: ui-sans-serif, system-ui, sans-serif; }
.harness-tool-detail { margin: 6px 0 0; display: flex; flex-direction: column; gap: 2px; font-size: 0.85rem; }
.harness-tool-detail-line { display: flex; gap: 6px; }
.harness-tool-detail-line dt { color: var(--harness-fg-muted); min-width: 8ch; }
.harness-tool-detail-line dd { margin: 0; word-break: break-all; }
.harness-tool-progress { color: var(--harness-running); font-size: 0.85rem; }
.harness-tool-error { color: var(--harness-error); font-size: 0.85rem; }
.harness-tool-error-inline { font-weight: 600; }
.harness-tool-result { margin-top: 6px; }
.harness-tool-result > summary { cursor: pointer; color: var(--harness-fg-muted); font-size: 0.8rem; }

/* ── execute / terminal ─────────────────────────────────────────────── */
.harness-execute-detail { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
.harness-execute-command { min-width: 0; }
.harness-execute-command-row { display: flex; align-items: flex-start; gap: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.harness-execute-prompt { color: var(--harness-fg-muted); flex: 0 0 auto; }
.harness-execute-command-text {
  margin: 0; min-width: 0; flex: 1 1 auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: inherit; line-height: 20px;
}
.harness-command-viewport { max-height: 3lh; overflow: hidden; line-height: 20px; }
.harness-command-viewport[data-expanded="true"] { max-height: 10lh; overflow-y: auto; }
.harness-command-toggle { border: 0; padding: 4px 0 0; margin-left: 2ch; background: transparent; color: var(--harness-fg-muted); font: inherit; font-size: 12px; cursor: pointer; }
.harness-execute-command-actions { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.harness-execute-output-block { display: flex; flex-direction: column; gap: 4px; }
.harness-execute-output {
  margin: 0; min-width: 0; max-height: 5lh; overflow: auto; padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: inherit;
  white-space: pre-wrap; overflow-wrap: anywhere; line-height: 20px; color: var(--harness-fg-muted);
}
.harness-execute-stdout { background: transparent; }
.harness-execute-stderr { color: var(--harness-error); background: color-mix(in srgb, var(--harness-error) 8%, transparent); }
.harness-execute-no-output { color: var(--harness-fg-muted); font-size: 0.8rem; margin: 0; }
.harness-execute-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.75rem; }
.harness-execute-exit { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 1px 6px; border-radius: 4px; }
.harness-execute-exit-ok { color: var(--harness-added); background: color-mix(in srgb, var(--harness-added) 12%, transparent); }
.harness-execute-exit-err { color: var(--harness-error); background: color-mix(in srgb, var(--harness-error) 12%, transparent); }
.harness-execute-cwd { color: var(--harness-fg-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ── file chips (read / edit) ───────────────────────────────────────── */
.harness-edit-chips { display: inline-flex; flex-wrap: wrap; gap: 2px; align-items: center; min-width: 0; }
.harness-edit-chip-wrap { display: inline-flex; min-width: 0; align-items: center; }
.harness-edit-chip-sep { color: var(--harness-fg-muted); margin: 0 2px; }
.harness-file-chip {
  display: inline-flex; min-width: 0; max-width: 100%; align-items: center; gap: 4px;
  color: var(--harness-fg-muted); background: transparent; border: 0; cursor: pointer; padding: 0;
}
.harness-file-chip:hover { color: var(--harness-running); text-decoration: underline; }
.harness-file-chip-static { cursor: default; }
.harness-file-chip-static:hover { color: var(--harness-fg-muted); text-decoration: none; }
.harness-file-icon { font-size: 0.85rem; }
.harness-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.harness-read-path { font-size: 0.78rem; }

/* ── diff count + inline diff (edit) ─────────────────────────────────── */
.harness-diff-count { display: inline-flex; gap: 4px; align-items: center; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
.harness-diff-added { color: var(--harness-added); }
.harness-diff-removed { color: var(--harness-removed); }
.harness-edit-diff { margin-top: 6px; border-top: 1px solid var(--harness-border); padding-top: 6px; }
.harness-diff-header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.harness-diff-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; color: var(--harness-fg); word-break: break-all; }
.harness-diff-actions { display: inline-flex; gap: 6px; margin-left: auto; }
.harness-diff-view { margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
.harness-diff-line { display: grid; grid-template-columns: 3ch 3ch 1.5ch 1fr; white-space: pre; }
.harness-diff-gutter { color: var(--harness-fg-muted); text-align: right; padding-right: 4px; user-select: none; opacity: 0.7; }
.harness-diff-marker { text-align: center; user-select: none; opacity: 0.7; }
.harness-diff-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.harness-diff-line:hover .harness-diff-text { overflow: visible; text-overflow: clip; }
.harness-diff-added > .harness-diff-text, .harness-diff-added { color: var(--harness-added); background: color-mix(in srgb, var(--harness-added) 10%, transparent); }
.harness-diff-removed > .harness-diff-text, .harness-diff-removed { color: var(--harness-removed); background: color-mix(in srgb, var(--harness-removed) 10%, transparent); }
.harness-diff-truncated { color: var(--harness-fg-muted); padding: 2px 0; }

/* Split view: default hidden on narrow viewports, shown alongside unified on wide. */
.harness-diff-split { display: none; }
.harness-diff-split-col { min-width: 0; overflow: auto; }
@container harness-process (min-width: 720px) {
  .harness-timeline-shell.wide-diff .harness-diff-unified,
  .harness-timeline-shell:has(.harness-diff-split) .harness-diff-unified { display: none; }
  .harness-diff-split { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; }
  .harness-diff-split-col { border: 1px solid var(--harness-border); }
}

.harness-status-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; padding-top: 6px; border-top: 1px solid var(--harness-border); font-size: 0.85rem; }
.harness-status-label { font-weight: 600; }
.harness-status-label[data-state="failed"] { color: var(--harness-error); }
.harness-status-label[data-state="completed"] { color: var(--harness-added); }
.harness-status-summary, .harness-status-error { color: var(--harness-fg-muted); }
.harness-status-error { color: var(--harness-error); }
.harness-jump-latest {
  align-self: center; border: 1px solid var(--harness-border); background: var(--harness-bg);
  color: var(--harness-fg); border-radius: 999px; padding: 4px 12px; cursor: pointer;
}
.harness-jump-latest:hover { border-color: var(--harness-running); color: var(--harness-running); }

.harness-user-message { margin: 1rem 0 1.5rem auto; padding: .8rem 1rem; max-width: 85%; border-radius: 14px; background: color-mix(in srgb, currentColor 7%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; }

.harness-summary-roll { position: relative; display: inline-grid; vertical-align: middle; overflow: hidden; }
.harness-summary-roll > span { grid-area: 1 / 1; white-space: nowrap; }
.harness-summary-in { animation: harness-summary-in 300ms cubic-bezier(.4,0,.2,1) both; }
.harness-summary-out { position: absolute; left: 0; top: 0; animation: harness-summary-out 300ms cubic-bezier(.4,0,.2,1) both; }
@keyframes harness-summary-in { from { transform: translateY(.8em); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes harness-summary-out { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-.8em); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .harness-summary-in, .harness-summary-out { position: absolute; left: 0; top: 0; animation: none; } }

.harness-context-marker { display: flex; align-items: center; gap: 10px; padding: 8px 0; color: var(--harness-fg-muted); font-size: var(--ui-font-size, 14px); }
.harness-context-rule { height: 1px; min-width: 24px; flex: 1; background: var(--harness-border); opacity: .5; }
.harness-context-marker > svg { flex-shrink: 0; }

button.harness-tool-summary { border: 0; background: none; color: inherit; font: inherit; text-align: left; padding: 0; cursor: pointer; max-width: 100%; }
.harness-agent-name { display: inline-flex; align-items: center; flex-shrink: 0; max-width: 9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 500; line-height: 1.5; }
.harness-agent-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--harness-fg-muted); }
.harness-agent-separator { flex: 0 0 auto; color: var(--harness-fg-muted); }
.harness-agent-name[data-color="blue"] { color: #0369a1; } .harness-agent-name[data-color="cyan"] { color: #0e7490; }
.harness-agent-name[data-color="green"] { color: #047857; } .harness-agent-name[data-color="orange"] { color: #c2410c; }
.harness-agent-name[data-color="pink"] { color: #be185d; } .harness-agent-name[data-color="purple"] { color: #6d28d9; }
.harness-agent-name[data-color="red"] { color: #be123c; } .harness-agent-name[data-color="yellow"] { color: #b45309; }
[data-theme="dark"] .harness-agent-name[data-color="blue"] { color: #7dd3fc; } [data-theme="dark"] .harness-agent-name[data-color="cyan"] { color: #67e8f9; }
[data-theme="dark"] .harness-agent-name[data-color="green"] { color: #6ee7b7; } [data-theme="dark"] .harness-agent-name[data-color="orange"] { color: #fdba74; }
[data-theme="dark"] .harness-agent-name[data-color="pink"] { color: #f9a8d4; } [data-theme="dark"] .harness-agent-name[data-color="purple"] { color: #c4b5fd; }
[data-theme="dark"] .harness-agent-name[data-color="red"] { color: #fda4af; } [data-theme="dark"] .harness-agent-name[data-color="yellow"] { color: #fcd34d; }

.harness-subagent-pane { padding: 16px; height: 100%; min-height: 0; overflow: auto; }
.harness-subagent-window-notice { font-size: 12px; color: var(--harness-fg-muted, #888); }
`;
