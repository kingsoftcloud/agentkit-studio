/** Resolve only Studio's asset placeholders, preserving the caller's palette. */
export function resolvePaletteStyles(source, palette) {
  return source.replace(/var\(--studio-theme-(\w+)\)/g, (_match, name) => String(palette[name]));
}
