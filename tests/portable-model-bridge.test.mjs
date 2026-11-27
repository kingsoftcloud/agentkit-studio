import test from 'node:test';
import assert from 'node:assert/strict';
import { syncPortableModelProfiles } from '../src/portable-model-bridge.mjs';
import { admitModelCapabilities } from '@kingsoftcloud/agentkit-harness-core/model-capabilities';

test('headless import registers exact model routes via public DSH Settings and preserves other providers', async () => {
 const providers={existing:{api:'existing'}}, writes=[];
 const settings={describe:()=>[{ns:'llm-pi-ai',revision:7,value:{providers}}],mutate:async(ns,ops,revision)=>{
   assert.equal(ns,'llm-pi-ai');assert.equal(revision,7);writes.push(ops);
   for(const op of ops){assert.equal(op.op,'set');providers[op.path[1]]=op.value;}
 }};
 const profiles=[{id:'bound-model',provider:'custom',modelName:'upstream-model',baseUrl:'https://model.example/v1',credentialName:'TARGET_KEY',input:['text','image']}];
 await syncPortableModelProfiles({settings,profiles});
 assert.deepEqual(providers.existing,{api:'existing'});
 assert.equal(providers['agentkit-studio-custom-https-model-example-v1'].models[0].id,'upstream-model');
 assert.equal(providers['agentkit-studio-custom-https-model-example-v1'].apiKeyEnv,'TARGET_KEY');
 await syncPortableModelProfiles({settings,profiles});assert.equal(writes.length,1);
});

test('headless import rejects unavailable settings and colliding model routes', async () => {
 await assert.rejects(syncPortableModelProfiles({settings:{describe:()=>[]},profiles:[]}),{code:'PORTABLE_MODEL_BRIDGE_UNAVAILABLE'});
 const profiles=[{id:'a-b',modelName:'a'},{id:'a_b',modelName:'b'}];
 await assert.rejects(syncPortableModelProfiles({settings:{describe:()=>[{ns:'llm-pi-ai',value:{}}],mutate:()=>{throw new Error('must not mutate');}},profiles}),{code:'PORTABLE_MODEL_ROUTE_COLLISION'});
});

test('advertised catalog window replaces the default without inflating the output budget', async () => {
 const providers={}, writes=[];
 const settings={describe:()=>[{ns:'llm-pi-ai',revision:3,value:{providers}}],mutate:async(ns,ops,revision)=>{
   assert.equal(ns,'llm-pi-ai');assert.equal(revision,3);writes.push(ops);for(const op of ops)providers[op.path[1]]=op.value;}};
 const profiles=[{id:'default',modelName:'deepseek-v4.1-flash-1017',provider:'openai-compatible',baseUrl:'http://gateway.example/v1',credentialName:'AGENTKIT_MODEL_API_KEY'}];
 // The gateway advertises "1024k" context and "384k" completion budget.
 await syncPortableModelProfiles({settings,profiles,capabilities:profile=>admitModelCapabilities(profile,{context_length:'1024k',max_completion_tokens:'384k'})});
 const models=providers['agentkit-studio-openai-compatible-http-gateway-example-v1'].models;
 assert.equal(models[0].contextWindow,1048576);
 assert.equal(models[0].maxTokens,8192);
 await syncPortableModelProfiles({settings,profiles,capabilities:profile=>admitModelCapabilities(profile,{context_length:'1024k'})});
 assert.equal(writes.length,1);
});

test('an unreachable catalog keeps the historical admitted defaults', async () => {
 const providers={},settings={describe:()=>[{ns:'llm-pi-ai',revision:1,value:{providers}}],mutate:async(ns,ops)=>{for(const op of ops)providers[op.path[1]]=op.value;}};
 const profiles=[{id:'default',modelName:'model',provider:'openai-compatible',baseUrl:'https://gateway.example/v1',credentialName:'AGENTKIT_MODEL_API_KEY'}];
 await syncPortableModelProfiles({settings,profiles,capabilities:async()=>{throw new Error('gateway unreachable');}});
 assert.equal(providers['agentkit-studio-openai-compatible-https-gateway-example-v1'].models[0].contextWindow,128000);
 assert.equal(providers['agentkit-studio-openai-compatible-https-gateway-example-v1'].models[0].maxTokens,8192);
});

test('two models of one gateway share a route and keep both in the selector', async () => {
  // The portable projection must carry `connectionId`: the route is keyed by
  // connection, so a projection that dropped it made two models of one gateway
  // look like two different gateways and failed the bundle with
  // PORTABLE_MODEL_ROUTE_COLLISION.
  const providers = {};
  const settings = { describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }],
    mutate: async (ns, ops) => { for (const op of ops) providers[op.path[1]] = op.value; } };
  const gateway = 'https://shared.example/v1';
  const profiles = [
    { id: 'first-model', connectionId: 'shared-gw', provider: 'openai-compatible', modelName: 'first', baseUrl: gateway, credentialName: 'KEY', reasoningEfforts: true, defaultReasoningEffort: 'high' },
    { id: 'second-model', connectionId: 'shared-gw', provider: 'openai-compatible', modelName: 'second', baseUrl: gateway, credentialName: 'KEY' },
  ];
  await syncPortableModelProfiles({ settings, profiles });
  const routes = Object.keys(providers);
  assert.equal(routes.length, 1, `expected one route, got ${routes.join(',')}`);
  assert.deepEqual(providers[routes[0]].models.map(model => model.id), ['first', 'second']);
  // The second model declares no reasoning level; a route default would be
  // sent to it too and rejected with `UNSUPPORTED_REASONING_EFFORT`.
  assert.equal(providers[routes[0]].reasoning, undefined);
  assert.deepEqual(providers[routes[0]].models[0].reasoningEfforts,
    { low: 'low', high: 'high' });
  assert.equal(Object.hasOwn(providers[routes[0]].models[1], 'reasoningEfforts'), false);
});

test('the portable projection forwards connectionId', async () => {
  const { modelRuntimeOptions } = await import('../src/model-profile-contract.mjs');
  assert.deepEqual(modelRuntimeOptions({ connectionId: 'shared-gw', protocol: 'openai-responses' }),
    { connectionId: 'shared-gw', protocol: 'openai-responses' });
});
