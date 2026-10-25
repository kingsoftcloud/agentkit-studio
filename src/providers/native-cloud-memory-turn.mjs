/** Durable post-turn cloud conversation submission, independent of Native inference. */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, copy, invariant, NATIVE_GOAL_CONTRACT_BINDING, NATIVE_JSON_CODEC } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '../../packages/agentkit-harness/src/native/dsh-turn-contract.mjs';
import { LegacyMemoryEffects } from '../legacy-memory-effects.mjs';
import { boundMemoryWritePolicy } from '../local-runtime.mjs';
import { RESOURCE_CHECK_EVENT } from '../resource-checks.mjs';
import { readNativeRecoveryBinding } from './native-recovery-binding.mjs';

export const STUDIO_NATIVE_CLOUD_MEMORY_TURN = 'agentkit.studio-native-cloud-memory-turn/v1';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

export async function bindStudioNativeCloudMemoryTurn({ record, scope, sessionId, store, storeDir, resources, sealedCapsule, input, agent }) {
  const fixedScope = copy(scope), capsule = copy(sealedCapsule), policy = boundMemoryWritePolicy(record, input);
  if (!policy) return null;
  invariant(record.metadata?.id === fixedScope.agentId && record.metadata?.local === true
    && record.metadata.revision === capsule.agentRevision && capsule.agentId === fixedScope.agentId
    && record.spec?.runtime?.type === 'harness', 'native_cloud_memory_admission_unbound');
  invariant(policy.resourceId && typeof resources?.bindMemoryWriter === 'function', 'studio_native_memory_write_port_unavailable');
  const writer = await resources.bindMemoryWriter();
  invariant(writer?.binding?.contract === 'agentkit.cloud-memory-transport/v1'
    && typeof writer.prepare === 'function' && typeof writer.write === 'function', 'studio_native_memory_write_port_invalid');
  const binding = { contract: STUDIO_NATIVE_CLOUD_MEMORY_TURN, policy: copy(policy), transport: copy(writer.binding),
    agentRevision: capsule.agentRevision, buildId: capsule.buildId };
  const bindingText = canonical(binding), inputText = String(input), agentId = record.metadata?.teamRole?.sourceAgentId || fixedScope.agentId;
  const effects = new LegacyMemoryEffects(join(await realpath(storeDir), 'native-harness', 'cloud-memory-turns', hash(fixedScope)));
  const lifetime = new AbortController(); let closed = false;
  return { binding: copy(binding),
    async consume(snapshot, { signal, hostBindingDigest }) {
      if (!['verified', 'unverified', 'partial'].includes(snapshot.outcome) || !snapshot.finalText.trim()) return null;
      const combined = AbortSignal.any([signal, lifetime.signal]), fixed = copy(snapshot);
      // Background notification configurations have no original user input.
      // They cannot submit the source turn's conversation a second time.
      if (store.load(fixedScope, fixed.runId).configuration.inputMessages === null) return null;
      const acceptedBindings = [hostBindingDigest, hash({ contract: NATIVE_DSH_TURN_CONTRACT, declared: hostBindingDigest,
        goalContractBinding: NATIVE_GOAL_CONTRACT_BINDING, jsonCodec: NATIVE_JSON_CODEC, input: capsule.messages, source: capsule.source })];
      const current = () => {
        combined.throwIfAborted(); invariant(!closed && canonical(binding) === bindingText, 'native_cloud_memory_owner_closed');
        const loaded = store.load(fixedScope, fixed.runId);
        invariant(loaded.snapshot.phase === 'completed' && canonical(loaded.snapshot) === canonical(fixed)
          && loaded.snapshot.sessionId === sessionId && canonical(loaded.snapshot.scope) === canonical(fixedScope)
          && typeof hostBindingDigest === 'string' && acceptedBindings.includes(loaded.configuration.hostBindingDigest),
        'native_cloud_memory_turn_unbound');
        invariant(canonical(readNativeRecoveryBinding(loaded, { agentId: fixedScope.agentId, sessionId, runId: fixed.runId })) === canonical(capsule),
          'native_cloud_memory_binding_changed');
        return true;
      };
      current(); let dispatched = false;
      const result = await effects.execute({ owner: { kind: 'native', identity: {
        contract: STUDIO_NATIVE_CLOUD_MEMORY_TURN, scope: fixedScope, sessionId, runId: fixed.runId } },
      request: { configDigest: fixed.configDigest, input: inputText, finalText: fixed.finalText }, binding: copy(binding),
      signal: combined, assertCurrent: current,
      prepare: () => writer.prepare(policy.resourceId, fixedScope.userId,
        [{ role: 'user', content: inputText }, { role: 'assistant', content: fixed.finalText }],
        { sessionId, agentId, flush: policy.flush }),
      dispatch: async (prepared, authority) => {
        dispatched = true;
        const receipt = await writer.write(prepared, { signal: combined, assertCurrent: () => { authority(); return true; } });
        invariant(receipt?.accepted === true && typeof receipt.requestId === 'string' && receipt.requestId, 'native_cloud_memory_receipt_missing');
        return { status: 'ok', content: { accepted: true, requestId: receipt.requestId, extraction: 'not_confirmed' } };
      } });
      if (dispatched && !combined.aborted && !closed) {
        current();
        agent?.session?.append(RESOURCE_CHECK_EVENT, { kind: 'memory-instance', resourceId: policy.resourceId, action: 'write',
          status: result.status === 'ok' ? 'succeeded' : 'failed', accepted: result.status === 'ok',
          ...(result.status === 'ok' ? {} : { code: 'MEMORY_OUTCOME_UNKNOWN' }) }, { ignorable: true });
      }
      return result;
    },
    close() { if (!closed) { closed = true; lifetime.abort(); effects.close(); } },
  };
}
