// Presentation only. A partial argument prefix is never an executable call.
const FIELDS = new Set(['path', 'file_path', 'filePath', 'filename', 'command', 'content', 'new_text', 'old_text', 'pattern', 'query']);
const MAX_PREFIX = 128 * 1024;
export function previewToolInput(raw) {
  const text = String(raw ?? '').slice(0, MAX_PREFIX), input = {};
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = partial => {
    if (text[i++] !== '"') return;
    const start = i; let escaped = false;
    while (i < text.length) {
      const ch = text[i++];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { try { return JSON.parse(text.slice(start - 1, i)); } catch { return; } }
    }
    if (!partial) return;
    const prefix = text.slice(start).replace(/\\u[0-9a-fA-F]{0,3}$/, '').replace(/\\$/, '');
    try { return JSON.parse(`"${prefix}"`); } catch { return; }
  };
  space(); if (text[i++] !== '{') return input;
  while (i < text.length) {
    space(); if (text[i] === '}') break;
    const key = string(false); if (key === undefined) break;
    space(); if (text[i++] !== ':') break; space();
    if (text[i] === '"') {
      const value = string(true);
      if (FIELDS.has(key) && value !== undefined) input[key] = value.slice(0, key === 'content' || key.endsWith('_text') ? 8000 : 2000);
    } else {
      let depth = 0, quoted = false, escaped = false;
      while (i < text.length) {
        const ch = text[i];
        if (!quoted && depth === 0 && (ch === ',' || ch === '}')) break;
        i++;
        if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
        else if (ch === '"') quoted = true;
        else if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') depth--;
      }
    }
    space(); if (text[i++] !== ',') break;
  }
  return input;
}
