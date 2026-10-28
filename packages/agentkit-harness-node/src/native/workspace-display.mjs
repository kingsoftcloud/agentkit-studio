import { structuredPatch } from 'diff';

export const WORKSPACE_DISPLAY_CONTRACT = 'agentkit.workspace-display/v1';
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_PATCH_CHARS = 24000;

function text(state) {
  if (state?.kind === 'absent') return '';
  if (state?.kind !== 'file' || typeof state.bytes !== 'string') return null;
  const bytes = Buffer.from(state.bytes, 'base64');
  if (bytes.length > MAX_SOURCE_BYTES || bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

/** Project already captured execution preimages; never open a path for the UI. */
export function workspaceChangeDisplay(changes) {
  const files = [];
  let remaining = MAX_PATCH_CHARS, omittedFiles = 0;
  for (const [path, { before, after }] of changes) {
    if (files.length >= 16) { omittedFiles++; continue; }
    const oldText = text(before), newText = text(after);
    if (oldText === null || newText === null || !remaining) { omittedFiles++; continue; }
    let patch;
    try { patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context: 3, timeout: 50, maxEditLength: 10000 }); }
    catch { /* Presentation cannot alter an already-known execution outcome. */ }
    if (!patch) { omittedFiles++; continue; }
    let added = 0, removed = 0, rendered = '', truncated = false;
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) { if (line[0] === '+') added++; else if (line[0] === '-') removed++; }
      const block = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}\n`;
      if (block.length > remaining) { truncated = true; continue; }
      rendered += block; remaining -= block.length;
    }
    files.push({ path, patch: rendered, changeStat: { added, removed }, truncated,
      operationKind: before.kind === 'absent' ? 'create' : after.kind === 'absent' ? 'delete' : 'edit' });
  }
  return files.length || omittedFiles ? { contract: WORKSPACE_DISPLAY_CONTRACT,
    display: { kind: 'file_edit', files, omittedFiles } } : null;
}
