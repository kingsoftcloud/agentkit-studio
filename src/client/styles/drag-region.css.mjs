export default String.raw`
/* Window drag regions for the Studio product shell.
   Only explicit markers may become drag regions: DSH also uses CSS-module
   classes such as "_titleRow" for ordinary list rows, so matching on class-name
   substrings swallowed the buttons inside those rows.
   data-windows-titlebar is deliberately not one of them. DSH sets it on the
   document element (apps/desktop preload-windows.ts), and the root box is the
   whole client area: declaring drag for it made the window caption cover every
   pixel, so pointer events never reached the page and a click became a caption
   drag (and a repeated click a maximize).
   Studio chrome rows stay a macOS drag surface, like DSH's own drag rows
   (ui-web base.css gates every app-region rule to data-platform='darwin').
   Windows keeps one drag surface only — the explicit caption strip below, which
   product-document mounts over the blank 40px band and keeps clear of the
   caption menu and the native window buttons.
   macOS chrome pages also reserve the frame-top clearance, so their header sits
   below the traffic lights and the band above it had no marker at all; the
   shell mounts the same kind of fixed strip there (product-document's
   installMacWindowDragStrip, inserted before the React root so later controls
   subtract themselves). */
html[data-platform='darwin'] :is([data-studio-drag-region], [data-studio-header], [data-window-drag]) {
  -webkit-app-region: drag;
}
/* Interactive descendants of any drag marker opt back out, so a control inside
   a draggable row still receives its own clicks. */
html[data-platform='darwin'] :is([data-studio-drag-region], [data-studio-header], [data-window-drag]) :is(
  button, a, input, select, textarea, label, summary, svg, img,
  [role="button"], [role="tab"], [role="menuitem"], [role="switch"],
  [role="checkbox"], [role="link"], [contenteditable="true"],
  [tabindex]:not([tabindex="-1"]), [data-studio-no-drag]
) {
  -webkit-app-region: no-drag;
}
[data-studio-no-drag] { -webkit-app-region: no-drag; }
/* The Windows root box is never draggable. product-document also writes the same
   value inline (the strongest source), so no later sheet can re-caption the
   window by targeting the document element. */
html[data-windows-titlebar],
html[data-windows-titlebar] body { -webkit-app-region: no-drag; }
/* The one Windows drag surface: product-document mounts this fixed strip over
   the blank caption band only. It starts after the caption menu (which reserves
   up to 84px and grows with the locale) and stops before the native window
   buttons, so it never covers a clickable control. Fullscreen has no caption. */
html[data-windows-titlebar] [data-studio-window-drag-strip] {
  -webkit-app-region: drag;
}
html[data-windows-titlebar][data-fullscreen] [data-studio-window-drag-strip] {
  display: none;
}
/* The one macOS title-band drag surface: product-document prepends a fixed,
   transparent strip over the blank frame-top clearance (80px after the traffic
   lights to the right edge, 40px tall) for the Studio chrome pages. It is
   inserted before the React root so later no-drag controls (the sidebar toggle
   in DSH's shell.leading seat, right-panel buttons) subtract themselves instead
   of being swallowed. Fullscreen hides the native traffic lights and with them
   the caption band, so the strip goes too. */
html[data-platform='darwin'][data-fullscreen] [data-studio-macos-drag-strip] {
  display: none;
}
`;
