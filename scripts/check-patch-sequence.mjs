import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkPatchSequence(directory = fileURLToPath(new URL('../patches/dsh-v0.2.1-rc.2/', import.meta.url))) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const patches = manifest.patches || [];
  for (const [index, patch] of patches.entries()) {
    if (patch.sequence !== index + 1) throw new Error(`patch sequence must be contiguous at ${patch.id}`);
    if (!patch.file.startsWith(`${patch.id}-`)) throw new Error(`patch file/id mismatch at ${patch.id}`);
  }
  return { count: patches.length, first: patches[0]?.sequence ?? null, last: patches.at(-1)?.sequence ?? null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await checkPatchSequence(process.argv[2])));
