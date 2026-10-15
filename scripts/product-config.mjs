/** Public product inputs only. Signing credentials remain in platform-owned dotenv files. */
import product from '../src/product.json' with { type: 'json' };
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
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || isAbsolute(value)) invalid();
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const inputs = resolveProductInputs();
  const key = process.argv[2];
  const values = { name: inputs.name, roots: inputs.environment.DSH_DESKTOP_PLUGIN_ROOTS, bundles: inputs.environment.DSH_DESKTOP_PLUGIN_BUNDLES, icon: inputs.platforms['mac-arm64'].icon, tray: inputs.platforms['mac-arm64'].trayIcon };
  if (!Object.hasOwn(values, key)) throw new Error('usage: product-config.mjs <name|roots|bundles|icon|tray>');
  console.log(values[key]);
}
