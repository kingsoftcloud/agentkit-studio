/** A signed delivery must contain the same updater destination selected for its build. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export function assertPackagedUpdateSource(contents, { target, origin, channel, environment = 'production', releaseId } = {}) {
  let config;
  try { config = parse(contents); } catch { throw new Error('desktop delivery: invalid app-update.yml'); }
  const prefix = environment === 'test' ? `dsh-desk/${releaseId}` : 'studio';
  const expected = `${origin}/${prefix}/feeds/${target}/`;
  if (!['stable', 'preview'].includes(channel) || !/^https:\/\//.test(origin || '')
    || (environment === 'test' && !/^[a-f0-9]{32}$/.test(releaseId || ''))
    || config?.provider !== 'generic' || config.url !== expected || config.channel !== channel
    || typeof config.updaterCacheDirName !== 'string' || !config.updaterCacheDirName.trim()) {
    throw new Error('desktop delivery: packaged update source does not match the selected Studio feed');
  }
  return { url: config.url, channel: config.channel };
}

export async function verifyPackagedUpdateSource(resources, expected) {
  let contents;
  try { contents = await readFile(join(resources, 'app-update.yml'), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('desktop delivery: app-update.yml is missing; this signed app cannot check for updates');
  }
  return assertPackagedUpdateSource(contents, expected);
}
