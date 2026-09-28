/**
 * Copy the Studio model key from the Host-owned global configuration into the
 * DSH credential service. The value never leaves this module or appears in a
 * return value/log; the browser only receives a redacted status object.
 */
export async function syncGlobalModelCredential({ configuration, credentials, reference = 'AGENTKIT_MODEL_API_KEY' } = {}) {
  if (!configuration || typeof configuration.resolve !== 'function') throw new TypeError('configuration.resolve is required');
  if (!credentials || typeof credentials.resolve !== 'function' || typeof credentials.set !== 'function') {
    throw new TypeError('credentials.resolve/set are required');
  }
  const resolved = await configuration.resolve();
  const value = String(resolved?.values?.modelApiKey || '').trim();
  const source = resolved?.sources?.modelApiKey || 'missing';
  if (!value) return { configured: false, source };

  const current = await credentials.resolve(reference);
  // Environment credentials are read-only in DSH. Let that source win even
  // when a stale global file exists; this preserves normal process overrides.
  if (current?.source === 'env' || current?.source === 'user-env' || current?.source === 'project-env') {
    return { configured: true, source: current.source, synchronized: current.value === value };
  }
  if (current?.value !== value) await credentials.set(reference, value);
  const after = await credentials.describe?.(reference);
  return { configured: true, source: after?.source || 'memory', synchronized: true };
}
