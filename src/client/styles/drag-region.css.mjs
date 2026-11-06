export default String.raw`
/* Window drag regions for the Studio product shell.
   Only these explicit markers may become drag regions: DSH also uses
   CSS-module classes such as "_titleRow" for ordinary list rows, so matching
   on class-name substrings swallowed the buttons inside those rows.
   data-windows-titlebar is deliberately not one of them. DSH sets it on the
   document element (apps/desktop preload-windows.ts), and -webkit-app-region
   inherits, so declaring drag for it made the root box — the whole client
   area — the window caption: pointer events went to the non-client area
   instead of the page, which killed hover feedback and turned clicks into
   caption drags (and a repeated click into a maximize). The Windows caption
   band is DSH's own .frame::before rule. */
[data-studio-drag-region],
[data-studio-header],
[data-window-drag] {
  -webkit-app-region: drag;
}
/* Interactive descendants of any drag marker opt back out, so a control inside
   a draggable row still receives its own clicks. */
:is([data-studio-drag-region], [data-studio-header], [data-window-drag]) :is(
  button, a, input, select, textarea, label, summary, svg, img,
  [role="button"], [role="tab"], [role="menuitem"], [role="switch"],
  [role="checkbox"], [role="link"], [contenteditable="true"],
  [tabindex]:not([tabindex="-1"]), [data-studio-no-drag]
) {
  -webkit-app-region: no-drag;
}
[data-studio-no-drag] { -webkit-app-region: no-drag; }
/* The root box is never draggable on Windows. This keeps the invariant explicit
   so a later marker aimed at the document element cannot re-caption the window;
   DSH's caption band declares its own drag and is unaffected. */
html[data-windows-titlebar] { -webkit-app-region: no-drag; }
`;
