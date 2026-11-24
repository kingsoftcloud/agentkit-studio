import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createStarHarnessReleases, startStarHarness, starHarnessError, starHarnessVersion } from './host/services/star-harness-release.mjs';
import { atomicPrivate, lockUntil, readAll } from './host/private-state.mjs';
import { privateRuntimeDirectory } from './runtime-host-installation.mjs';

function savedSelection(path) {
  try {
    const { version } = JSON.parse(readAll(path));
    if (starHarnessVersion(version)) return version;
    throw Error('Invalid release selection');
  } catch (cause) {
    if (cause.code === 'ENOENT') return undefined;
    throw starHarnessError('STAR_HARNESS_SELECTION_INVALID', '无法读取此部署使用的 Star Harness 版本。', { cause });
  }
}

export async function startInstalledStarHarness({ releaseVersion, installerEnv, ...options },
  { createReleases = createStarHarnessReleases, start = startStarHarness } = {}) {
  if (releaseVersion !== undefined && !starHarnessVersion(releaseVersion))
    throw starHarnessError('STAR_HARNESS_RELEASE_INVALID', 'Star Harness 版本无效。');
  const directory = await privateRuntimeDirectory(join(dirname(options.stateDir), 'star-harness-releases'));
  const selection = join(directory, 'selected-release.json');
  const releaseLock = await lockUntil(join(directory, '.selection.sqlite'), performance.now() + 240000, options.signal);
  try {
    const recorded = savedSelection(selection);
    const releases = createReleases({ directory, env: installerEnv ?? options.env });
    let version = releaseVersion ?? recorded;
    let packageDirectory;
    if (!version) {
      // A deployment that already installed a signed plugin can migrate
      // its selection without downloading again after the Studio upgrade.
      const local = (await readdir(directory, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && starHarnessVersion(entry.name))
        .map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      for (const candidate of local) {
        options.signal?.throwIfAborted();
        try { packageDirectory = await releases.entry(candidate); version = candidate; break; }
        catch (error) { if (!['ENOENT', 'STAR_HARNESS_RELEASE_INVALID'].includes(error.code)) throw error; }
      }
    }
    if (!version) {
      try { version = await releases.latest(options.signal); }
      catch (cause) {
        options.signal?.throwIfAborted();
        throw starHarnessError('STAR_HARNESS_RELEASE_UNAVAILABLE', '首次启动需要预装签名的 Star Harness 或连接发行渠道。', { cause });
      }
      if (!version) throw starHarnessError('STAR_HARNESS_RELEASE_UNAVAILABLE', '发行渠道未提供兼容的签名 Star Harness。');
    }
    options.signal?.throwIfAborted();
    packageDirectory ??= await releases.install(version, options.signal);
    const worker = await start({ ...options, packageDirectory, version });
    try {
      options.signal?.throwIfAborted();
      if (recorded !== version) atomicPrivate(selection, JSON.stringify({ version }) + '\n');
      return worker;
    } catch (error) {
      await worker.stop();
      throw error;
    }
  } finally { releaseLock(); }
}
