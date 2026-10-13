import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Return a redacted readiness fact for the first global model credential.
 * This intentionally checks both Studio's global configuration and the DSH
 * credential provider: an environment/profile credential must not be treated
 * as missing merely because Studio has not copied it yet.
 */
export async function describeGlobalModelCredential({ configuration, credentials, reference = 'AGENTKIT_MODEL_API_KEY', env = process.env, codexHome } = {}) {
  if (!configuration || typeof configuration.resolve !== 'function') throw new TypeError('configuration.resolve is required');
  if (!credentials || typeof credentials.describe !== 'function') throw new TypeError('credentials.describe is required');
  const resolved = await configuration.resolve();
  const values = resolved?.values || {};
  const profiles = Array.isArray(values.modelProfiles) ? values.modelProfiles : [];
  const names = [...new Set([
    ...profiles.map(profile => String(profile?.credentialName || '').trim()),
    reference, 'OPENAI_API_KEY', 'MODEL_AGENT_API_KEY', 'DEEPSEEK_API_KEY',
  ].filter(Boolean))];
  const configuredByHost = Boolean(String(values.modelApiKey || '').trim() || profiles.some(profile => String(profile?.apiKey || '').trim()));
  const hostSource = values.modelApiKey ? resolved?.sources?.modelApiKey : profiles.find(profile => profile?.apiKey)?.credentialName;
  for (const name of names) {
    const info = await credentials.describe(name).catch(() => null);
    if (info?.configured === true) return { configured: true, source: info.source || 'dsh', credential: name };
  }
  // Codex's native App Server auth is file-backed rather than an API-key
  // reference. Report only a non-empty JSON object; never return its contents.
  const nativeCodexHome = String(codexHome || env.CODEX_HOME || join(homedir(), '.codex'));
  try {
    const auth = JSON.parse(await readFile(join(nativeCodexHome, 'auth.json'), 'utf8'));
    if (auth && typeof auth === 'object' && Object.keys(auth).length) return { configured: true, source: 'codex-auth' };
  } catch { /* no native Codex credential is a valid unconfigured state */ }
  return configuredByHost
    ? { configured: true, source: hostSource || resolved?.sources?.modelApiKey || 'host' }
    : { configured: false, source: resolved?.sources?.modelApiKey || 'missing' };
}
