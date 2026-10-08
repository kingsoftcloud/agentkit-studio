/** Export only committed Studio and pinned, patched DSH sources for Linux builders. */
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDesktopCheckout } from './desktop-checkout.mjs';

const execute = promisify(execFile);
const git = async (cwd, args) => (await execute('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
const identity = async path => { const bytes = await readFile(path); return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; };

export async function stageRuntimeSources({ studio, source, output, commit, dshVersion }) {
  studio = resolve(studio); output = resolve(output);
  if (await git(studio, ['diff', 'HEAD', '--name-only'])) throw new Error('runtime sources: commit tracked Studio changes before staging');
  const studioCommit = await git(studio, ['rev-parse', 'HEAD']);
  await mkdir(dirname(output), { recursive: true });
  // Never destroy another build or expose an incomplete input set as ready.
  await mkdir(output, { mode: 0o700 });
  const unpacked = join(output, 'studio');
  try {
    await git(studio, ['archive', '--format=tar', `--output=${join(output, 'studio-source.tar')}`, studioCommit]);
    await mkdir(unpacked);
    await execute('tar', ['-xf', join(output, 'studio-source.tar'), '-C', unpacked]);
    const studioPackage = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'));
    const compatibility = JSON.parse(await readFile(join(unpacked, 'studio.plugin.json'), 'utf8'));
    if (compatibility.requiredDsh !== dshVersion) throw new Error('runtime sources: DSH version disagrees with committed Studio manifest');
    let dshTree;
    await withDesktopCheckout({ source, output: join(dirname(output), '.runtime-source-cache'), patches: join(unpacked, 'patches', `dsh-v${dshVersion}`), commit }, async checkout => {
      const dshPackage = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'));
      if (dshPackage.version !== dshVersion) throw new Error('runtime sources: pinned DSH version mismatch');
      dshTree = await git(checkout, ['write-tree']);
      await git(checkout, ['archive', '--format=tar', `--output=${join(output, 'dsh-source.tar')}`, dshTree]);
    });
    const manifest = { format: 'agentkit.runtime-sources/v1', studio: { commit: studioCommit, version: studioPackage.version },
      dsh: { commit, version: dshVersion, patchedTree: dshTree },
      inputs: { 'studio-source.tar': await identity(join(output, 'studio-source.tar')), 'dsh-source.tar': await identity(join(output, 'dsh-source.tar')) } };
    await rm(unpacked, { recursive: true });
    await writeFile(join(output, 'runtime-sources.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['studio', 'source', 'output', 'commit', 'dsh-version'].map(name => [name, { type: 'string' }])) });
  if (Object.keys(values).length !== 5) throw new Error('Usage: stage-runtime-sources.mjs --studio STUDIO --source DSH --output NEW_DIRECTORY --commit PINNED_DSH_COMMIT --dsh-version DSH_VERSION');
  console.log(JSON.stringify(await stageRuntimeSources({ ...values, dshVersion: values['dsh-version'] }), null, 2));
}
