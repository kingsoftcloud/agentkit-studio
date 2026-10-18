import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createZip } from '../src/zip.mjs';

test('artifact verification examines the native ZIP when an Actions transport ZIP coexists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-artifact-selection-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const app = 'AgentKit Studio.app/Contents/Resources';
  await mkdir(join(root, app), {recursive:true});
  await writeFile(join(root, app, 'app.asar'), 'archive membership fixture');
  await writeFile(join(root, 'actions-artifact.zip'), 'transport container, not a native App ZIP');
  await writeFile(join(root, 'studio.dmg'), 'DMG path fixture');
  await writeFile(join(root, 'studio.zip'), createZip([{name:app+'/app.asar',data:Buffer.from('archive membership fixture')}]));
  await writeFile(join(root, 'studio.zip.blockmap'), gzipSync(JSON.stringify({version:'2',files:[{name:'fixture'}]})));
  const command = resolve('scripts/verify-desktop-artifact.mjs');
  assert.throws(() => execFileSync(process.execPath, [command, root], {stdio:'pipe'}), /app-update.yml/);
  await writeFile(join(root, 'studio.zip'), createZip([
    {name:app+'/app.asar',data:Buffer.from('archive membership fixture')},
    {name:app+'/app-update.yml',data:Buffer.from(JSON.stringify({provider:'generic', url:'https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/feeds/mac-arm64/', channel:'preview', updaterCacheDirName:'studio-updater'}))},
  ]));
  const result = JSON.parse(execFileSync(process.execPath, [command, root], {encoding:'utf8'}));
  assert.equal(result.zip, 'studio.zip');
  assert.equal(result.appAsar, 'present-in-zip');
  assert.equal(result.update.channel, 'preview');
  await writeFile(join(root, 'another.zip'), 'ambiguous native candidate');
  await writeFile(join(root, 'another.zip.blockmap'), gzipSync('{}'));
  assert.throws(() => execFileSync(process.execPath, [command, root], {stdio:'pipe'}), /exactly one ZIP\/blockmap pair/);
});
