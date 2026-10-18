import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertPackagedUpdateSource } from './packaged-update-source.mjs';
import product from '../src/product.json' with { type: 'json' };

const artifactDir = resolve(process.env.AGENTKIT_DESKTOP_ARTIFACT_DIR || process.argv[2] || '');
if (!artifactDir || artifactDir === resolve('.')) {
  throw new Error('usage: node scripts/verify-desktop-artifact.mjs <unsigned-artifacts-directory>');
}
const entries = readdir(artifactDir);
const names = await entries;
const dmg = names.find(name => name.endsWith('.dmg'));
// GitHub's transport archive can coexist with the actual updater ZIP.
// A native ZIP must have its corresponding blockmap; reject ambiguous release sets.
const pairs = names.filter(name => name.endsWith('.zip.blockmap') && names.includes(name.slice(0, -9)));
if (pairs.length !== 1) throw new Error('desktop artifact requires exactly one ZIP/blockmap pair');
const blockmap = pairs[0];
const zip = blockmap.slice(0, -9);
const dmgPath = resolve(process.env.AGENTKIT_DESKTOP_DMG || (dmg ? join(artifactDir, dmg) : ''));
for (const [kind, name, path] of [['DMG', dmg || process.env.AGENTKIT_DESKTOP_DMG, dmgPath], ['ZIP', zip, zip && join(artifactDir, zip)], ['ZIP.blockmap', blockmap, blockmap && join(artifactDir, blockmap)]]) {
  if (!name || !path || !existsSync(path)) throw new Error(`desktop artifact is missing ${kind}`);
}
const blockmapValue = JSON.parse(gunzipSync(await readFile(join(artifactDir, blockmap))).toString('utf8'));
if (blockmapValue.version !== '2' || !Array.isArray(blockmapValue.files) || blockmapValue.files.length === 0) throw new Error('desktop artifact blockmap is invalid');
const listing = execFileSync('unzip', ['-l', join(artifactDir, zip)], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
if (!listing.includes('AgentKit Studio.app/Contents/Resources/app.asar')) throw new Error('desktop ZIP does not contain AgentKit Studio app.asar');
const updateSource = execFileSync('unzip', ['-p', join(artifactDir, zip), 'AgentKit Studio.app/Contents/Resources/app-update.yml'], { encoding: 'utf8' });
const update = assertPackagedUpdateSource(updateSource, { target: process.env.AGENTKIT_DESKTOP_TARGET || 'mac-arm64',
  origin: process.env.EXPECTED_UPDATE_ORIGIN || product.desktop.updates.origin,
  channel: process.env.EXPECTED_UPDATE_CHANNEL || product.desktop.updates.channel });
console.log(JSON.stringify({
  status: 'artifact-passed',
  dmg: basename(dmgPath),
  zip: basename(zip),
  blockmap: basename(blockmap),
  blockmapVersion: blockmapValue.version,
  blockmapFiles: blockmapValue.files.length,
  appAsar: 'present-in-zip',
  update,
}, null, 2));
