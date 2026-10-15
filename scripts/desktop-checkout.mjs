/** Keep official release rebuilds away from the source checkout serving the development UI. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { fingerprintPatchedSource } from './patched-source-fingerprint.mjs';
import { checkBoundMaintenanceSource } from './dsh-maintenance-source.mjs';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const git = async (cwd, args) => {
  try { return (await execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch (error) {
    // Report the operation without leaking paths, remotes or arbitrary Git output.
    error.desktopCheckout = { operation: args[0], reason: /filename too long/i.test(error.stderr || '') ? 'path-too-long' : 'git-command-failed' };
    throw error;
  }
};

async function identify({ source, output, patches, commit }) {
  const sourceRoot = await realpath(source);
  if (!/^[0-9a-f]{40}$/.test(commit || '') || await git(sourceRoot,['rev-parse','HEAD']) !== commit) throw new Error('desktop checkout: source baseline does not match the pinned commit');
  await mkdir(output,{recursive:true,mode:0o700});
  const outputRoot = await realpath(output);
  const nested = relative(sourceRoot,outputRoot);
  if (!nested || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested))) throw new Error('desktop checkout: output must be outside the live source checkout');
  const patchRoot = await realpath(patches);
  const names = (await readdir(patchRoot)).filter(name=>name.endsWith('.patch')).sort();
  if (!names.length) throw new Error('desktop checkout: empty patch series');
  // Read once: applying the bytes used for the identity avoids an edit racing the snapshot.
  const series = await Promise.all(names.map(async name=>({name,bytes:await readFile(join(patchRoot,name))})));
  const maintenanceSource = await checkBoundMaintenanceSource({ patches: patchRoot, source: sourceRoot,
    files: new Map(series.map(({ name, bytes }) => [name, bytes])) });
  const hash = createHash('sha256').update(commit);
  for (const entry of series) hash.update(entry.name).update('\0').update(entry.bytes);
  const directory = join(outputRoot,'desktop-checkouts',hash.digest('hex').slice(0,24));
  return {sourceRoot,commit,series,directory,checkout:join(directory,'source'),maintenanceSource};
}

async function sourceDigest(checkout) {
  if (await git(checkout,['ls-files','--others','--exclude-standard'])) throw new Error('desktop checkout: cached source was modified; preserve edits and remove the cache explicitly');
  return fingerprintPatchedSource(checkout);
}

async function prepare(input) {
  const {directory,checkout,sourceRoot,commit,series} = input;
  let record;
  try { record = JSON.parse(await readFile(join(directory,'snapshot.json'),'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('desktop checkout: invalid cache record'); }
  if (record) {
    if (await git(checkout,['rev-parse','HEAD']) !== commit) throw new Error('desktop checkout: cached source was modified; preserve edits and remove the cache explicitly');
    if (record.schemaVersion !== 2) {
      if (record.schemaVersion !== undefined || typeof record.digest !== 'string' || digest(await git(checkout,['diff','HEAD','--binary'])) !== record.digest) throw new Error('desktop checkout: legacy cache cannot be verified; preserve it and use a new output directory');
    }
    const fingerprint = await sourceDigest(checkout);
    if (record.schemaVersion === 2) {
      if (fingerprint.tree !== record.source?.tree || fingerprint.sha256 !== record.source?.sha256) throw new Error('desktop checkout: cached source was modified; preserve edits and remove the cache explicitly');
    } else {
      // Only migrate a legacy cache after its original guard still verifies it.
      // A mismatch never resets the source or trusts a newly computed fingerprint.
      const next = join(directory, 'snapshot.next.json');
      await writeFile(next, JSON.stringify({ schemaVersion: 2, commit, source: fingerprint }), { mode: 0o600 });
      await rename(next, join(directory, 'snapshot.json'));
    }
    return checkout;
  }
  const staging = await mkdtemp(join(directory,'preparing-'));
  try {
    const destination = join(staging,'source');
    await git(directory,['clone','--shared','--no-checkout','--config','core.autocrlf=false','--config','core.longpaths=true','--',sourceRoot,destination]);
    await git(destination,['checkout','--detach',commit]);
    for (const entry of series) {
      const patch = join(staging,entry.name);
      await writeFile(patch,entry.bytes,{mode:0o600});
      await git(destination,['apply','--index',patch]);
    }
    const fingerprint = await sourceDigest(destination);
    await rename(destination,checkout);
    await writeFile(join(directory,'snapshot.json'),JSON.stringify({schemaVersion:2,commit,source:fingerprint}),{mode:0o600,flag:'wx'});
    return checkout;
  } finally { await rm(staging,{recursive:true,force:true}); }
}

/** Serialize preparation and packaging; never reset a checkout or share its node_modules. */
export async function withDesktopCheckout(options, action) {
  const input = await identify(options);
  await mkdir(input.directory,{recursive:true,mode:0o700});
  const lock = join(input.directory,'active.lock');
  try { await mkdir(lock); }
  catch(error) { if(error.code==='EEXIST') throw new Error(`desktop checkout: already in use; inspect ${lock} before retrying`); throw error; }
  try {
    await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{mode:0o600});
    return await action(await prepare(input), { maintenanceSource: input.maintenanceSource });
  } finally { await rm(lock,{recursive:true,force:true}); }
}

export async function prepareDesktopCheckout(options) {
  return withDesktopCheckout(options, async checkout=>checkout);
}
