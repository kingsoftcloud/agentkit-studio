import toolDefaults from './contracts/harness-tool-defaults.json' with { type: 'json' };

/** The Host, not model output, identifies available built-in resources. */
export function nativeDefaultToolsFromCatalog(catalog, defaults = toolDefaults.defaultTools) {
  const available = new Set(catalog.filter(item => item.source === 'studio-native' && !item.disabled
    && ['available', 'configured'].includes(item.status)).map(item => item.resourceId));
  return defaults.filter(name => available.has(name));
}
