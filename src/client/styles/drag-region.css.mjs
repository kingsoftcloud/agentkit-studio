export default String.raw`
/* Window drag regions for the Studio product shell.
   Only explicit markers may become drag regions: DSH also uses CSS-module
   classes such as "_titleRow" for ordinary list rows, so matching on class
   name substrings swallowed the buttons inside those rows. Interactive
   descendants always opt back out with no-drag. */
[data-studio-drag-region],
[data-studio-header],
[data-windows-titlebar],
[data-window-drag] {
  -webkit-app-region: drag;
}
[data-studio-drag-region] :is(
  button, a, input, select, textarea, label, summary, svg, img,
  [role="button"], [role="tab"], [role="menuitem"], [role="switch"],
  [role="checkbox"], [role="link"], [contenteditable="true"],
  [tabindex]:not([tabindex="-1"]), [data-studio-no-drag]
),
[data-studio-header] :is(
  button, a, input, select, textarea, label, summary, svg, img,
  [role="button"], [role="tab"], [role="menuitem"], [role="switch"],
  [role="checkbox"], [role="link"], [contenteditable="true"],
  [tabindex]:not([tabindex="-1"]), [data-studio-no-drag]
) {
  -webkit-app-region: no-drag;
}
[data-studio-no-drag] { -webkit-app-region: no-drag; }
`;
