import { canonical, invariant, retirableBrowserResources, reviewedResourceInterruption } from '@kingsoftcloud/agentkit-harness-core';
import { readNativeRecoveryBinding, assertNativeRecoveryPreset } from '../../providers/native-recovery-binding.mjs';
import {nativeRecoveryLive as live} from './native-recovery-lifetime.mjs';

export function validateNativeResourceRetirementRequest(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'agentId,commandId,confirmedRetired,eventSeq,runId,sessionId'
    && ['agentId','commandId','runId','sessionId'].every(key => typeof value[key] === 'string'
      && value[key].trim() && value[key].length <= 256)
    && Number.isSafeInteger(value.eventSeq) && value.eventSeq >= 0 && value.confirmedRetired === true,
  'STUDIO_NATIVE_RESOURCE_RETIREMENT_INVALID');
}

/** The request supplies only identity and operator intent. A trusted original
 * capability owner supplies the actual fence; model/page data cannot do so. */
export function createNativeResourceRetirement({ ctx, store, workspaceId, lifetime, active, controls, controlKey,
  inspect, summary, execute, agentEvents }) {
  const pending = new Map();
  const retire = async (request, callerSignal) => {
    validateNativeResourceRetirementRequest(request);
    const signal = callerSignal ? AbortSignal.any([callerSignal,lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const scope = {tenantId:'local',workspaceId,userId:'local-user',agentId:request.agentId};
    const previous = store.load(scope,request.runId);
    invariant(previous.snapshot.sessionId === request.sessionId, 'studio_native_retirement_identity_mismatch');
    const sameReview = record => record.resourceRetirementReview?.commandId === request.commandId
      && record.resourceRetirementReview?.eventSeq === request.eventSeq && reviewedResourceInterruption(record);
    let inspected;
    if (previous.resourceRetirementReview) {
      invariant(sameReview(previous), 'command_replay_conflict');
      const found = await live(()=>ctx.get('sessionController').resolveAgent(request.sessionId),signal);
      signal.throwIfAborted();if(found.error)throw found.error;
      invariant(found.agent?.session?.id === request.sessionId, 'studio_native_retirement_identity_mismatch');
      if(found.agent.externalTurns?.pending()?.turn !== Number(previous.snapshot.turnId)) {
        invariant(await ctx.get('sessions').flush(found.agent.session) === true,'native_delivery_not_durable');
        return summary(request,{agent:found.agent,scope,record:previous,admission:null});
      }
    }
    inspected = await inspect(request,signal);
    const record = inspected.record, key = controlKey(request.agentId,request.sessionId);
    invariant(record && !inspected.managed && !inspected.background && inspected.admission
      && !controls.has(key) && (!record.lease || record.lease.expiresAt <= Date.now())
      && record.snapshot.eventSeq === request.eventSeq, 'studio_native_retirement_not_open');
    if(!record.resourceRetirementReview) {
      const refs = retirableBrowserResources(record);
      invariant(refs && typeof store.retireResources === 'function','studio_native_retirement_not_eligible');
      const capsule = readNativeRecoveryBinding(record,request);
      const binding = await live(()=>agentEvents(ctx,inspected.agent).serial('agentkit/native-recovery-binding',{}),signal);
      signal.throwIfAborted();assertNativeRecoveryPreset(capsule,binding);
      invariant(typeof binding.nativeTools?.retireBrowserResources === 'function','studio_native_resource_owner_unavailable');
      const fence = await live(()=>binding.nativeTools.retireBrowserResources({scope,sessionId:request.sessionId,
        runId:request.runId,refs,signal,definition:record.configuration.tools.find(tool=>tool.observationRole==='browser')}),signal);
      signal.throwIfAborted();
      invariant(!controls.has(key),'studio_native_recovery_already_active');
      store.retireResources(scope,request.runId,{contract:'agentkit.resource-retirement-review/v1',
        commandId:request.commandId,eventSeq:request.eventSeq,fence},Date.now());
    } else invariant(sameReview(record),'command_replay_conflict');
    // Past the durable disposition, finish under the Host lifetime so a lost
    // HTTP response cannot duplicate closure or adopt a newer turn.
    const task=execute.closeRetiredResources({agent:inspected.agent,scope,runId:request.runId,signal:lifetime.signal});
    active.add(task);
    try {
      await task;invariant(await ctx.get('sessions').flush(inspected.agent.session) === true,'native_delivery_not_durable');
      return summary(request,{agent:inspected.agent,scope,record:store.load(scope,request.runId),admission:null});
    } finally {active.delete(task);}
  };
  return (request,signal) => {
    validateNativeResourceRetirementRequest(request);
    const key=canonical([request.agentId,request.sessionId]);const previous=pending.get(key);
    if(previous){invariant(canonical(previous.request)===canonical(request),'studio_native_retirement_already_active');return previous.promise;}
    const promise=retire(structuredClone(request),signal);pending.set(key,{request:structuredClone(request),promise});
    void promise.finally(()=>{if(pending.get(key)?.promise===promise)pending.delete(key);}).catch(()=>{});
    return promise;
  };
}
