import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, DELIVERY_SCOPE_POLICY, deliveryToolDefinitions, executeDelivery, reduceDelivery,
  deliveryArtifacts, currentDeliveryManifest, invalidatesBrowserObservation, webObservationDue, sealCandidate,
  checkpointCandidate, reduceVerification, configure, canonical, emptyUsage } from '../dist/index.mjs';
import { prepareEffect } from '../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from './fixtures.mjs';
const declaration = artifacts => ({ callId: 'declare', name: 'declare_deliverables', arguments: { artifacts } });
const configured = () => fixture({ deliveryScopePolicy: DELIVERY_SCOPE_POLICY, tools: [...deliveryToolDefinitions(),
  tool({ name: 'browser', observationRole: 'browser', readOnly: false, concurrentSafe: false })], workspaceObservationPolicy: { role: 'browser', pathSuffixes: ['.js', '.html'] },
  limits: { browserObservationIntervalToolCalls: 1 } });

test('declarations are bounded relative subjects and never an acceptance or permission grant', () => {
  for (const artifacts of [[{path:'../x',kind:'file'}], [{path:'/x',kind:'file'}], [{path:'a\\b',kind:'file'}],
    [{path:'x',kind:'file',root:'.'}], [{path:'a/index.html',kind:'web',root:'b'}], [{path:'x.html',kind:'web'}],
    [{path:'x',kind:'file'},{path:'x',kind:'file'}], [{path:'a.html',kind:'web',root:'.'},{path:'b.html',kind:'web',root:'.'}]])
    assert.throws(() => deliveryArtifacts(artifacts), /invalid_/);
  const {config,snapshot} = configured(), call = declaration([{path:'report.md',kind:'file'}]);
  assert.throws(()=>deliveryArtifacts(Array.from({length:10},(_,n)=>({path:`${n}/`+'文'.repeat(1000),kind:'file'}))),/delivery_scope_too_large/);
  const result = executeDelivery(snapshot,config,call);
  assert.equal(result.content.acceptance,'unverified'); assert.equal(snapshot.deliveryManifest,undefined);
  const changes = reduceDelivery(snapshot,config,call,result);
  assert.equal(changes.verification,null);assert.equal(changes.verificationToolCalls,null);
  assert.deepEqual(changes.deliveryManifest.artifacts,call.arguments.artifacts);
  assert.throws(() => reduceDelivery(snapshot,config,call,{...result,content:{...result.content,acceptance:'verified'}}),/invalid_delivery_receipt/);
  assert.equal(executeDelivery(snapshot,config,declaration([{path:'../bad',kind:'file'}])).status,'error');
});

test('reference sources do not activate browser cadence; only the declared current web project does', () => {
  const {config,snapshot} = configured(), source = {status:'ok',content:{},workspaceChangedPaths:['refs/source.js']};
  assert.equal(invalidatesBrowserObservation(source,config,snapshot),false);
  assert.equal(checkpointCandidate({...snapshot,workspaceDirtySinceCheckpoint:true,lastWorkspaceMutationToolCall:1},config,digest),null);
  let current = {...snapshot,...reduceDelivery(snapshot,config,declaration([]),executeDelivery(snapshot,config,declaration([])))};
  assert.equal(invalidatesBrowserObservation(source,config,current),false);
  assert.equal(webObservationDue({...current,lastWebMutationToolCall:1,usage:{...current.usage,toolCalls:10}},config),false);
  const call = declaration([{path:'game/index.html',kind:'web',root:'game'}]);
  current = {...current,...reduceDelivery(current,config,call,executeDelivery(current,config,call))};
  assert.equal(invalidatesBrowserObservation(source,config,current),false);
  assert.equal(invalidatesBrowserObservation({...source,workspaceChangedPaths:['game/app.js']},config,current),true);
  assert.equal(currentDeliveryManifest({...current,goalRevision:current.goalRevision+1}),null);
  assert.equal(invalidatesBrowserObservation({...source,workspaceChangedPaths:['game/app.js']},config,{...current,goalRevision:current.goalRevision+1}),false);
  const candidate = {candidateId:'candidate',text:'Done',workspaceRevision:'rev',goalRevision:current.goalRevision};
  assert.notEqual(sealCandidate(candidate,snapshot,config,digest).binding.subjectContextDigest,
    sealCandidate(candidate,current,config,digest).binding.subjectContextDigest);
});

for (const backend of ['memory','sqlite']) test(`${backend}: policy receipts survive cold attachment without external dispatch or declaration leakage`, async t => {
  const directory = mkdtempSync(join(tmpdir(),'delivery-policy-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  let store = backend === 'sqlite' ? new SqliteRunStore(join(directory,'runs.sqlite')) : new MemoryRunStore();
  const {config,snapshot} = configured(); let models=0;
  const ports = {tools:{execute:async()=>assert.fail('pure delivery policy must not call Host tool ports')}, model:{generate:async()=>{
    models++; return models===1 ? {kind:'tool_calls',text:'',usage:emptyUsage(),toolCalls:[declaration([{path:'report.md',kind:'file'}])]}
      : {kind:'final_candidate',text:'Done',usage:emptyUsage(),toolCalls:[]};
  }}};
  let paused=false;
  let kernel = new NativeKernel({store,digest,owner:'delivery',ports,onCheckpoint:async state=>{
    if(state.deliveryManifest&&!paused){paused=true;kernel.submit(scope,'run',{commandId:'pause',kind:'pause',payload:{}});}
  }}); kernel.start(snapshot,config);
  assert.equal((await kernel.runUntilIdle(scope,'run')).phase,'paused');
  const saved=store.load(scope,'run').snapshot.deliveryManifest; assert.equal(saved.artifacts[0].path,'report.md');
  if(backend==='sqlite'){store.close();store=new SqliteRunStore(join(directory,'runs.sqlite'));t.after(()=>store.close());}
  kernel=new NativeKernel({store,digest,owner:'delivery',ports});kernel.attach(scope,'run');
  assert.deepEqual(store.load(scope,'run').snapshot.deliveryManifest,saved);
  kernel.submit(scope,'run',{commandId:'resume',kind:'resume',payload:{}});
  assert.equal((await kernel.runUntilIdle(scope,'run')).phase,'completed');
  const other=fixture();kernel.start({...other.snapshot,runId:'other',sessionId:'other'},other.config);
  assert.equal(store.load(scope,'other').snapshot.deliveryManifest,undefined);
});

test('frozen legacy configurations do not acquire new scope behavior', () => {
  const {config}=fixture();const before=canonical(config);
  assert.equal(canonical(configure(config)),before);assert.equal(Object.hasOwn(config,'deliveryScopePolicy'),false);
  assert.throws(()=>configure({...config,deliveryScopePolicy:DELIVERY_SCOPE_POLICY}),/delivery_tool_binding_invalid/);
});

test('a lost claimed declaration is reconciled from its pure policy without external replay', async () => {
  const {config,snapshot}=configured(),store=new MemoryRunStore();store.create(config,snapshot);
  const lease=store.acquire(scope,'run','lost',1,1),calls=[declaration([{path:'report.md',kind:'file'}])];
  const batch=prepareEffect(snapshot,'tool','executing_tools',{calls,interaction:null},{pendingTools:calls,
    messages:[...snapshot.messages,{role:'assistant',content:'',toolCalls:calls}]});
  store.commit(scope,'run',lease,1,0,batch);store.claim(scope,'run',lease,1,batch.snapshot.pendingIntent);
  const kernel=new NativeKernel({store,digest,owner:'recovered',now:()=>100,ports:{
    tools:{execute:async()=>assert.fail('no external replay')},model:{generate:async()=>({kind:'final_candidate',text:'Done',toolCalls:[],usage:emptyUsage()})}}});
  const done=await kernel.runUntilIdle(scope,'run');
  assert.equal(done.phase,'completed');assert.equal(done.deliveryManifest.revision,1);assert.equal(done.usage.toolCalls,1);
  assert.equal(store.load(scope,'run').receipts.find(r=>r.operationKey===batch.snapshot.pendingIntent).result.recoveryPolicy,DELIVERY_SCOPE_POLICY);
});

test('a required Host blocker at a checkpoint stops model repair for the declared scope', () => {
  const {config,snapshot}=configured();
  config.contract.acceptance=[{id:'delivery',required:true,verifierRef:'host',verifierVersion:'1',verificationMethod:'deterministic',description:'delivery'}];
  const candidate=sealCandidate({candidateId:'candidate',text:'',purpose:'checkpoint',workspaceRevision:'revision',goalRevision:snapshot.goalRevision},snapshot,config,digest);
  const current={...snapshot,candidate};
  const report={status:'failed',reason:'host_unavailable',candidateId:candidate.candidateId,contractRevision:config.contract.revision,
    workspaceRevision:'revision',binding:candidate.binding,checks:[{id:'delivery',status:'blocked',verifierId:'host',verifierVersion:'1',
      verificationMethod:'deterministic',evidence:{},evidenceRefs:['host://blocker'],safeSummary:'Browser unavailable',repairable:false}]};
  const changes=reduceVerification(current,report,config,digest);
  assert.equal(changes.outcome,'blocked');assert.equal(changes.phase,'finalizing');assert.equal(changes.repairs,undefined);
  const legacy={...config};delete legacy.deliveryScopePolicy;
  assert.equal(reduceVerification(current,report,legacy,digest).outcome,null);
});
