import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelService} from '../src/model-service.mjs';
import {createModelBridge,DSH_MODEL_SETTINGS_NS,DSH_DEFAULT_MODEL_SETTINGS_NS} from '../src/client/dsh/model-bridge.mjs';
const profile={id:'profile',provider:'custom',modelName:'actual',baseUrl:'https://gateway.invalid/v1',input:['text','image']};

test('Studio UI and Native admission share actual normalized capacities rather than different constants',async()=>{
  let reads=0;const namespaces=[{ns:DSH_MODEL_SETTINGS_NS,revision:1,value:{providers:{}}},{ns:DSH_DEFAULT_MODEL_SETTINGS_NS,revision:1,value:{}}];
  const service=createModelService({configuration:{resolve:async()=>({values:{modelProfiles:[profile]}})},credentials:{resolve:async()=>({value:'private'})},
    fetchImpl:async()=>{reads++;return new Response(JSON.stringify({data:[{id:'actual',context_length:'1024k',max_output_tokens:65536,input_modalities:['text']},
      {id:'other',context_window:32000,max_completion_tokens:4096}]}));}});
  const selected=await service.profile('profile'); const [a,b]=await Promise.all([service.capabilities(selected),service.capabilities(selected)]);
  assert.equal(reads,1);assert.deepEqual(a,b);assert.equal(a.advertisedMaxOutputTokens,65536);assert.equal(a.maxOutputTokens,65536);
  const writes=[];
  const bridge=createModelBridge({hostRemote:{modelCatalog:id=>service.catalog(id)}}).createDshModelBridge({remote:{settings:{
    describe:async()=>({ok:true,value:{namespaces}}),mutate:async(ns,ops)=>{writes.push({ns,ops});return {ok:true};}},credentials:{set:()=>assert.fail('No credential write requested')}}});
  await bridge.applyProfiles({profiles:[profile]});
  const models=writes[0].ops.find(op=>op.op==='set').value.models;
  assert.equal(models[0].contextWindow,a.contextWindow);assert.equal(models[0].maxTokens,a.maxOutputTokens);assert.deepEqual(models[0].input,a.input);
  assert.equal(models[1].contextWindow,32000);assert.equal(models[1].maxTokens,4096);assert.deepEqual(models[1].input,['text']);
  assert.equal(JSON.stringify(writes).includes('private'),false);
});
test('unavailable model catalogs expose unknown maxima and a bounded operating fallback without copying provider errors',async()=>{
  const service=createModelService({configuration:{resolve:async()=>({values:{modelProfiles:[profile]}})},credentials:{resolve:async()=>({value:'private'})},
    fetchImpl:async()=>{throw Error('private transport details');}});
  const fact=await service.capabilities(await service.profile('profile'));
  assert.equal(fact.catalogState,'unavailable');assert.equal(fact.advertisedMaxOutputTokens,null);assert.equal(fact.maxOutputTokens,8192);
  assert.equal(JSON.stringify(fact).includes('private'),false);
});
