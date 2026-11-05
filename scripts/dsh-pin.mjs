import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const pinPath = join(repositoryRoot, 'dsh-pin.json');
export const dshPin = Object.freeze(JSON.parse(readFileSync(pinPath, 'utf8')));
export const dshPatchRoot = resolve(repositoryRoot, dshPin.patchDirectory);

export function dshPinBranchRef() {
  return `refs/heads/codex/studio-${dshPin.ref}`;
}
