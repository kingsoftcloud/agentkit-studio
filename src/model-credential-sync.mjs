/**
 * Copy the Studio model key from the Host-owned global configuration into the
 * DSH credential service. The value never leaves this module or appears in a
 * return value/log; the browser only receives a redacted status object.
 */
export async function syncGlobalModelCredential({ configuration, credentials, reference = 'AGENTKIT_MODEL_API_KEY' } = {}) {
  if (!configuration || typeof configuration.resolve !== 'function') throw new TypeError('configuration.resolve is required');
  if (!credentials || typeof credentials.resolve !== 'function' || typeof credentials.set !== 'function') throw new TypeError('credentials.resolve/set are required');
  const resolved = await configuration.resolve();
  const profiles = Array.isArray(resolved?.values?.modelProfiles) ? resolved.values.modelProfiles : [];
  const entries = profiles.filter(profile => profile?.apiKey && profile?.credentialName).map(profile => [String(profile.credentialName), String(profile.apiKey)]);
  const legacy = String(resolved?.values?.modelApiKey || '').trim();
  if (legacy && !entries.some(([name]) => name === reference)) entries.push([reference, legacy]);
  const results = [];
  for (const [name, value] of entries) {
    const current = await credentials.resolve(name);
    if (['env', 'user-env', 'project-env'].includes(current?.source)) {
      results.push({ name, configured: true, source: current.source, synchronized: current.value === value });
      continue;
    }
    if (current?.value !== value) await credentials.set(name, value);
    const after = await credentials.describe?.(name);
    results.push({ name, configured: true, source: after?.source || 'memory', synchronized: true });
  }
  if (!results.length) return { configured: false, source: resolved?.sources?.modelApiKey || 'missing' };
  const selected = results.find(item => item.name === reference) || results[0];
  const summary = { configured: true, source: selected.source, synchronized: results.every(item => item.synchronized) };
  // Keep the original compact response for the legacy single-key contract.
  // The per-profile detail is only needed when more than one model credential
  // is configured and is still fully redacted.
  return results.length === 1 && results[0].name === reference
    ? summary
    : { ...summary, profiles: results.map(({ name, ...item }) => ({ name, ...item })) };
}
