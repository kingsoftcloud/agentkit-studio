import { canonical, copy, invariant } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { memoryDigest, nativeUserMemoryCandidate, evaluateNativeMemoryCandidate } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { admitNativeMemoryRecords } from '../../packages/agentkit-harness/src/native/memory-recall.mjs';
import { studioNativeMemoryPolicy } from './native-memory.mjs';
import { readNativeRecoveryBinding } from './native-recovery-binding.mjs';
import { EVIDENCE_VERIFIER_REF } from './native-verification.mjs';

export const MEMORY_VERIFIER_REF = 'studio.explicit-durable-memory';
export const MEMORY_VERIFIER_VERSION = '2';
const hash = value => memoryDigest(canonical(value));

/** Intent interpretation only. These synthetic identities never authorize writes. */
export function explicitNativeMemoryTarget(goal) {
  const candidate = nativeUserMemoryCandidate({ text: goal, sourceEventId: 'intent-only', scope: 'user', scopeId: 'intent-only' });
  return candidate?.reason.startsWith('explicit_user') ? candidate : null;
}
export function extendNativeMemoryGoal(goal, contract, { providerRef } = {}) {
  const target = explicitNativeMemoryTarget(goal), item = contract.acceptance[0];
  if (providerRef !== 'local-default' || !target || contract.acceptance.length !== 1
    || contract.finalSubmissionSchema !== null || item.id !== 'current_user_goal') return copy(contract);
  return { ...copy(contract), revision: contract.revision + '+memory-' + hash([target.operation, target.content, MEMORY_VERIFIER_VERSION]).slice(7, 27),
    acceptance: [{ ...copy(item), verifierRef: MEMORY_VERIFIER_REF, verifierVersion: MEMORY_VERIFIER_VERSION, verificationMethod: 'deterministic' }] };
}

function toolObservations(record) {
  return record.intents.flatMap(intent => {
    if (intent.kind !== 'tool' || !Array.isArray(intent.payload.calls)) return [];
    const receipt = record.receipts.find(item => item.operationKey === intent.operationKey);
    if (!receipt || !Array.isArray(receipt.result.results) || receipt.result.results.length !== intent.payload.calls.length) return [];
    return intent.payload.calls.map((call, index) => ({ call, receipt, result: receipt.result.results[index],
      operationKey: intent.payload.calls.length > 1 ? intent.operationKey + ':call:' + (index + 1) : intent.operationKey }));
  });
}

/** Read-only verification. Only the supplied, independently scoped Memory owner
 * can confirm a mutation receipt; neither an assistant promise nor tool JSON is
 * persistence evidence. The caller seals this binding into hostBindingDigest.
 */
export function createStudioNativeMemoryVerification({ record, buildId = null, scope, sessionId, store,
  baseline, memoryOwner, definitions = [] }) {
  invariant(record.metadata?.id === scope.agentId && record.metadata.local === true
    && record.spec.runtime?.type === 'harness' && Number.isSafeInteger(record.metadata.revision) && record.metadata.revision > 0,
  'studio_native_memory_verification_binding_invalid');
  const revision = record.metadata.revision;
  const policy = studioNativeMemoryPolicy(record.spec), principal = copy(scope), locked = copy(definitions);
  const bindingDigest = hash({ verifier: MEMORY_VERIFIER_REF, version: MEMORY_VERIFIER_VERSION,
    revision, buildId, principal, sessionId, policy, definitions: locked });
  const current = request => {
    request.signal.throwIfAborted();
    const loaded = store.load(principal, request.runId), snapshot = loaded.snapshot;
    const capsule = readNativeRecoveryBinding(loaded, { agentId: principal.agentId, sessionId, runId: request.runId });
    const intent = loaded.intents.find(item => item.operationKey === request.operationKey);
    invariant(canonical(request.scope) === canonical(principal) && request.sessionId === sessionId
      && ['turnId', 'buildId', 'parentRunId', 'taskChainId'].every(key => request[key] === snapshot[key])
      && canonical(snapshot) === canonical(request.snapshot) && snapshot.phase === 'verifying'
      && capsule.agentRevision === revision && capsule.buildId === buildId
      && (buildId === null || snapshot.buildId === buildId)
      && canonical(request.contract) === canonical(snapshot.taskContract ?? loaded.configuration.contract)
      && snapshot.pendingIntent === request.operationKey && intent?.kind === 'verify' && intent.status === 'running'
      && loaded.lease?.expiresAt > Date.now() && intent.claimedFence === loaded.lease.fence
      && request.executionFence === intent.claimedFence, 'studio_native_memory_verification_unbound');
    return loaded;
  };
  return { bindingDigest, async verify(request) {
    const selected = request.contract.acceptance.filter(item => item.verifierRef === MEMORY_VERIFIER_REF);
    if (!selected.length) return baseline.verify(request);
    const loaded = current(request), target = explicitNativeMemoryTarget(loaded.snapshot.goal), main = selected[0];
    invariant(target && selected.length === 1 && request.contract.acceptance.length === 1
      && main.id === 'current_user_goal' && main.verifierVersion === MEMORY_VERIFIER_VERSION
      && main.verificationMethod === 'deterministic', 'studio_native_memory_verification_contract_invalid');
    // Baseline retains its candidate/environment/evidence binding; it does not
    // qualify this new acceptance. Its observation is replaced below.
    const base = await baseline.verify({ ...request, contract: { ...copy(request.contract),
      acceptance: [{ ...copy(main), verifierRef: EVIDENCE_VERIFIER_REF, verifierVersion: '1' }] } });
    current(request);
    // Missing evidence or a delivery defect remains a blocker. A current Memory
    // record cannot turn a failed baseline observation into accepted delivery.
    if (base.checks.some(check => ['failed', 'blocked'].includes(check.status))) return {
      ...base, checks: base.checks.map(check => ({ ...check, verifierId: MEMORY_VERIFIER_REF,
        verifierVersion: MEMORY_VERIFIER_VERSION, verificationMethod: 'deterministic' })),
    };
    let status = 'failed', reason = 'durable_fact_missing', references = [];
    const recordReference = fact => 'memory-record:' + hash({ principal, memoryId: fact.memoryId, version: fact.version, contentHash: fact.contentHash });
    const read = async id => {
      const fact = await memoryOwner.read(id, { signal: request.signal }); current(request);
      const admitted = admitNativeMemoryRecords(fact ? [fact] : [], { principal, scopes: policy.scopes });
      return admitted.find(item => item.content === target.content) ?? null;
    };
    try {
      if (!policy.enabled || policy.providerRef !== 'local-default' || !policy.scopes.length || !memoryOwner) {
        status = 'blocked'; reason = 'memory_not_enabled_in_build';
      } else {
        let fact = null;
        if (target.operation === 'add') {
          // Only an admitted, committed current-goal Context source counts as
          // a recall observation; historical user text cannot forge this view.
          for (const intent of loaded.intents.filter(item => item.kind === 'context'
            && String(item.payload.cursor).startsWith(loaded.snapshot.goalRevision + ':'))) {
            const receipt = loaded.receipts.find(item => item.operationKey === intent.operationKey && item.status === 'committed');
            for (const message of receipt?.result.messages ?? []) {
              if (message.kind !== 'context_contribution') continue;
              const data = JSON.parse(message.content), source = loaded.configuration.contextSources.find(item => item.sourceId === data.sourceId);
              if (source?.sourceId === 'studio.memory-recall' && source.bindingDigest === data.bindingDigest
                && data.trust === 'untrusted' && data.item?.content === target.content && typeof data.item.memoryId === 'string') fact = await read(data.item.memoryId);
              if (fact) break;
            }
            if (fact) break;
          }
          for (const observation of toolObservations(loaded)) {
            if (fact) break;
            const { call, receipt, result } = observation;
            if (!['read_memory', 'search_memory'].includes(call.name) || receipt.status !== 'committed' || result.status !== 'ok') continue;
            const ids = call.name === 'read_memory' ? [call.arguments.memory_id]
              : (result.content?.records ?? []).filter(item => item.content === target.content).map(item => item.memoryId ?? item.memory_id);
            for (const id of ids.filter(value => typeof value === 'string')) { fact = await read(id); if (fact) break; }
          }
        }
        if (fact) { status = 'passed'; reason = 'current_durable_fact'; references = [recordReference(fact)]; }
        else if (policy.write.mode === 'off' || policy.rollout !== 'enabled'
          || !locked.some(item => item.name === 'manage_memory')) { status = 'blocked'; reason = 'memory_write_not_committing'; }
        else if ([...target.content].length > 8192 || evaluateNativeMemoryCandidate(target).decision !== 'commit') {
          status = 'blocked'; reason = 'memory_content_rejected';
        } else {
          const definition = locked.find(item => item.name === 'manage_memory');
          invariant(canonical(definition) === canonical(loaded.configuration.tools.find(item => item.name === definition.name)), 'studio_native_memory_definition_unbound');
          for (const observation of toolObservations(loaded)) {
            const { call, receipt, result, operationKey } = observation;
            if (call.name !== definition.name || call.arguments.content !== target.content
              || call.arguments.action !== (target.operation === 'add' ? 'remember' : 'correct')) continue;
            if (result.content?.code === 'policy_denied') { status = 'blocked'; reason = 'memory_approval_denied'; break; }
            if (receipt.status !== 'committed' || result.status !== 'ok' || result.content?.committed !== true) continue;
            const actual = await memoryOwner.receipt({ operationKey, call: copy(call), definition: copy(definition), signal: request.signal });
            current(request);
            if (canonical(actual) !== canonical(result.content) || typeof actual?.memoryId !== 'string') continue;
            fact = await read(actual.memoryId);
            if (fact) { status = 'passed'; reason = 'current_committed_fact'; references = [recordReference(fact)]; break; }
          }
        }
      }
    } catch { request.signal.throwIfAborted(); status = 'blocked'; reason = 'memory_verification_unavailable'; references = []; }
    current(request);
    const observed = 'memory-check:' + hash({ principal, runId: request.runId, goalRevision: loaded.snapshot.goalRevision,
      targetHash: memoryDigest(target.content), status, reason });
    const safeSummary = status === 'passed' ? 'The requested fact is present in current scoped durable Memory.'
      : status === 'blocked' ? 'Memory persistence cannot be confirmed: ' + reason + '.'
        : 'The requested durable fact is missing. Use manage_memory, inspect its actual result, and verify the current record before finishing.';
    return { ...base, status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'unverified',
      reason, checks: [{ id: main.id, status, verifierId: MEMORY_VERIFIER_REF, verifierVersion: MEMORY_VERIFIER_VERSION,
        verificationMethod: 'deterministic', evidenceRefs: [...new Set([...base.checks.flatMap(check => check.evidenceRefs), ...references, observed])],
        safeSummary, repairable: status === 'failed' }],
      repairable: status === 'failed', failureFingerprint: status === 'passed' ? '' : hash([MEMORY_VERIFIER_REF, request.contract.revision, status, reason]) };
  } };
}
