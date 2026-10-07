/** Export the official unsigned image to the Studio delivery path after packaging. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants, copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function exportLocalDmg({ source, output, studioVersion, dshVersion }) {
  if (!/^\d+\.\d+\.\d+$/.test(studioVersion || '') || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(dshVersion || '')) {
    throw new Error('desktop export requires explicit Studio and DSH versions');
  }
  const image = resolve(source);
  const info = await stat(image);
  if (!info.isFile() || info.size === 0) throw new Error('official desktop image is missing or empty');
  const filename = `AgentKit-Studio-${studioVersion}-mac-arm64-local.dmg`;
  const destination = resolve(output);
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(destination, '.studio-dmg-'));
  try {
    const copied = join(temporary, filename);
    await copyFile(image, copied, constants.COPYFILE_FICLONE);
    const [sourceDigest, digest] = await Promise.all([sha256(image), sha256(copied)]);
    const after = await stat(image);
    if (sourceDigest !== digest || info.size !== after.size || info.mtimeMs !== after.mtimeMs) {
      throw new Error('official desktop image changed while exporting; rerun after packaging finishes');
    }
    const record = { product: 'AgentKit Studio', studioVersion, dshVersion, target: 'mac-arm64', unsigned: true, filename, bytes: info.size, sha256: digest };
    await writeFile(`${copied}.sha256`, `${digest}  ${filename}\n`);
    await writeFile(`${copied}.json`, `${JSON.stringify(record, null, 2)}\n`);
    // The previous usable image survives a missing source or failed copy.
    for (const suffix of ['', '.sha256', '.json']) await rename(`${copied}${suffix}`, join(destination, `${filename}${suffix}`));
    return { ...record, path: join(destination, filename) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, output, studioVersion, dshVersion] = process.argv.slice(2);
  if (!source || !output || !studioVersion || !dshVersion) throw new Error('usage: node scripts/export-local-dmg.mjs <official-dmg> <output-directory> <studio-version> <dsh-version>');
  const result = await exportLocalDmg({ source, output, studioVersion, dshVersion });
  console.log(`Studio unsigned DMG: ${result.path}\nSHA256: ${result.sha256}\nBytes: ${result.bytes}`);
}
