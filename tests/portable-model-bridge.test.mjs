import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPortableModelProfiles } from '../src/portable-model-bridge.mjs';

test('headless import registers exact model routes via public DSH Settings and preserves other providers', async () => {
 const providers={existing:{api:'existing'}}, writes=[];
 const settings={describe:()=>[{ns:'llm-pi-ai',revision:7,value:{providers}}],mutate:async(ns,ops,revision)=>{
   assert.equal(ns,'llm-pi-ai');assert.equal(revision,7);writes.push(ops);
   for(const op of ops){assert.equal(op.op,'set');providers[op.path[1]]=op.value;}
 }};
 const profiles=[{id:'bound-model',provider:'custom',modelName:'upstream-model',baseUrl:'https://model.example/v1',credentialName:'TARGET_KEY',input:['text','image']}];
 await syncPortableModelProfiles({settings,profiles});
 assert.deepEqual(providers.existing,{api:'existing'});
 assert.equal(providers['agentkit-studio-bound-model'].models[0].id,'upstream-model');
 assert.equal(providers['agentkit-studio-bound-model'].apiKeyEnv,'TARGET_KEY');
 await syncPortableModelProfiles({settings,profiles});assert.equal(writes.length,1);
});

test('headless import rejects unavailable settings and colliding model routes', async () => {
 await assert.rejects(syncPortableModelProfiles({settings:{describe:()=>[]},profiles:[]}),{code:'PORTABLE_MODEL_BRIDGE_UNAVAILABLE'});
 const profiles=[{id:'a-b',modelName:'a'},{id:'a_b',modelName:'b'}];
 await assert.rejects(syncPortableModelProfiles({settings:{describe:()=>[{ns:'llm-pi-ai',value:{}}],mutate:()=>{throw new Error('must not mutate');}},profiles}),{code:'PORTABLE_MODEL_ROUTE_COLLISION'});
});
