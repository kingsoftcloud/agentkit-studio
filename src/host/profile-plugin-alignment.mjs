/** Keep a profile-installed product plugin from shadowing the copy bundled beside dsh. */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/** The product plugin this package owns. */
const PRODUCT_PLUGIN = '@kingsoftcloud/agentkit-studio';
/** Profile file recording consecutive failed alignment attempts for one bundled version. */
const ATTEMPT_MARKER_PREFIX = '.alignment-attempt-';
/** Consecutive failures after which alignment stops trying and the profile copy keeps running. */
export const ALIGNMENT_ATTEMPT_LIMIT = 2;

/** Numeric dotted comparison with prerelease ordering; plugin versions are plain semver. */
export function comparePluginVersions(left, right) {
  const [leftCore = '', leftPre = ''] = String(left).split('-', 2);
  const [rightCore = '', rightPre = ''] = String(right).split('-', 2);
  const leftParts = leftCore.split('.').map(part => Number.parseInt(part, 10) || 0);
  const rightParts = rightCore.split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftValue = leftParts[index] ?? 0, rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  if (leftPre === rightPre) return 0;
  if (leftPre === '') return 1;
  if (rightPre === '') return -1;
  return leftPre < rightPre ? -1 : 1;
}

const manifestOf = directory => {
  try { return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); } catch { return undefined; }
};

const artifactName = (name, version) => `${name.replace(/^@/, '').replace(/[/\\]/g, '-')}-${version}`;

/** Resolve a package directory from an anchor inside the sealed runtime only. */
function resolveRuntimePackage(runtimeDsh, anchor, packageName) {
  const root = runtimeDsh.endsWith(sep) ? runtimeDsh : `${runtimeDsh}${sep}`;
  const require = createRequire(anchor);
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    if (!searchPath.startsWith(root)) continue;
    const candidate = join(searchPath, packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/**
 * Verify the bundled package resolves every declared dependency from the sealed runtime.
 *
 * A copy moved out of the runtime tree loses the `@deepseek-ai/*` packages the
 * installation anchor supplies, which is exactly why the previous mirror broke
 * Host startup. The profile copy is retired only when every declared package
 * answers from the runtime that will resolve it on the next launch.
 * @param {string} runtimeDsh - Sealed dsh runtime directory.
 * @param {string} bundledDir - Runtime-carried plugin directory.
 * @returns {string | undefined} the first unresolved dependency, or undefined.
 */
export function verifyBundledPlugin(runtimeDsh, bundledDir) {
  const manifest = manifestOf(bundledDir);
  if (manifest === undefined) return `unreadable package manifest in ${bundledDir}`;
  const anchor = join(bundledDir, 'package.json');
  const names = [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])];
  for (const name of names) {
    if (resolveRuntimePackage(runtimeDsh, anchor, name) === undefined) return `bundled copy cannot resolve ${name}`;
  }
  return undefined;
}

/** Marker path for one bundled version. */
const markerPath = (profile, version) => join(profile, `${ATTEMPT_MARKER_PREFIX}${version.replace(/[^0-9A-Za-z._-]/g, '-')}`);

const readMarker = (path, version) => {
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    if (marker?.version !== version || !Number.isSafeInteger(marker.failures) || marker.failures < 0
      || typeof marker.reason !== 'string' || typeof marker.updatedAt !== 'string') return undefined;
    return marker;
  } catch { return undefined; }
};

const recordFailure = (path, version, previous, reason) => {
  try {
    writeFileSync(path, `${JSON.stringify({
      version, failures: Math.min((previous?.failures ?? 0) + 1, 255), reason: String(reason).slice(0, 512),
      updatedAt: new Date().toISOString(),
    }, undefined, 2)}\n`, { mode: 0o600 });
  } catch {
    // A profile that cannot record the attempt still must not fail the launch.
  }
};

const clearMarker = path => {
  try { rmSync(path, { force: true }); } catch { /* a stale marker costs one retry */ }
};

/** Move a real directory aside, falling back to a copy across filesystems. */
function moveAside(source, target) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try { renameSync(source, target); } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    cpSync(source, target, { recursive: true });
    rmSync(source, { recursive: true, force: true });
  }
}

/**
 * Locate the Desktop launch triple from the Host argv.
 * The desktop Host starts as `dsh-desktop-host/index.js <dsh> <profile> <primaryRuntime> <pnpm> <nodeBin>`.
 * @param {readonly string[]} argv
 */
function desktopLaunch(argv) {
  const [dsh, profile] = argv.slice(2, 4);
  if (!dsh || !profile) return undefined;
  if (manifestOf(dsh)?.name !== '@deepseek-ai/dsh' || manifestOf(profile) === undefined) return undefined;
  return { dsh, profile };
}

/**
 * Retire the profile copy of this plugin so the Host resolves the bundled one.
 *
 * The Desktop shell loads this plugin through the profile, so a profile pinned to
 * an older published version keeps running stale code after an application
 * upgrade. The bundled copy lives inside the signed runtime (inside `app.asar` on
 * macOS) and cannot be copied out without losing the `@deepseek-ai/*` packages the
 * installation anchor supplies — the previous mirror did exactly that and broke
 * Host startup. Alignment therefore removes the shadowing profile dependency and
 * its `node_modules` entry; the Host then resolves the bundled copy from the
 * installation like every other in-box bundle. Module resolution already happened
 * for this launch, so the change applies on the NEXT launch.
 *
 * A retired copy is moved to `$DSH_HOME/backups/agentkit-studio`; a failed rewrite
 * restores it, and two consecutive failures for one bundled version stop further
 * attempts so the old plugin keeps starting.
 *
 * @param {{ argv?: readonly string[], env?: Record<string, string | undefined>, log?: { info: Function, warn: Function }, now?: () => number }} [options]
 * @returns {{ action: string, applied?: string, previousVersion?: string, bundledVersion?: string, backupPath?: string, reason?: string }}
 */
export function alignProfileProductPlugin({ argv = process.argv, env = process.env, log = console, now = Date.now } = {}) {
  try {
    const launch = desktopLaunch(argv);
    if (launch === undefined) return { action: 'not-desktop-host' };
    const bundledDir = join(launch.dsh, 'node_modules', PRODUCT_PLUGIN);
    const bundledVersion = manifestOf(bundledDir)?.version;
    if (bundledVersion === undefined) return { action: 'missing-bundled-copy' };
    const installedDir = join(launch.profile, 'node_modules', PRODUCT_PLUGIN);
    const previousVersion = manifestOf(installedDir)?.version;
    if (previousVersion === undefined) return { action: 'skipped-absent', bundledVersion };
    const profileManifest = manifestOf(launch.profile) ?? {};
    const spec = profileManifest.dependencies?.[PRODUCT_PLUGIN];
    if (typeof spec !== 'string') return { action: 'skipped-absent', bundledVersion };
    if (!spec.startsWith('file:') && comparePluginVersions(previousVersion, bundledVersion) > 0) {
      log.warn('[studio] profile alignment: profile copy is newer than the bundled runtime', { previousVersion, bundledVersion });
      return { action: 'kept-newer', previousVersion, bundledVersion };
    }

    const marker = markerPath(launch.profile, bundledVersion);
    const previousFailure = readMarker(marker, bundledVersion);
    if ((previousFailure?.failures ?? 0) >= ALIGNMENT_ATTEMPT_LIMIT) {
      return {
        action: 'skipped-attempt-budget', previousVersion, bundledVersion,
        reason: `alignment failed ${String(previousFailure?.failures)} times for ${bundledVersion}`,
      };
    }
    const verification = verifyBundledPlugin(launch.dsh, bundledDir);
    if (verification !== undefined) {
      recordFailure(marker, bundledVersion, previousFailure, verification);
      log.warn('[studio] profile alignment: keeping the profile copy', { reason: verification });
      return { action: 'restored', previousVersion, bundledVersion, reason: verification };
    }

    const original = readFileSync(join(launch.profile, 'package.json'), 'utf8');
    const dependencies = { ...(profileManifest.dependencies ?? {}) };
    delete dependencies[PRODUCT_PLUGIN];
    const next = `${JSON.stringify({ ...profileManifest, dependencies }, undefined, 2)}\n`;
    const dshHome = String(env.DSH_HOME || join(homedir(), '.dsh')).replace(/^~(?=\/|$)/, homedir());
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const backupPath = join(dshHome, 'backups', 'agentkit-studio', `${artifactName(PRODUCT_PLUGIN, previousVersion)}-${stamp}`);
    let moved = false;
    try {
      moveAside(installedDir, backupPath);
      moved = true;
      writeFileSync(join(launch.profile, 'package.json'), next, { mode: 0o600 });
      if (existsSync(join(installedDir, 'package.json'))) {
        throw new Error('profile still contains the retired plugin copy');
      }
    } catch (error) {
      try { writeFileSync(join(launch.profile, 'package.json'), original, { mode: 0o600 }); } catch { /* unchanged */ }
      if (moved) {
        try { moveAside(backupPath, installedDir); } catch { /* keep the backup */ }
      }
      const reason = error instanceof Error ? error.message : String(error);
      recordFailure(marker, bundledVersion, previousFailure, reason);
      log.warn('[studio] profile alignment: restored the profile copy', { reason });
      return { action: 'restored', previousVersion, bundledVersion, reason };
    }
    clearMarker(marker);
    const result = { action: 'retired', applied: 'next-launch', previousVersion, bundledVersion, backupPath };
    log.info('[studio] profile alignment: retired the profile copy in favour of the bundled runtime copy', result);
    return result;
  } catch (error) {
    // Alignment is best-effort: the Host already loaded its plugin and must keep serving.
    log.warn('[studio] profile alignment: skipped', { message: error instanceof Error ? error.message : String(error) });
    return { action: 'restored', reason: error instanceof Error ? error.message : String(error) };
  }
}
