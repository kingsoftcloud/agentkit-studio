import product from './product.json' with { type: 'json' };

/** Public copy shared by the build adapter and each mounted product plugin. */
export function resolveProductCopy(configuration = product) {
  const copy = {};
  if (configuration.copy === undefined) return copy;
  if (!configuration.copy || typeof configuration.copy !== 'object' || Array.isArray(configuration.copy)) throw new Error('Invalid product copy');
  for (const [namespace, dictionaries] of Object.entries(configuration.copy)) {
    if (!namespace || !dictionaries || typeof dictionaries !== 'object' || Array.isArray(dictionaries)) throw new Error('Invalid product copy');
    copy[namespace] = {};
    for (const [locale, entries] of Object.entries(dictionaries)) {
      if (!['en', 'zh'].includes(locale) || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid product copy');
      copy[namespace][locale] = {};
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value !== 'string') throw new Error('Invalid product copy');
        copy[namespace][locale][key] = value.replaceAll('{productName}', configuration.brand.name);
      }
    }
  }
  return copy;
}

/** The caller owns this disposer; partial setup also releases earlier owners. */
export function installProductCopy(locale, configuration) {
  if (typeof locale?.override !== 'function') throw Object.assign(new Error('Host capability locale.override is required for product copy'), { code: 'DSH_CAPABILITY_UNAVAILABLE' });
  const disposers = [];
  const release = () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
  try { for (const [namespace, dictionaries] of Object.entries(resolveProductCopy(configuration))) disposers.push(locale.override(namespace, dictionaries)); }
  catch (error) { release(); throw error; }
  return release;
}
