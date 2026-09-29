import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_PACKAGE = '@kingsoftcloud/agentkit-studio';
const PLUGIN_ID = 'agentkit-studio';
const EXPECTED_DSH = '0.2.0-rc.1';

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function checkInstalledProfile(profileDir, expectedVersion) {
  const root = resolve(profileDir);
  const profile = readJson(resolve(root, 'package.json'), 'profile package.json');
  const dependency = profile.dependencies?.[PLUGIN_PACKAGE];
  if (typeof dependency !== 'string' || dependency.length === 0) {
    throw new Error(`profile dependencies omit ${PLUGIN_PACKAGE}`);
  }
  const bundles = profile.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(PLUGIN_PACKAGE)) {
    throw new Error(`profile bundle list omits ${PLUGIN_PACKAGE}`);
  }

  const pluginRoot = resolve(root, 'node_modules', '@kingsoftcloud', 'agentkit-studio');
  const packageJson = readJson(resolve(pluginRoot, 'package.json'), 'installed plugin package.json');
  const manifest = readJson(resolve(pluginRoot, 'studio.plugin.json'), 'installed plugin manifest');
  if (packageJson.name !== PLUGIN_PACKAGE) {
    throw new Error(`unexpected installed package: ${String(packageJson.name)}`);
  }
  if (packageJson.version !== expectedVersion) {
    throw new Error(`installed plugin version ${String(packageJson.version)} does not match ${expectedVersion}`);
  }
  if (manifest.id !== PLUGIN_ID || manifest.version !== expectedVersion) {
    throw new Error('installed plugin manifest identity/version does not match the release package');
  }
  if (manifest.requiredDsh !== EXPECTED_DSH || manifest.requiredHostApi !== `dsh-native/${EXPECTED_DSH}`) {
    throw new Error(`installed plugin requires an unexpected DSH baseline: ${String(manifest.requiredDsh)}`);
  }
  for (const path of ['dist/client.js', 'src/index.mjs', 'cordis.patch.yml']) {
    if (!existsSync(resolve(pluginRoot, path))) throw new Error(`installed plugin is missing ${path}`);
  }
  return { profile: profile.name, version: packageJson.version, dependency };
}

function main() {
  const profileDir = process.argv[2];
  const expectedVersion = process.argv[3];
  if (!profileDir || !expectedVersion) {
    console.error('usage: node scripts/check-profile.mjs <profile-dir> <expected-version>');
    process.exit(2);
  }
  const result = checkInstalledProfile(profileDir, expectedVersion);
  console.log(`profile integrity: ${result.profile} loads ${PLUGIN_PACKAGE}@${result.version} (${result.dependency})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
