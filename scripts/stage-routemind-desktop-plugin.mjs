/** Supply a verified RouteMind bundle to the existing DSH desktop package set. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import product from '../src/product.json' with { type: 'json' };

export async function stageRouteMindArchive(directory) {
  const { version, sha256 } = product.desktop.routeMindArchive;
  const file = `routemind-studio-${version}.tgz`;
  const target = join(directory, file);
  // Use the exact KS3 release bytes so hosted builds can package RouteMind offline.
  const bytes = await readFile(new URL(`../vendor/routemind/${file}`, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('RouteMind archive SHA-256 does not match the desktop release pin');
  }
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('usage: stage-routemind-desktop-plugin.mjs <desktop plugin input directory>');
  console.log(await stageRouteMindArchive(resolve(process.argv[2])));
}
