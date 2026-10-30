import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryRunStore,emptyUsage,validateBrowserSessionRef,retirableBrowserResources,reviewedResourceInterruption} from '@kingsoftcloud/agentkit-harness-core';
import {SqliteRunStore} from '@kingsoftcloud/agentkit-harness-node';
import {createNativeDshTurnExecutor,NATIVE_DSH_TURN_CONTRACT} from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import {nativeDeliveryProjection} from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import {fixture,scope as baseScope,tool} from './fixtures/native-core.mjs';
import {nativeOwnershipHost} from './fixtures/native-ownership-host.mjs';
import {nativeRecoveryBinding} from '../src/providers/native-recovery-binding.mjs';
import {createNativeResourceRetirement,validateNativeResourceRetirementRequest} from '../src/host/services/native-resource-retirement.mjs';
import {createSessionRoutes} from '../src/host/routes/sessions.mjs';
import {createNativeRecoveryState} from '../src/client/state/native-recovery.mjs';
import {createNativeDshBrowserTools} from '../src/providers/native-dsh-browser.mjs';
import {createHash} from 'node:crypto';
import {canonical} from '@kingsoftcloud/agentkit-harness-core';
const scope={...baseScope,tenantId:'local',userId:'local-user'};

async function interrupted(store=new MemoryRunStore()) {
 const events=[],projection=nativeDeliveryProjection();let projected=projection.init(),models=0,actions=0;
 const session={id:'session',append(type,data,options){const e={type,data:structuredClone(data),...options,seq:events.length+1};events.push(e);projected=projection.apply(projected,e);}};
 session.append('turn/start',{turn:1});const agent={session,externalTurns:nativeOwnershipHost(session,events)};
 agent.externalTurns.resume=async(_engine,run)=>{const ownership=agent.externalTurns.pending();
  const value=await run({turn:ownership.turn,ownership,signal:new AbortController().signal});session.append('turn/end',{turn:ownership.turn,...value});return value;};
 const input={kind:'enter',messages:[{id:'input',role:'user',content:[{type:'text',text:'Inspect the local game'}]}]};
 const hostBinding={agentId:scope.agentId,agentRevision:1,buildId:'build',local:true,runtime:'harness',nativeEngineContract:NATIVE_DSH_TURN_CONTRACT};
 const source={provider:'fixture',model:'fixture'};
 const capsule=nativeRecoveryBinding({binding:hostBinding,input,source,selection:{},systemPrompt:'fixture'});
 const configuration=fixture({tools:[tool({name:'inspect',readOnly:false,concurrentSafe:false,observationRole:'browser'})],hostRecoveryBinding:capsule,
  inputMessages:[{role:'user',content:'Inspect the local game'}]}).config;
 const binding={scope,buildId:'build',configuration,source,ports:{model:{generate:async()=>{
  models++;return models>1?{kind:'final_candidate',text:'New observation required; old result stays unknown.',usage:emptyUsage(),toolCalls:[]}
   :{kind:'tool_calls',text:'',usage:emptyUsage(),toolCalls:[{callId:'old-action',name:'inspect',arguments:{}}]};}},
  tools:{execute:async request=>{actions++;return {status:'uncertain',content:{code:'action_timed_out'},
   browserSessionRef:validateBrowserSessionRef({scope,runId:request.runId,sessionId:'browser',runtimeId:'owner',workspaceRevision:'workspace'})};}}}};
 const execute=createNativeDshTurnExecutor({store,resolveTurn:async()=>binding,durableOwnership:true,
  projections:{stateOf:()=>projected},flush:async()=>true});
 await assert.rejects(execute({agent,input,turn:1,signal:new AbortController().signal}),{code:'NATIVE_TURN_FAILED'});
 const runId=store.sessionHead(scope,session.id).runId;
 const fence=()=>({contract:'agentkit.resource-fence/v1',resourceKind:'ephemeral-browser',scope,runId,sessionId:session.id,
  refs:retirableBrowserResources(store.load(scope,runId)),fenced:true,externalEffects:false,oldActionsReplayed:false});
 const review=()=>({contract:'agentkit.resource-retirement-review/v1',commandId:'retire-1',eventSeq:store.load(scope,runId).snapshot.eventSeq,fence:fence()});
 return {store,agent,session,events,input,hostBinding,execute,runId,fence,review,counts:()=>({models,actions})};
}

for(const backend of ['memory','sqlite'])test(`${backend}: retirement survives restore, preserves unknown receipts and permanently fences the original run`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'native-retirement-')),filename=join(directory,'ledger.sqlite');
 let store=backend==='sqlite'?new SqliteRunStore(filename):new MemoryRunStore();t.after(()=>{store.close?.();rmSync(directory,{recursive:true,force:true});});
 const h=await interrupted(store),before=store.load(scope,h.runId);const review=h.review();
 assert.ok(retirableBrowserResources(before));assert.equal(before.snapshot.phase,'interrupted');
 assert.throws(()=>store.retireResources(scope,h.runId,{...review,eventSeq:review.eventSeq-1},Date.now()),/invalid_resource_retirement/);
 const lease=store.acquire(scope,h.runId,'other-worker',Date.now(),10000);
 assert.throws(()=>store.retireResources(scope,h.runId,review,Date.now()),/still_owned/);store.release(scope,h.runId,lease);
 store.retireResources(scope,h.runId,review,Date.now());const epoch=store.load(scope,h.runId).fence;
 store.retireResources(scope,h.runId,review,Date.now());assert.equal(store.load(scope,h.runId).fence,epoch);
 assert.throws(()=>store.retireResources(scope,h.runId,{...review,commandId:'conflict'},Date.now()),/command_replay_conflict/);
 if(backend==='sqlite'){store.close();store=new SqliteRunStore(filename);}
 const after=store.load(scope,h.runId);assert.equal(reviewedResourceInterruption(after),true);
 for(const key of ['snapshot','events','receipts','intents','commands','commits'])assert.deepEqual(after[key],before[key]);
 assert.throws(()=>store.acquire(scope,h.runId,'must-not-replay',Date.now(),1000),/resource_retired/);
 assert.deepEqual(h.counts(),{models:1,actions:1});
});

test('resource eligibility refuses unrelated writes, unknown claims, active descendants and forged owner fences',async()=>{
 const h=await interrupted(),record=h.store.load(scope,h.runId),uncertain=record.receipts.find(row=>row.result.results?.some(x=>x.status==='uncertain'));
 const bads=[];const change=f=>{const copy=structuredClone(record);f(copy);bads.push(copy);};
 change(r=>r.configuration.tools[0].observationRole='none');
 change(r=>r.intents.push({operationKey:'unfinished',kind:'tool',status:'running',payload:{}}));
 change(r=>r.snapshot.childBudgetReservations.push({settledUsageDigest:null}));
 change(r=>r.commands.push({consumed:false,command:{commandId:'pending',kind:'steer',payload:{}}}));
 change(r=>r.receipts.find(x=>x.operationKey===uncertain.operationKey).result.results[0].browserSessionRef.runId='foreign');
 for(const bad of bads)assert.equal(retirableBrowserResources(bad),null);
 const review=h.review();for(const fence of [{...review.fence,externalEffects:true},{...review.fence,oldActionsReplayed:true},
  {...review.fence,runId:'foreign'},{...review.fence,refs:[]}])assert.throws(()=>h.store.retireResources(scope,h.runId,{...review,fence},Date.now()),/invalid_resource_retirement/);
 assert.equal(h.store.load(scope,h.runId).resourceRetirementReview,undefined);
 h.session.append('turn/start',{turn:2});
 await assert.rejects(h.execute({agent:h.agent,input:h.input,turn:2,signal:new AbortController().signal}),{code:'NATIVE_RUN_RECOVERY_REQUIRED'});
 assert.deepEqual(h.counts(),{models:1,actions:1});
});

test('a kernel-classified lost browser reply can retire only its complete owned Run namespace',async()=>{
 const h=await interrupted(),record=h.store.load(scope,h.runId);
 const receipt=record.receipts.find(row=>row.result.results?.some(value=>value.status==='uncertain'));
 const intent=record.intents.find(row=>row.operationKey===receipt.operationKey);
 assert.equal(intent.status,'running');assert.ok(intent.claimedFence>0);
 receipt.status='uncertain';receipt.result={code:'effect_outcome_unknown',recoveryPolicy:null,retryScheduled:false};
 assert.deepEqual(retirableBrowserResources(record),record.snapshot.browserSessionRefs);
 for(const change of [r=>r.snapshot.browserSessionRefs=[],r=>r.configuration.tools[0].observationRole='none',
  r=>r.intents.find(row=>row.operationKey===intent.operationKey).payload.calls.push({name:'inspect',callId:'mixed',arguments:{}}),
  r=>r.intents.find(row=>row.operationKey===intent.operationKey).claimedFence=0,
  r=>r.receipts.find(row=>row.operationKey===receipt.operationKey).result.retryScheduled=true,
  r=>r.receipts.find(row=>row.operationKey===receipt.operationKey).result.code='effect_port_error']){
  const bad=structuredClone(record);change(bad);assert.equal(retirableBrowserResources(bad),null);
 }
 assert.equal(record.receipts.find(row=>row.operationKey===receipt.operationKey).status,'uncertain');
});

test('trusted owner fencing closes only the old SDK owner; lost response retries cannot close a newer turn',async()=>{
 const h=await interrupted(),before=h.store.load(scope,h.runId);let fences=0,closures=0;
 h.hostBinding.nativeTools={retireBrowserResources:async request=>{fences++;assert.deepEqual(request.refs,h.fence().refs);return h.fence();}};
 const ctx={get:name=>name==='sessionController'?{resolveAgent:async()=>({agent:h.agent})}:{flush:async()=>true}};
 const lifetime=new AbortController();
 const service=createNativeResourceRetirement({ctx,store:h.store,workspaceId:scope.workspaceId,lifetime,active:new Set(),controls:new Map(),
  controlKey:(a,s)=>a+':'+s,agentEvents:()=>({serial:async()=>h.hostBinding}),
  inspect:async()=>({agent:h.agent,scope,record:h.store.load(scope,h.runId),admission:{}}),
  summary:(_request,value)=>({runId:value.record.snapshot.runId,state:'closed'}),execute:{closeRetiredResources:async request=>{closures++;return h.execute.closeRetiredResources(request);}}});
 const request={agentId:scope.agentId,sessionId:h.session.id,runId:h.runId,commandId:'review-1',eventSeq:before.snapshot.eventSeq,confirmedRetired:true};
 const values=await Promise.all([service(request),service(request)]);assert.equal(values[0].state,'closed');assert.equal(fences,1);assert.equal(closures,1);
 assert.equal(h.agent.externalTurns.pending(),null);assert.equal(h.events.at(-1).data.reason.error.code,'NATIVE_RESOURCE_RESULT_UNKNOWN');
 h.session.append('turn/start',{turn:2});
 const fresh=await h.execute({agent:h.agent,input:h.input,turn:2,signal:new AbortController().signal});
 assert.equal(fresh.reason.kind,'completed');assert.deepEqual(h.counts(),{models:2,actions:1});
 assert.notEqual(h.store.sessionHead(scope,h.session.id).runId,h.runId);
 await service(request);assert.equal(closures,1);assert.equal(fences,1);assert.equal(h.agent.externalTurns.pending().turn,2);
 for(const key of ['snapshot','events','receipts','intents'])assert.deepEqual(h.store.load(scope,h.runId)[key],before[key]);
});

test('retirement request validation runs before Host loading and the authenticated route carries only operator intent',async()=>{
 const request={agentId:'a',sessionId:'s',runId:'r',commandId:'c',eventSeq:1,confirmedRetired:true};let calls=0;
 const route=createSessionRoutes({getNativeHost:async()=>({retireResources:async value=>{calls++;assert.deepEqual(value,request);return {runId:'r'};}})});
 for(const bad of [{...request,fence:{}},{...request,confirmedRetired:false},{...request,eventSeq:-1}]){
  assert.throws(()=>validateNativeResourceRetirementRequest(bad));await assert.rejects(route('sessions/native-resource-retire',bad,new AbortController().signal));}
 assert.equal(calls,0);assert.equal((await route('sessions/native-resource-retire',request,new AbortController().signal)).ok,true);assert.equal(calls,1);
});

test('a crash after the durable review can finish SDK closure without fencing or dispatching twice',async()=>{
 const h=await interrupted();let fences=0,lose=true;
 h.hostBinding.nativeTools={retireBrowserResources:async()=>{fences++;return h.fence();}};
 const options={ctx:{get:name=>name==='sessionController'?{resolveAgent:async()=>({agent:h.agent})}:{flush:async()=>true}},
  store:h.store,workspaceId:scope.workspaceId,lifetime:new AbortController(),active:new Set(),controls:new Map(),controlKey:(a,s)=>a+':'+s,
  agentEvents:()=>({serial:async()=>h.hostBinding}),inspect:async()=>({agent:h.agent,scope,record:h.store.load(scope,h.runId),admission:{}}),
  summary:(_request,value)=>({runId:value.record.snapshot.runId,state:'closed'}),execute:{closeRetiredResources:async request=>{
   if(lose){lose=false;throw Error('Host stopped after durable review');}return h.execute.closeRetiredResources(request);}}};
 const request={agentId:scope.agentId,sessionId:h.session.id,runId:h.runId,commandId:'review-crash',eventSeq:h.review().eventSeq,confirmedRetired:true};
 await assert.rejects(createNativeResourceRetirement(options)(request),/Host stopped/);
 assert.equal(reviewedResourceInterruption(h.store.load(scope,h.runId)),true);assert.ok(h.agent.externalTurns.pending());
 await createNativeResourceRetirement(options)(request);
 assert.equal(h.agent.externalTurns.pending(),null);assert.equal(fences,1);assert.deepEqual(h.counts(),{models:1,actions:1});
});

test('cold browser retirement uses the original formal timeout to resolve the original owner namespace',async t=>{
 const root=mkdtempSync(join(tmpdir(),'native-retirement-binding-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sessionId='session',runId='retired',timeoutMs=261000;
 const digest=x=>createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
 const runtimeId='studio-browser-'+digest({schema:'agentkit.studio-browser-owner/v1',root:realpathSync(root),sessionId,scope,toolTimeoutMs:timeoutMs});let invoked=0;
 const owner=createNativeDshBrowserTools({workspaceRoot:root,createOwner:async options=>{
  assert.equal(options.runtimeId,runtimeId);assert.equal(options.toolTimeoutMs,timeoutMs);
  return {retireResources:async request=>{invoked++;assert.equal(request.refs[0].runtimeId,runtimeId);return {fenced:true};},close:async()=>{}};
 }});t.after(()=>owner.close());
 const ref=validateBrowserSessionRef({scope,runId,sessionId:'page',runtimeId,workspaceRevision:digest(realpathSync(root))});
 const result=await owner.forSession(sessionId).retireResources({scope,sessionId,runId,refs:[ref],
  definition:{...owner.definition,timeoutMs},signal:new AbortController().signal});
 assert.equal(result.fenced,true);assert.equal(invoked,1);
});

test('cancellation during owner lookup returns promptly and a late binding grants no retirement authority',async()=>{
 const h=await interrupted();let release,entered,fences=0;
 const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
 h.hostBinding.nativeTools={retireBrowserResources:async()=>{fences++;return h.fence();}};
 const service=createNativeResourceRetirement({ctx:{},store:h.store,workspaceId:scope.workspaceId,lifetime:new AbortController(),
  active:new Set(),controls:new Map(),controlKey:(a,s)=>a+':'+s,
  agentEvents:()=>({serial:async()=>{entered();await gate;return h.hostBinding;}}),
  inspect:async()=>({agent:h.agent,scope,record:h.store.load(scope,h.runId),admission:{}}),summary:()=>({}),
  execute:{closeRetiredResources:async()=>assert.fail('No late SDK closure')}});
 const signal=new AbortController(),request={agentId:scope.agentId,sessionId:h.session.id,runId:h.runId,
  commandId:'abort-retirement',eventSeq:h.review().eventSeq,confirmedRetired:true};
 const pending=service(request,signal.signal);await ready;signal.abort(new Error('request ended'));
 await assert.rejects(pending,/request ended/);release();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(fences,0);assert.equal(h.store.load(scope,h.runId).resourceRetirementReview,undefined);
});

test('UI retries the same retirement intent after a lost response and never resumes the unknown action',async()=>{
 let lose=true;const requests=[];const status=()=>({contract:'agentkit.studio-native-recovery/v1',agentId:'a',sessionId:'s',runId:'r',
  phase:'interrupted',state:'reconciliation_required',canResume:false,canReconcile:false,canRetireResources:true,resourceRetirementEventSeq:4});
 const state=createNativeRecoveryState({agentId:'a',sessionId:'s',newCommandId:()=> 'retire-id',hostRemote:{nativeRecoveryStatus:async()=>status(),
  retireNativeResources:async request=>{requests.push(request);if(lose){lose=false;throw Error('lost response');}return {...status(),state:'closed',canRetireResources:false};},
  resumeNativeRun:async()=>assert.fail('Unknown action must not resume')}});
 await state.refresh();await state.retireResources();assert.ok(state.getSnapshot().pending);await state.retry();
 assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].confirmedRetired,true);assert.equal(requests[0].retireResources,undefined);state.dispose();
});
