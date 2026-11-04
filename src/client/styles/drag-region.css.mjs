export default String.raw`
/* Window drag region for the Studio product shell.
   DSH's layout shell owns one draggable title row, but product pages opt out
   with -webkit-app-region: initial, which leaves their top area impossible to
   drag. Electron ignores pointer events inside a drag region, so every
   interactive descendant has to opt back in with no-drag.
   Explicit markers (data-studio-drag-region / data-studio-header) are global
   because the marked strip can sit outside the product-application scroller. */
/* DSH's stylesheet owns the window-drag contract: it maps [data-window-drag] to
   drag and restores interactive descendants to no-drag. Mirror that hook here
   as well so the region still resolves if the shell sheet loads after ours. */
[data-studio-drag-region],
[data-window-drag],
[data-studio-header],
[data-windows-titlebar],
[class*="_titleRow"] {
  -webkit-app-region: drag;
}
[data-studio-drag-region] :is(
  button, a, input, select, textarea, label,
  [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"],
  [data-studio-no-drag]
),
[data-studio-header] :is(
  button, a, input, select, textarea, label,
  [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"],
  [data-studio-no-drag]
) {
  -webkit-app-region: no-drag;
}
[data-agentkit-studio="product-application"] :is(
  [data-windows-titlebar],
  [data-studio-drag-region],
  [class*="_titleRow"],
  [class*="_pageHeader"],
  [class*="_header"]
) {
  -webkit-app-region: drag;
}
[data-agentkit-studio="product-application"] :is(
  [data-windows-titlebar],
  [data-studio-drag-region],
  [class*="_titleRow"],
  [class*="_pageHeader"],
  [class*="_header"]
) :is(
  button, a, input, select, textarea, label,
  [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"],
  [data-studio-no-drag]
) {
  -webkit-app-region: no-drag;
}
[data-agentkit-studio="product-application"] [data-studio-drag-region] { -webkit-app-region: drag; }
[data-agentkit-studio="product-application"] [data-studio-no-drag] { -webkit-app-region: no-drag; }
`;
