import { createHash } from 'node:crypto';
import { canonical, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';

export const STUDIO_NATIVE_RECOVERY_BINDING = 'agentkit.studio-native-recovery-binding/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Durable admission data, never a credential or permission grant. */
export function nativeRecoveryBinding({ binding, input, source, selection, systemPrompt }) {
  const capsule = { contract: STUDIO_NATIVE_RECOVERY_BINDING, agentId: binding.agentId,
    agentRevision: binding.agentRevision, buildId: binding.buildId ?? null,
    source: structuredClone(source), maxTokens: selection.maxTokens ?? null,
    messages: structuredClone(input.messages), systemPrompt };
  validate(capsule);
  return capsule;
}

function validate(capsule) {
  invariant(capsule && typeof capsule === 'object' && !Array.isArray(capsule)
    && Object.keys(capsule).sort().join(',') === 'agentId,agentRevision,buildId,contract,maxTokens,messages,source,systemPrompt'
    && capsule.contract === STUDIO_NATIVE_RECOVERY_BINDING && text(capsule.agentId)
    && Number.isSafeInteger(capsule.agentRevision) && capsule.agentRevision > 0
    && (capsule.buildId === null || text(capsule.buildId))
    && (capsule.maxTokens === null || Number.isSafeInteger(capsule.maxTokens) && capsule.maxTokens > 0)
    && typeof capsule.systemPrompt === 'string'
    && capsule.source && Object.keys(capsule.source).sort().join(',') === 'model,provider'
    && text(capsule.source.provider) && text(capsule.source.model)
    && Array.isArray(capsule.messages) && capsule.messages.length > 0
    && capsule.messages.every(message => message && message.role === 'user' && text(message.id) && Array.isArray(message.content)),
  'studio_native_recovery_binding_invalid');
  canonical(capsule);
}

/** Verify the original Run's recorded digest; never fall back to current defaults. */
export function readNativeRecoveryBinding(record, { agentId, sessionId, runId }) {
  invariant(record?.snapshot?.scope?.agentId === agentId && record.snapshot.sessionId === sessionId
    && record.snapshot.runId === runId, 'studio_native_recovery_identity_mismatch');
  invariant(hash(record.configuration) === record.snapshot.configDigest, 'stored_configuration_mismatch');
  const capsule = record.configuration.hostRecoveryBinding;
  invariant(capsule !== undefined, 'studio_native_recovery_binding_missing');
  validate(capsule);
  invariant(capsule.agentId === agentId, 'studio_native_recovery_identity_mismatch');
  return structuredClone(capsule);
}

/** Current preset capabilities must be resolved separately through the trusted Host. */
export function assertNativeRecoveryPreset(capsule, binding) {
  validate(capsule);
  invariant(binding?.runtime === 'harness' && binding.local === true
    && binding.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT
    && binding.agentId === capsule.agentId && binding.agentRevision === capsule.agentRevision
    && (binding.buildId ?? null) === capsule.buildId,
  'studio_native_recovery_preset_changed');
}
