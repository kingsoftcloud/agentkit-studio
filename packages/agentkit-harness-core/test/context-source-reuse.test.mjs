import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, tool, digest } from './fixtures.mjs';
import { canonical, artifactToolDefinitions, CAPTURED_SOURCE_MEDIA_TYPE, planNativeContext, validateContextMessages, projectSessionHistory } from '../dist/index.mjs';
import { sourceReuseProjector } from '../dist/context-source-reuse.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeKernel, MemoryRunStore, emptyUsage } from '../dist/index.mjs';
import { createNativeArtifactStore } from '../../agentkit-harness-node/src/native/artifact-store.mjs';

const policy={tokenizerId:'reuse-counter',tokenizerDigest:'reuse/v1',enabled:true,triggerRatio:.72,targetRatio:.45,summaryMaxTokens:80,
  maxCompactions:null,maxCompactionsWithoutProgress:4,minModelTurnsBetween:2,maxSummaryRetries:2,sourceReusePolicy:'captured-source/v1'};
function setup(){
  const read=tool({name:'read_workspace_file',contextRole:'workspace_read',sourceObservationPolicy:'workspace-source-model/v1',resultArchivePolicy:'archived-model-view/v5'});
  const {config,snapshot}=fixture({tools:[read,...artifactToolDefinitions()],artifactPolicy:'runtime-artifacts/v1',sourceReadPolicy:'studio-source-read/v1',contextPolicy:policy,
    profile:{profileId:'test',profileVersion:'1',providerFamily:'openai-chat',compatibilityDigest:'reuse/v1',contextWindow:128000,maxOutputTokens:1024}});
  const source='Actual source row.\n'.repeat(500),sourceDigest='sha256:'+digest(source),pairs=[];
  for(const id of ['first','duplicate','fresh']){
    const uri='artifact://scope/'+id,call={callId:id,name:read.name,arguments:{path:'source.txt'}};
    const content=canonical({status:'ok',artifact_uri:uri,artifact_state:'available',artifact_instruction:'Read granted artifact if needed.',
      content:{ok:true,path:'source.txt',content:source,start_line:1,end_line:500,line_count:500,total_lines:500,read_range:{start:1,end:500},partial:false,truncated:false}});
    pairs.push([{role:'assistant',content:'',toolCalls:[call]},{role:'tool',callId:id,name:read.name,content,toolOutcome:'ok'}]);
    snapshot.artifactRefs.push({uri,digest:sourceDigest,sizeBytes:source.length,mediaType:CAPTURED_SOURCE_MEDIA_TYPE,metadata:{policy:'runtime-artifacts/v1',toolName:read.name}});
  }
  snapshot.messages.push(...pairs.flat());return{config,snapshot,pairs};
}
const reused=messages=>messages.filter(message=>message.content.includes('historical_source_reused'));
test('only older duplicate text is folded; the first retained observation and entire fresh batch remain verbatim',()=>{
  const f=setup(),before=structuredClone(f.snapshot),view=sourceReuseProjector(f.snapshot,f.config,digest)(f.snapshot.messages);
  assert.equal(reused(view).length,1);assert.equal(view.at(-1).content,f.snapshot.messages.at(-1).content);
  assert.equal(view[2].content,f.snapshot.messages[2].content);
  const ref=JSON.parse(reused(view)[0].content);assert.equal(ref.retained_call_id,'first');assert.equal(ref.artifact_uri,'artifact://scope/duplicate');
  validateContextMessages(view);assert.deepEqual(f.snapshot,before);
});
for(const invalid of ['outcome','media','persistent','grant','digest','state','path','envelope','definition','disabled'])
  test(`unproven or different ${invalid} cannot fold a source observation`,()=>{
    const f=setup(),message=f.pairs[1][1];
    if(invalid==='outcome')delete message.toolOutcome;
    if(invalid==='media')message.media=[{type:'image_url',image_url:{url:'data:image/png;base64,AQ=='}}];
    if(invalid==='persistent')message.persistent=true;
    if(invalid==='grant')f.snapshot.artifactRefs.splice(1,1);
    if(invalid==='digest')f.snapshot.artifactRefs[1].digest='sha256:'+'b'.repeat(64);
    if(['state','path','envelope'].includes(invalid)){
      const content=JSON.parse(message.content);
      if(invalid==='state')content.artifact_state='unavailable';
      if(invalid==='path')content.content.path='other.txt';
      if(invalid==='envelope')content.content.partial=true;
      message.content=canonical(content);
    }
    if(invalid==='definition')f.config.tools[0].sourceObservationPolicy=undefined;
    if(invalid==='disabled')f.config.contextPolicy.enabled=false;
    assert.equal(reused(sourceReuseProjector(f.snapshot,f.config,digest)(f.snapshot.messages)).length,0);
  });
test('selection and earlier cleanup cannot remove the anchor or resurrect a cleared body',()=>{
  const f=setup(),project=sourceReuseProjector(f.snapshot,f.config,digest);
  const selected=[f.snapshot.messages[0],...f.pairs[1],...f.pairs[2]];
  assert.equal(reused(project(selected)).length,0,'The first actually retained body becomes the anchor');
  const cleared=structuredClone(f.snapshot.messages);cleared[2].content='{"type":"historical_tool_result_cleared"}';
  const view=project(cleared);assert.equal(reused(view).length,0);assert.equal(view[2].content,cleared[2].content);
});
test('omitted historical bodies are not inspected by the per-view source index',()=>{
  const f=setup(),message=f.pairs[1][1],body=message.content;let visits=0;
  Object.defineProperty(message,'content',{get(){visits++;return body;},enumerable:true});
  const project=sourceReuseProjector(f.snapshot,f.config,digest);
  const selected=[f.snapshot.messages[0],...f.pairs[0],...f.pairs[2]];
  project(selected);project(selected);assert.equal(visits,0);
});
test('all calls in the most recent parallel batch remain full observations',()=>{
  const f=setup(),parallel=[...f.snapshot.messages.slice(0,3),{role:'assistant',content:'',toolCalls:[...f.pairs[1][0].toolCalls,...f.pairs[2][0].toolCalls]},f.pairs[1][1],f.pairs[2][1]];
  assert.equal(reused(sourceReuseProjector(f.snapshot,f.config,digest)(parallel)).length,0);validateContextMessages(parallel);
});
test('the planner counts and admits the reused view while the canonical source transcript stays unchanged',async()=>{
  const f=setup(),before=structuredClone(f.snapshot);
  const counters={countRequest:async(messages,tools)=>Math.ceil(canonical({messages,tools}).length/4),countText:async text=>Math.ceil(text.length/4)};
  const planned=await planNativeContext(f.snapshot,f.config,f.config.tools,counters,digest,false,true);
  assert.equal(planned.action,'ready');assert.equal(reused(planned.messages).length,1);
  assert.equal(planned.admission.countedInputTokens,await counters.countRequest(planned.messages,f.config.tools));
  assert.deepEqual(f.snapshot,before);validateContextMessages(planned.messages);
});
test('legacy immediate history is enriched only by the exact committed receipt, never status prose or older ancestry',()=>{
  for(const kind of ['known','error','different-view','older-ancestry']){
    const f=setup(),messages=f.pairs.slice(0,1).flat();delete messages[1].toolOutcome;
    if(kind==='older-ancestry')messages[1].history={sourceRunId:'older',sourceIndex:2};
    const parent={configuration:f.config,snapshot:{...f.snapshot,phase:'completed',messages,queuedGuidance:[],finalText:''},
      intents:[{operationKey:'op',kind:'tool',payload:{calls:messages[0].toolCalls}}],receipts:[{operationKey:'op',status:'committed',result:{results:[{
        status:kind==='error'?'error':'ok',content:{private:'not used'},context:{content:kind==='different-view'?'different':messages[1].content}}]}}]};
    const before=structuredClone(parent),history=projectSessionHistory(parent,f.config,digest),result=history.find(message=>message.role==='tool');
    assert.equal(result.toolOutcome,kind==='known'?'ok':undefined);assert.deepEqual(parent,before);
  }
});

test('actual file reads and runtime-issued archives produce a smaller counted view without rewriting any receipt',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'native-source-reuse-')),workspace=join(directory,'workspace');mkdirSync(workspace);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const source='Actual source row.\n'.repeat(500);writeFileSync(join(workspace,'source.txt'),source);
  const f=setup(),store=new MemoryRunStore(),artifacts=await createNativeArtifactStore({directory:join(directory,'artifacts'),scope:f.snapshot.scope});
  f.snapshot.messages=f.snapshot.messages.slice(0,1);f.snapshot.artifactRefs=[];
  let models=0,reads=0,observedSavings=0;const counted=[];
  const kernel=new NativeKernel({store,digest,owner:'worker',ports:{artifacts,
    context:{tokens:{tokenizerId:'reuse-counter',tokenizerDigest:'reuse/v1',countText:async request=>Math.ceil(request.text.length/4),
      countMessage:async request=>Math.ceil(canonical(request.message).length/4),
      countRequest:async request=>{counted.push(structuredClone(request.messages));return Math.ceil(canonical({messages:request.messages,tools:request.tools}).length/4);}}},
    model:{generate:async request=>{
      validateContextMessages(request.messages);assert.ok(counted.some(messages=>canonical(messages)===canonical(request.messages)));
      if(++models<=3)return{kind:'tool_calls',text:'',toolCalls:[{callId:'read-'+models,name:'read_workspace_file',arguments:{path:'source.txt'}}],usage:emptyUsage()};
      const reusedRows=reused(request.messages);assert.equal(reusedRows.length,1);
      const original=store.load(f.snapshot.scope,'run').snapshot.messages.find(message=>message.callId===reusedRows[0].callId&&message.role==='tool');
      observedSavings=original.content.length-reusedRows[0].content.length;assert.ok(observedSavings>8000);
      return{kind:'final_candidate',text:'Actual file observations retained.',toolCalls:[],usage:emptyUsage()};
    }},tools:{execute:async()=>{
      reads++;const content=readFileSync(join(workspace,'source.txt'),'utf8');
      return{status:'ok',content:{ok:true,path:'source.txt',content,start_line:1,end_line:500,line_count:500,total_lines:500,
        read_range:{start:1,end:500},partial:false,truncated:false,requested_source:{path:'source.txt',content,read_range:{start:1,end:500}}}};
    }}}});
  kernel.start(f.snapshot,f.config);const result=await kernel.runUntilIdle(f.snapshot.scope,'run');
  const record=store.load(f.snapshot.scope,'run');
  assert.equal(result.phase,'completed',JSON.stringify({reason:result.reason,models,reads,refs:result.artifactRefs,
    tools:record.snapshot.messages.filter(message=>message.role==='tool').map(message=>({outcome:message.toolOutcome,content:message.content.slice(0,400)}))}));
  assert.equal(reads,3);assert.ok(observedSavings>8000);
  const original=store.load(f.snapshot.scope,'run');assert.equal(original.snapshot.contextState.compactions,0);
  const sources=original.snapshot.messages.filter(message=>message.role==='tool');assert.equal(sources.length,3);
  assert.ok(sources.every(message=>message.content.includes(source.split('\n')[0])&&!message.content.includes('historical_source_reused')));
  assert.ok(original.receipts.filter(receipt=>receipt.result.results).every(receipt=>receipt.result.results.every(result=>result.content.content===source)));
});
