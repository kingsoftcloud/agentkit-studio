/** Keep the profile-installed product plugin aligned with the bundled runtime copy. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';

/** The product plugin this package owns. */
const PRODUCT_PLUGIN = '@kingsoftcloud/agentkit-studio';

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

/**
 * Locate the Desktop launch triple from the Host argv.
 * The desktop Host starts as `dsh-desktop-host/index.js <dsh> <profile> <primaryRuntime> <pnpm> <nodeBin>`.
 * @param {readonly string[]} argv
 */
function desktopLaunch(argv) {
  const [dsh, profile, , pnpm, nodeBin] = argv.slice(2, 7);
  if (!dsh || !profile || !pnpm || !nodeBin) return undefined;
  const dshManifest = manifestOf(dsh);
  if (dshManifest?.name !== '@deepseek-ai/dsh' || !manifestOf(profile)) return undefined;
  return { dsh, profile, pnpm, nodeBin };
}

/** Run the bundled package manager so the profile lockfile follows the rewritten dependency. */
function installProfile({ pnpm, nodeBin, profile }, node, log) {
  const result = spawnSync(node, ['--expose-internals', pnpm, 'install', '--prefer-offline'], {
    cwd: profile, stdio: 'ignore', timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: node,
      PATH: `${nodeBin}${delimiter}${process.env.PATH ?? ''}` },
  });
  if (result.status !== 0) log.warn('[studio] profile alignment: package manager did not complete');
  return result.status === 0;
}

/**
 * Align the profile copy of this plugin with the copy bundled beside dsh.
 *
 * The Desktop shell resolves `@kingsoftcloud/agentkit-studio` through the plugin
 * profile, so a profile pinned to an older published version keeps running stale
 * code after an application upgrade. Alignment rewrites the profile dependency to
 * a `file:` mirror of the bundled copy and installs it; because module resolution
 * happens before this Host starts, the new version is used on the NEXT launch.
 * Idempotent: equal versions do nothing, and a newer profile copy is preserved.
 *
 * @param {{ argv?: readonly string[], env?: Record<string, string | undefined>, node?: string, log?: { info: Function, warn: Function }, now?: () => number }} [options]
 * @returns {{ action: string, applied?: string, previousVersion?: string, bundledVersion?: string, backupPath?: string, mirrorPath?: string }}
 */
export function alignProfileProductPlugin({ argv = process.argv, env = process.env, node = process.execPath,
  log = console, now = Date.now } = {}) {
  const launch = desktopLaunch(argv);
  if (launch === undefined) return { action: 'not-desktop-host' };
  const bundledDir = join(launch.dsh, 'node_modules', PRODUCT_PLUGIN);
  const bundledVersion = manifestOf(bundledDir)?.version;
  if (bundledVersion === undefined) return { action: 'missing-bundled-copy' };
  const installedDir = join(launch.profile, 'node_modules', PRODUCT_PLUGIN);
  const previousVersion = manifestOf(installedDir)?.version;
  const comparison = previousVersion === undefined ? -1 : comparePluginVersions(previousVersion, bundledVersion);
  if (comparison === 0) return { action: 'skipped-equal', previousVersion, bundledVersion };
  if (comparison > 0) {
    log.warn('[studio] profile alignment: profile copy is newer than the bundled runtime', { previousVersion, bundledVersion });
    return { action: 'kept-newer', previousVersion, bundledVersion };
  }

  const dshHome = String(env.DSH_HOME || join(homedir(), '.dsh')).replace(/^~(?=\/|$)/, homedir());
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const backupPath = previousVersion === undefined
    ? undefined
    : join(dshHome, 'backups', 'agentkit-studio', `${artifactName(PRODUCT_PLUGIN, previousVersion)}-${stamp}`);
  if (backupPath !== undefined && existsSync(installedDir)) {
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    cpSync(installedDir, backupPath, { recursive: true });
  }
  const mirrorPath = join(dshHome, 'bundled-plugins', artifactName(PRODUCT_PLUGIN, bundledVersion));
  if (!existsSync(mirrorPath)) {
    mkdirSync(dirname(mirrorPath), { recursive: true, mode: 0o700 });
    cpSync(bundledDir, mirrorPath, { recursive: true });
  }
  const profileManifest = manifestOf(launch.profile) ?? {};
  const dependencies = { ...(profileManifest.dependencies ?? {}), [PRODUCT_PLUGIN]: `file:${relative(launch.profile, mirrorPath)}` };
  writeFileSync(join(launch.profile, 'package.json'), `${JSON.stringify({ ...profileManifest, dependencies }, undefined, 2)}\n`, { mode: 0o600 });
  // Mirror first: the next launch then resolves the bundled copy even if the
  // package manager cannot run (offline, policy denial, or a busy profile).
  rmSync(installedDir, { recursive: true, force: true });
  cpSync(mirrorPath, installedDir, { recursive: true });
  const installed = installProfile(launch, node, log);
  const result = { action: 'aligned', applied: 'next-launch', previousVersion, bundledVersion, backupPath, mirrorPath };
  log.info('[studio] profile alignment: bundled plugin mirrored into the profile', { ...result, installed });
  return result;
}
