/** Keep the profile-installed product plugin selected and loadable; never retire it. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';

/** The product plugin this package owns. */
const PRODUCT_PLUGIN = '@kingsoftcloud/agentkit-studio';
/** Profile file recording consecutive failed alignment attempts for one bundled version. */
const ATTEMPT_MARKER_PREFIX = '.alignment-attempt-';
/** Consecutive failures after which alignment stops trying and the profile keeps running. */
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

/** Dependency and peer names a resolvable package must supply. */
const dependencyNames = manifest => [...new Set([
  ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}),
])];

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
 * Verify the bundled plugin resolves every declared dependency from the sealed runtime.
 * @param {string} runtimeDsh - Sealed dsh runtime directory.
 * @param {string} bundledDir - Runtime-carried plugin directory.
 * @returns {string | undefined} the first unresolved dependency, or undefined.
 */
export function verifyBundledPlugin(runtimeDsh, bundledDir) {
  const manifest = manifestOf(bundledDir);
  if (manifest === undefined) return `unreadable package manifest in ${bundledDir}`;
  const anchor = join(bundledDir, 'package.json');
  for (const name of dependencyNames(manifest)) {
    if (resolveRuntimePackage(runtimeDsh, anchor, name) === undefined) return `bundled copy cannot resolve ${name}`;
  }
  return undefined;
}

/** Relative entry files the package declares through `exports` or `main`. */
function entryFiles(manifest) {
  const files = [];
  const collect = value => {
    if (typeof value === 'string') { if (value.startsWith('./')) files.push(value); return; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    for (const nested of Object.values(value)) collect(nested);
  };
  collect(manifest.exports);
  if (typeof manifest.main === 'string' && manifest.main.startsWith('./')) files.push(manifest.main);
  return [...new Set(files)];
}

/**
 * Verify the profile copy is loadable, not merely present.
 *
 * Installation-owned `@deepseek-ai/*` packages answer from the sealed runtime's
 * own anchor, never from the profile, so they are not required here. Every other
 * declared dependency must resolve from the copy and every relative export the
 * manifest names must exist.
 * @param {string} directory - Profile copy of the product plugin.
 * @returns {string | undefined} the first loadability failure, or undefined.
 */
export function verifyProfilePlugin(directory) {
  const manifest = manifestOf(directory);
  if (manifest === undefined) return `unreadable package manifest in ${directory}`;
  const require = createRequire(join(directory, 'package.json'));
  for (const name of dependencyNames(manifest)) {
    if (name.startsWith('@deepseek-ai/')) continue;
    try { require.resolve(name); } catch { return `profile copy cannot resolve ${name}`; }
  }
  for (const entry of entryFiles(manifest)) {
    if (!existsSync(join(directory, entry))) return `profile copy is missing ${entry}`;
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
 * Make sure the profile selects the product bundle, inserting it after the Web app.
 *
 * The Host selects a profile plugin only through `dsh.profile.bundles`. Native
 * recovery writes the list back to the shipped template, and the Desktop shell's
 * activation history then suppresses its own re-add, so a profile can keep the
 * plugin installed yet never load it. Repairing the list keeps a running
 * installation selected without touching the copy.
 * @param {string} profile - Profile directory.
 * @param {string} [packageName] - Bundle to select; defaults to this product plugin.
 * @returns {boolean} whether the manifest changed.
 */
export function ensureProfileBundle(profile, packageName = PRODUCT_PLUGIN) {
  const path = join(profile, 'package.json');
  const original = readFileSync(path, 'utf8');
  const manifest = JSON.parse(original);
  const dsh = { ...(manifest.dsh ?? {}) };
  const section = { ...(dsh.profile ?? {}) };
  const bundles = Array.isArray(section.bundles) ? [...section.bundles] : [];
  if (bundles.includes(packageName)) return false;
  const anchor = bundles.indexOf('@deepseek-ai/dsh-web-app');
  bundles.splice(anchor < 0 ? bundles.length : anchor + 1, 0, packageName);
  section.bundles = bundles;
  dsh.profile = section;
  manifest.dsh = dsh;
  writeFileSync(path, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 });
  return true;
}

/**
 * Keep the profile product plugin selected and loadable.
 *
 * Patch 071 retired the profile copy so the Host would fall back to the sealed
 * runtime copy. Bundle selection has no such fallback: the Host loads a profile
 * bundle only when `dsh.profile.bundles` lists it, so a retired copy left the
 * product plugin out of the running interface. Alignment therefore never deletes:
 * it repairs the bundle selection, verifies the copy is loadable, and leaves an
 * unloadable copy exactly where it was for the Desktop shell to materialize
 * before the next launch. Two consecutive failures for one bundled version stop
 * further attempts so an unfixable profile still starts.
 *
 * @param {{ argv?: readonly string[], env?: Record<string, string | undefined>, log?: { info: Function, warn: Function }, now?: () => number }} [options]
 * @returns {{ action: string, applied?: string, previousVersion?: string, bundledVersion?: string, reason?: string }}
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
    const repaired = ensureProfileBundle(launch.profile, PRODUCT_PLUGIN);
    if (previousVersion === undefined) {
      // Nothing to keep: the Desktop shell materializes the bundled copy before it
      // starts the Host, so an absent copy here means the Host is already running.
      return { action: repaired ? 'repaired-selection' : 'skipped-absent', bundledVersion, applied: 'next-launch' };
    }
    const manifest = manifestOf(launch.profile) ?? {};
    const spec = manifest.dependencies?.[PRODUCT_PLUGIN];
    if (typeof spec !== 'string') {
      return { action: repaired ? 'repaired-selection' : 'skipped-absent', previousVersion, bundledVersion };
    }
    if (!spec.startsWith('file:') && comparePluginVersions(previousVersion, bundledVersion) > 0) {
      log.info('[studio] profile alignment: keeping the newer profile copy', { previousVersion, bundledVersion });
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
    const verification = verifyProfilePlugin(installedDir);
    if (verification !== undefined) {
      recordFailure(marker, bundledVersion, previousFailure, verification);
      log.warn('[studio] profile alignment: keeping the existing profile copy', { reason: verification });
      return { action: 'restored', previousVersion, bundledVersion, reason: verification };
    }
    clearMarker(marker);
    return {
      action: repaired ? 'repaired-selection' : 'current', previousVersion, bundledVersion,
      ...repaired ? { applied: 'next-launch' } : {},
    };
  } catch (error) {
    // Alignment is best-effort: the Host already loaded its plugin and must keep serving.
    log.warn('[studio] profile alignment: skipped', { message: error instanceof Error ? error.message : String(error) });
    return { action: 'restored', reason: error instanceof Error ? error.message : String(error) };
  }
}
