/** Private carrier rebuilt by the authenticated platform hop, never by body metadata. */
import { createHash } from 'node:crypto';
import { runtimeError } from './runtime-responses-contract.mjs';

export const managedIdentityHeaders = Object.freeze({
  identity_namespace: 'x-agentengine-identity-namespace',
  tenant_id: 'x-agentengine-business-tenant-id',
  subject_type: 'x-agentengine-subject-type',
  subject_id: 'x-agentengine-subject-id',
});

export function managedRuntimePrincipal(headers) {
  const values = {};
  for (const [key, header] of Object.entries(managedIdentityHeaders)) {
    const raw = headers[header];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) throw runtimeError('RUNTIME_TRUSTED_IDENTITY_REQUIRED', 401);
    if ([...value].length > (key === 'subject_type' ? 32 : 128) || /[\x00-\x1f\x7f]/.test(value)) throw runtimeError('RUNTIME_TRUSTED_IDENTITY_INVALID');
    values[key] = value;
  }
  // Match Server/KsADK ensure_ascii=False, sort_keys=True compact JSON exactly.
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(values).sort().map(key => [key, values[key]])));
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { key: JSON.stringify(Object.values(values)), digest, userId: `aeu_${digest}` };
}
