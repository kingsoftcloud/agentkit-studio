/** Bundles Studio switches on for every profile.
 *
 * DSH ships two kinds of optional bundle: `OPTIONAL_BUNDLES` (installed with
 * the product, switched off until a person enables them) and `ON_DEMAND_BUNDLES`
 * (installed through the ordinary bundle installer). Studio wants both of the
 * bundles below on by default, so the first Host start of a DSH version enables
 * the shipped one and installs the on-demand one.
 *
 * Applying once per DSH version is what keeps this from fighting the user: a
 * person who switches a default bundle off keeps it off until the next product
 * upgrade, and the marker file records what was applied. A failure that could
 * succeed later (network, pnpm) leaves no marker, so the next start retries; a
 * bundle the installation does not carry is recorded and not retried.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Bundles Studio enables on the first run of a given DSH version. */
export const DEFAULT_ENABLED_BUNDLES = Object.freeze([
  // The official plugin index: the market and the Discover tab both come from it.
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
  // Computer Use (CUA): background clicks, typing and scrolling. macOS today.
  '@deepseek-ai/dsh-cua-bundle',
]);

const MARKER_FILE = 'default-bundles.json';

/** Operator escape hatch: `AGENTKIT_STUDIO_DEFAULT_BUNDLES=0` keeps the profile untouched. */
export function defaultBundlesDisabled(env = process.env) {
  return /^(?:0|false|no|off)$/iu.test(String(env?.AGENTKIT_STUDIO_DEFAULT_BUNDLES ?? '').trim());
}

async function readMarker(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeMarker(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Enable (and, for on-demand bundles, install) Studio's default bundles.
 *
 * @param {object} options
 * @param {object} options.manager - The Host's `pluginManager` service.
 * @param {string} options.storeDir - Studio state directory for the applied marker.
 * @param {string} options.version - DSH version the defaults belong to.
 * @param {object} [options.env] - Environment carrying the opt-out.
 * @param {(message: string) => void} [options.log] - Sink for one line per bundle.
 * @param {() => Promise<boolean>} [options.profileConfigured] - Whether the profile has a model configured yet.
 * @returns {Promise<{applied: boolean, reason: string, enabled: string[], failed: object[]}>}
 */
export async function applyDefaultBundles({ manager, storeDir, version, env = process.env, log = () => {}, profileConfigured } = {}) {
  if (!manager || typeof manager.listBundles !== 'function') {
    return { applied: false, reason: 'plugin-manager-unavailable', enabled: [], failed: [] };
  }
  if (typeof version !== 'string' || !version.trim()) {
    return { applied: false, reason: 'version-unavailable', enabled: [], failed: [] };
  }
  if (!storeDir) return { applied: false, reason: 'store-unavailable', enabled: [], failed: [] };
  if (defaultBundlesDisabled(env)) return { applied: false, reason: 'disabled-by-environment', enabled: [], failed: [] };
  // A profile the person has not configured yet is being onboarded right now, and
  // the first-run form saves the same `package.json` this alignment rewrites. An
  // on-demand install holds the profile writer lock for the whole pnpm run, so
  // aligning first makes the very first save fail with a lock timeout. Leave the
  // profile untouched until it has a model; the marker is not written, so the
  // next start aligns as usual.
  if (typeof profileConfigured === 'function' && !await profileConfigured()) {
    return { applied: false, reason: 'profile-not-configured', enabled: [], failed: [] };
  }

  const markerFile = join(storeDir, MARKER_FILE);
  const marker = await readMarker(markerFile);
  if (marker?.appliedVersion === version) {
    return { applied: false, reason: 'already-applied', enabled: [], failed: [] };
  }

  const bundles = await manager.listBundles();
  const byName = new Map((Array.isArray(bundles) ? bundles : []).map(bundle => [String(bundle?.name || ''), bundle]));
  const enabled = [];
  const failed = [];
  for (const name of DEFAULT_ENABLED_BUNDLES) {
    const bundle = byName.get(name);
    if (!bundle) {
      // The installation does not carry it (older DSH); nothing to retry.
      failed.push({ name, reason: 'not-shipped' });
      continue;
    }
    if (bundle.enabled !== false) continue;
    try {
      const spec = String(bundle.installTarget?.spec || '');
      if (bundle.availability === 'missing' && spec) {
        await manager.installBundle(spec, { enabled: true, saveExact: true });
      } else {
        await manager.setBundleEnabled(name, true);
      }
      enabled.push(name);
      log(`[studio] enabled default bundle ${name}`);
    } catch (error) {
      const reason = String(error?.message || error).slice(0, 200);
      failed.push({ name, reason });
      log(`[studio] could not enable default bundle ${name}: ${reason}`);
    }
  }

  // A retryable failure leaves no marker, so the next start tries again.
  if (!failed.some(entry => entry.reason !== 'not-shipped')) {
    await writeMarker(markerFile, { appliedVersion: version, enabled, failed });
  }
  return { applied: true, reason: 'applied', enabled, failed };
}
