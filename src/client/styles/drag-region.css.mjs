export default String.raw`
/* Window drag region for the Studio product shell.
   DSH's layout shell owns one draggable title row, but product pages opt out
   with -webkit-app-region: initial, which leaves their top area impossible to
   drag. Electron ignores pointer events inside a drag region, so every
   interactive descendant has to opt back in with no-drag.
   Explicit markers (data-studio-drag-region / data-studio-header) are global
   because the marked strip can sit outside the product-application scroller. */
[data-studio-drag-region],
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
  [class*="_pageHeader"],
  [class*="_header"]
) {
  -webkit-app-region: drag;
}
[data-agentkit-studio="product-application"] :is(
  [class*="_pageHeader"],
  [class*="_header"]
) :is(
  button, a, input, select, textarea, label,
  [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"],
  [data-studio-no-drag]
) {
  -webkit-app-region: no-drag;
}
[data-studio-no-drag] { -webkit-app-region: no-drag; }
`;
