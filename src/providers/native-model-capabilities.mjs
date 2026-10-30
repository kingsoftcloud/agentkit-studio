import { createHash } from 'node:crypto';
import { canonical, invariant } from '@kingsoftcloud/agentkit-harness-core';
import { admitModelCapabilities, validateModelCapabilities } from '@kingsoftcloud/agentkit-harness-core/model-capabilities';
import { modelInput } from '../model-service.mjs';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const key = profile => canonical([profile.id ?? '', profile.modelName]);

/** Without capability facts this reconstructs the exact historical binding. */
export const profileDescription = (profile, capabilities) => ({ id: profile.id, provider: profile.provider, modelName: profile.modelName,
  baseUrl: profile.baseUrl, protocol: profile.protocol || (profile.provider === 'anthropic' ? 'anthropic-messages' : 'openai-chat'),
  contextWindow: capabilities?.contextWindow ?? profile.contextWindow ?? 128000,
  maxOutputTokens: capabilities?.maxOutputTokens ?? profile.maxOutputTokens ?? 8192,
  parameters: profile.parameters ?? {}, requestTimeoutMs: profile.requestTimeoutMs ?? 110000,
  input: capabilities?.input ?? modelInput(profile), ...(capabilities ? { capabilities } : {}) });

export function validateNativeModelBindings(manifest) {
  invariant(manifest?.contract === 'agentkit.model-bindings/v1' && Object.keys(manifest).sort().join(',') === 'contract,items'
    && Array.isArray(manifest.items) && manifest.items.length > 0 && manifest.items.length <= 256,
  'studio_native_model_bindings_invalid');
  const keys = new Set();
  for (const item of manifest.items) {
    invariant(item && Object.keys(item).sort().join(',') === 'capabilities,configuredDigest,modelName,profileId'
      && typeof item.profileId === 'string' && typeof item.modelName === 'string' && item.modelName.trim()
      && /^[a-f0-9]{64}$/.test(item.configuredDigest), 'studio_native_model_bindings_invalid');
    const id = canonical([item.profileId, item.modelName]);
    invariant(!keys.has(id), 'studio_native_model_bindings_invalid'); keys.add(id);
    validateModelCapabilities(item.capabilities);
  }
  return structuredClone(manifest);
}

/** Catalog changes do not alter an admitted Run; current profile changes still
 * invalidate its endpoint/model/parameter binding before any request. */
export function frozenNativeModelDescription(profile, manifest) {
  if (!manifest) return profileDescription(profile);
  validateNativeModelBindings(manifest);
  const item = manifest.items.find(item => canonical([item.profileId, item.modelName]) === key(profile));
  invariant(item && item.configuredDigest === hash(profileDescription(profile)), 'studio_native_model_binding_changed');
  return profileDescription(profile, structuredClone(item.capabilities));
}

export function createNativeModelDescriptions({ models, originalCapsule, signal }) {
  const frozen = originalCapsule?.modelBindings;
  if (frozen) validateNativeModelBindings(frozen);
  const legacy = Boolean(originalCapsule && !frozen), entries = new Map();
  const describe = async profile => {
    signal.throwIfAborted();
    const id = key(profile), configuredDigest = hash(profileDescription(profile));
    if (entries.has(id)) {
      invariant(entries.get(id).configuredDigest === configuredDigest, 'studio_native_model_binding_changed');
      return get(profile);
    }
    const description = legacy || frozen ? frozenNativeModelDescription(profile, frozen) : null;
    const capabilities = description?.capabilities ?? (legacy ? null : typeof models.capabilities === 'function'
      ? await models.capabilities(profile, signal) : admitModelCapabilities(profile));
    signal.throwIfAborted();
    entries.set(id, { profileId: profile.id ?? '', modelName: profile.modelName, configuredDigest,
      ...(capabilities ? { capabilities: validateModelCapabilities(capabilities) } : {}) });
    return get(profile);
  };
  const get = profile => {
    const item = entries.get(key(profile));
    invariant(item && item.configuredDigest === hash(profileDescription(profile)), 'studio_native_model_binding_changed');
    return profileDescription(profile, item.capabilities && structuredClone(item.capabilities));
  };
  return { describe, get, manifest: () => legacy ? undefined : validateNativeModelBindings({ contract: 'agentkit.model-bindings/v1',
    items: [...entries].sort(([a],[b]) => a.localeCompare(b)).map(([,item]) => structuredClone(item)) }) };
}
