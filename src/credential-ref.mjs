/**
 * DSH credentials are addressed by references that must be POSIX shell
 * identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`). MCP configurations, however, name
 * their secrets after HTTP headers (`X-KIP-Token`) or environment variables, and
 * an MCP reference is written as `env://<name>`. Two different namespaces meet
 * here, so the reference must be derived once, when the secret is created, and
 * then used on both sides of the binding.
 *
 * Never rewrite a name in place: `envRefs` already points at `env://X-KIP-Token`,
 * so renaming only the stored key would silently orphan the MCP config.
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `value` is a reference the DSH credential store can address. */
export function isCredentialRefName(value) {
  return CREDENTIAL_REF_PATTERN.test(String(value ?? '').trim());
}

/**
 * Derive a credential reference from a display name (usually an MCP header such
 * as `X-KIP-Token`). Deterministic, so the same input always yields the same
 * reference and a re-save keeps pointing at the same secret.
 * @param value - source name, for example `X-KIP-Token`.
 * @param fallback - reference to use when nothing usable survives.
 * @returns a reference that satisfies {@link CREDENTIAL_REF_PATTERN}.
 */
export function deriveCredentialRefName(value, fallback = 'MCP_CREDENTIAL') {
  const raw = String(value ?? '').trim();
  if (isCredentialRefName(raw)) return raw;
  const collapsed = raw.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const prefixed = collapsed ? (/^[A-Za-z_]/.test(collapsed) ? collapsed : `_${collapsed}`) : '';
  if (isCredentialRefName(prefixed)) return prefixed;
  return isCredentialRefName(fallback) ? fallback : 'MCP_CREDENTIAL';
}

/** `env://` reference for `value`, derived when `value` is not addressable. */
export function deriveCredentialReference(value, fallback) {
  const raw = String(value ?? '').trim();
  const name = raw.startsWith('env://') ? raw.slice('env://'.length) : raw;
  return `env://${deriveCredentialRefName(name, fallback)}`;
}

/**
 * Bind an MCP server's secrets to references the credential store can hold.
 *
 * `envRefs` maps a header/env name to an `env://` reference, and the catalog
 * declares required credentials by header (`X-KIP-Token`). Neither side can
 * carry a non-POSIX name into the store, and both must change together, so the
 * whole binding is normalised in one place: references are derived, and the
 * header keeps its spelling as the key.
 * @param input - the dialog's env references, primary credential name, typed secrets, and catalog requirements.
 * @returns normalised `envRefs`, the addressable primary name, and the secret writes to perform.
 */
export function normalizeMcpCredentialBindings({ envRefs = {}, credentialName = '', credentialValues = {}, requiredCredentials = [] } = {}) {
  const bound = {};
  for (const [key, reference] of Object.entries(envRefs)) {
    const raw = String(reference ?? '').trim();
    // Only `env://` values are references; anything else is a literal header
    // value and must be carried through untouched.
    bound[key] = raw.startsWith('env://') ? deriveCredentialReference(raw) : raw;
  }
  const writes = [];
  for (const [name, value] of Object.entries(credentialValues)) {
    if (!String(value || '').trim()) continue;
    const reference = deriveCredentialRefName(name);
    writes.push([reference, String(value).trim()]);
    const declared = requiredCredentials.find(row => row?.name === name);
    if (declared?.header) bound[declared.header] = `env://${reference}`;
  }
  const primary = String(credentialName || '').trim();
  return { envRefs: bound, credentialName: primary ? deriveCredentialRefName(primary) : '', writes };
}
