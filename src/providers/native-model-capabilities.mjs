import { createHash } from 'node:crypto';
import { canonical, invariant, presetRequestOutputTokens } from '@kingsoftcloud/agentkit-harness-core';
import { admitModelCapabilities, validateModelCapabilities } from '@kingsoftcloud/agentkit-harness-core/model-capabilities';
import { modelInput } from '../model-service.mjs';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const key = profile => canonical([profile.id ?? '', profile.modelName]);

const BINDINGS_CONTRACTS = ['agentkit.model-bindings/v1', 'agentkit.model-bindings/v2', 'agentkit.model-bindings/v3'];
/** New Runs take the per-request output budget from the engine preset. */
const CURRENT_BINDINGS_CONTRACT = 'agentkit.model-bindings/v3';
/** v1 sent no request budget, v2 capped an unset profile at 8192, v3 asks the engine. */
const budgetMode = contract => contract === 'agentkit.model-bindings/v1' ? 'legacy' : contract === 'agentkit.model-bindings/v2' ? 'fixed' : 'engine';
const requestOutputTokens = (profile, capabilities, mode) => mode === 'engine'
  ? presetRequestOutputTokens({ configured: profile.maxOutputTokens ?? null, modelMaxOutputTokens: capabilities.maxOutputTokens, contextWindow: capabilities.contextWindow })
  : Math.min(profile.maxOutputTokens ?? 8192, capabilities.maxOutputTokens);

/** Without capability facts this reconstructs the exact historical binding. */
export const profileDescription = (profile, capabilities, mode = 'fixed') => ({ id: profile.id, provider: profile.provider, modelName: profile.modelName,
  baseUrl: profile.baseUrl, protocol: profile.protocol || (profile.provider === 'anthropic' ? 'anthropic-messages' : 'openai-chat'),
  contextWindow: capabilities?.contextWindow ?? profile.contextWindow ?? 128000,
  maxOutputTokens: capabilities?.maxOutputTokens ?? profile.maxOutputTokens ?? 8192,
  ...(capabilities && mode !== 'legacy' ? { requestOutputTokens: requestOutputTokens(profile, capabilities, mode) } : {}),
  parameters: profile.parameters ?? {}, requestTimeoutMs: profile.requestTimeoutMs ?? 110000,
  input: capabilities?.input ?? modelInput(profile), ...(capabilities ? { capabilities } : {}) });

export function validateNativeModelBindings(manifest) {
  invariant(BINDINGS_CONTRACTS.includes(manifest?.contract) && Object.keys(manifest).sort().join(',') === 'contract,items'
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
  return profileDescription(profile, structuredClone(item.capabilities), budgetMode(manifest.contract));
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
    return profileDescription(profile, item.capabilities && structuredClone(item.capabilities), budgetMode(frozen?.contract ?? CURRENT_BINDINGS_CONTRACT));
  };
  return { describe, get, manifest: () => legacy ? undefined : validateNativeModelBindings({ contract: frozen?.contract ?? CURRENT_BINDINGS_CONTRACT,
    items: [...entries].sort(([a],[b]) => a.localeCompare(b)).map(([,item]) => structuredClone(item)) }) };
}

/** Only durable, already-admitted model identities may bypass catalog IO.
 * Credentials and current gateway configuration are still resolved each time. */
export function resolveNativeProfile(models, id, capsule) {
  const item = capsule?.modelBindings?.items?.find(item => item.profileId === id || item.modelName === id);
  return models.profile(id, item ? { admittedModel: { profileId: item.profileId, modelName: item.modelName } } : undefined);
}
