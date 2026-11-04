export default String.raw`
/* Window drag region for the Studio product shell.
   DSH's layout shell owns one draggable title row, but several product pages opt
   out with -webkit-app-region: initial, which leaves the top of those pages
   impossible to drag. Electron ignores pointer events inside a drag region, so
   every interactive descendant has to opt back in with no-drag.
   Pages that need an extra drag handle can mark an element with
   data-studio-drag-region; controls that must stay clickable inside such a
   handle can mark themselves with data-studio-no-drag. */
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
