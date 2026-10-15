/** Public product inputs only. Signing credentials remain in platform-owned dotenv files. */
import product from '../src/product.json' with { type: 'json' };
import legacyWorkflowProduct from '../src/legacy-workflow-product.json' with { type: 'json' };
import { resolveProductCopy } from '../src/product-copy.mjs';
import { AGENTKIT_STUDIO_MARK_SVG } from '../src/brand.js';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const packageName = /^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;
const invalid = () => { throw new Error('product configuration: invalid public product inputs'); };
function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid();
  return url.origin;
}
function assetPath(value, directory) {
  if (typeof value !== 'string' || value.includes('\\') || /[\0\r\n]/.test(value) || isAbsolute(value)) invalid();
  const path = resolve(directory, value), child = relative(directory, path);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) invalid();
  return path;
}

export function resolveProductInputs({ target, dshVersion, buildVersion, pluginVersion: requestedPluginVersion, updateOrigin, updateChannel, updateEnvironment, configuration = product, directory = root } = {}) {
  const { brand, desktop, versionSources } = configuration;
  if (configuration.schemaVersion !== 1 || !brand || !desktop || !versionSources) invalid();
  if (![brand.name, brand.shortName].every(value => typeof value === 'string' && /^[A-Za-z0-9 ._-]+$/.test(value))) invalid();
  if (versionSources.plugin !== 'package.json#version' || versionSources.desktop !== 'explicit-build-version-or-dsh-version') invalid();
  if (!/^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/.test(desktop.appId || '')) invalid();
  for (const entries of [desktop.pluginRoots, desktop.defaultBundles]) if (!Array.isArray(entries) || !entries.length || entries.some(value => typeof value !== 'string' || !packageName.test(value)) || new Set(entries).size !== entries.length) invalid();
  const pluginVersion = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).version;
  if (requestedPluginVersion !== undefined && requestedPluginVersion !== pluginVersion) invalid();
  const desktopVersion = buildVersion ?? dshVersion;
  if (!semver.test(pluginVersion) || (desktopVersion !== undefined && !semver.test(desktopVersion))) invalid();
  const origin = publicOrigin(updateOrigin ?? desktop.updates?.origin);
  const channel = updateChannel ?? desktop.updates?.channel;
  const environment = updateEnvironment ?? desktop.updates?.environment;
  if (!['stable', 'preview'].includes(channel) || !['production', 'test'].includes(environment)) invalid();
  const platforms = {};
  for (const platform of ['mac-arm64', 'mac-x64', 'win-x64']) {
    const inputs = desktop.platforms?.[platform];
    if (!inputs) invalid();
    platforms[platform] = { icon: assetPath(inputs.icon, directory), trayIcon: assetPath(inputs.trayIcon, directory) };
  }
  if (target !== undefined && !Object.hasOwn(platforms, target)) invalid();
  return {
    name: brand.name, shortName: brand.shortName, pluginVersion, desktopVersion,
    appId: desktop.appId, platforms,
    environment: {
      DSH_CLIENT_TITLE: brand.name,
      DSH_CLIENT_LOCALE_OVERRIDES: JSON.stringify(resolveProductCopy(configuration)),
      DSH_CLIENT_BRAND_MARK_URL: `data:image/svg+xml,${encodeURIComponent(AGENTKIT_STUDIO_MARK_SVG.replaceAll(product.brand.name, brand.name))}`,
      DSH_DESKTOP_PLUGIN_ROOTS: desktop.pluginRoots.join(','),
      DSH_DESKTOP_PLUGIN_BUNDLES: desktop.defaultBundles.join(','),
      ...(target === undefined ? {} : { DSH_DESKTOP_PRODUCT_ICON: platforms[target].icon, DSH_DESKTOP_PRODUCT_TRAY_ICON: platforms[target].trayIcon }),
    },
    settings: {
      DSH_DESKTOP_APP_ID: desktop.appId,
      DSH_DESKTOP_AUTO_UPDATE_ENV: environment,
      DSH_DESKTOP_UPDATE_ORIGIN: origin,
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: origin,
      DSH_DESKTOP_UPDATE_CHANNEL: channel,
    },
  };
}

/** Normalize workflow inputs before signing or publication credentials are loaded. */
export function resolveWorkflowProductOutputs(values = {}, { directory = root, configuration = product } = {}) {
  const dshVersion = JSON.parse(readFileSync(resolve(directory, 'studio.plugin.json'), 'utf8')).requiredDsh;
  const inputs = resolveProductInputs({ dshVersion, buildVersion: values.buildVersion || undefined,
    updateOrigin: values.updateOrigin || undefined, updateChannel: values.channel || undefined, directory, configuration });
  return {
    name: inputs.name, app_id: inputs.appId, plugin_version: inputs.pluginVersion, build_version: inputs.desktopVersion,
    channel: inputs.settings.DSH_DESKTOP_UPDATE_CHANNEL, update_origin: inputs.settings.DSH_DESKTOP_UPDATE_ORIGIN,
    storage_origin: publicOrigin(values.storageOrigin || inputs.settings.DSH_DESKTOP_UPDATE_ORIGIN),
    update_environment: inputs.settings.DSH_DESKTOP_AUTO_UPDATE_ENV,
    plugin_roots: inputs.environment.DSH_DESKTOP_PLUGIN_ROOTS, plugin_bundles: inputs.environment.DSH_DESKTOP_PLUGIN_BUNDLES,
    windows_icon: configuration.desktop.platforms['win-x64'].icon, windows_tray_icon: configuration.desktop.platforms['win-x64'].trayIcon,
  };
}

/** Read public settings from the qualified App source; legacy candidates require their original explicit release inputs. */
export function resolveWorkflowSourceOutputs(directory, values = {}) {
  const source = resolve(directory);
  const metadata = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
  if (metadata.name !== JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).name) invalid();
  let configuration, hasConfiguration = true;
  try { configuration = JSON.parse(readFileSync(resolve(source, 'src/product.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; hasConfiguration = false; }
  if (hasConfiguration) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) invalid();
    return { ...resolveWorkflowProductOutputs(values, { directory: source, configuration }), product_definition: 'source' };
  }
  if (!legacyWorkflowProduct.supportedPluginVersions.includes(metadata.version) || !values.buildVersion || !values.channel || !values.updateOrigin) {
    throw new Error('Legacy App sources require a supported plugin version and explicit build version, channel and update origin');
  }
  if (!semver.test(values.buildVersion) || !['stable', 'preview'].includes(values.channel)) invalid();
  const origin = publicOrigin(values.updateOrigin);
  return {
    name: legacyWorkflowProduct.name, app_id: legacyWorkflowProduct.appId, plugin_version: metadata.version,
    build_version: values.buildVersion, channel: values.channel, update_origin: origin,
    storage_origin: publicOrigin(values.storageOrigin || origin), update_environment: legacyWorkflowProduct.updateEnvironment,
    plugin_roots: legacyWorkflowProduct.pluginRoots.join(','), plugin_bundles: legacyWorkflowProduct.defaultBundles.join(','),
    windows_icon: legacyWorkflowProduct.windowsIcon, windows_tray_icon: legacyWorkflowProduct.windowsTrayIcon,
    product_definition: 'legacy-workflow-v1',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'github-outputs') {
    const outputs = resolveWorkflowSourceOutputs(process.argv[3] || root, { buildVersion: process.env.STUDIO_PRODUCT_BUILD_VERSION,
      updateOrigin: process.env.STUDIO_PRODUCT_UPDATE_ORIGIN, storageOrigin: process.env.STUDIO_PRODUCT_STORAGE_ORIGIN,
      channel: process.env.STUDIO_PRODUCT_CHANNEL });
    if (Object.values(outputs).some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) invalid();
    console.log(Object.entries(outputs).map(([name, value]) => `${name}=${value}`).join('\n'));
  } else {
  const inputs = resolveProductInputs();
  const key = process.argv[2];
  const values = { name: inputs.name, 'app-id': inputs.appId, 'update-env': inputs.settings.DSH_DESKTOP_AUTO_UPDATE_ENV, roots: inputs.environment.DSH_DESKTOP_PLUGIN_ROOTS, bundles: inputs.environment.DSH_DESKTOP_PLUGIN_BUNDLES, icon: inputs.platforms['mac-arm64'].icon, tray: inputs.platforms['mac-arm64'].trayIcon };
  if (!Object.hasOwn(values, key)) throw new Error('usage: product-config.mjs <name|roots|bundles|icon|tray>');
  console.log(values[key]);
  }
}
