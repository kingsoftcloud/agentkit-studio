import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical, configure } from '@kingsoftcloud/agentkit-harness-core';
import { admitModelCapabilities } from '@kingsoftcloud/agentkit-harness-core/model-capabilities';
import { createNativeModelDescriptions, frozenNativeModelDescription } from '../src/providers/native-model-capabilities.mjs';
import { nativeRecoveryBinding, readNativeRecoveryBinding } from '../src/providers/native-recovery-binding.mjs';
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const profiles=['parent','child','vision'].map((id,index)=>({id,provider:'openai',modelName:id,baseUrl:`https://${id}.invalid/v1`,
  input:index===2?['text','image']:['text'],apiKey:'must-not-be-persisted'}));

test('every model, including alternate child and vision models, freezes capability facts and recovers without catalog IO', async()=>{
  let catalogs=0;const signal=new AbortController().signal;
  const initial=createNativeModelDescriptions({signal,models:{capabilities:async profile=>{catalogs++;return admitModelCapabilities(profile,{contextWindow:1048576,maxOutputTokens:65536,input:profile.input});}}});
  await Promise.all(profiles.map(profile=>initial.describe(profile)));
  const manifest=initial.manifest(),before=profiles.map(profile=>initial.get(profile));
  assert.equal(catalogs,3);assert.equal(JSON.stringify(manifest).includes('must-not-be-persisted'),false);
  const capsule=nativeRecoveryBinding({binding:{agentId:'agent',agentRevision:1},input:{messages:[{id:'input',role:'user',content:[{type:'text',text:'Task'}]}]},
    source:{provider:'bound',model:'parent'},selection:{},systemPrompt:'Instructions',modelBindings:manifest});
  const config=configure({profile:{profileId:'parent',profileVersion:hash(before[0]),providerFamily:'fixture',compatibilityDigest:'test/v1'},
    contract:{objective:'Task'},hostBindingDigest:'test/v1',hostRecoveryBinding:capsule});
  const record={configuration:config,snapshot:{scope:{agentId:'agent'},sessionId:'session',runId:'run',configDigest:hash(config)}};
  const restored=readNativeRecoveryBinding(record,{agentId:'agent',sessionId:'session',runId:'run'});
  const recovery=createNativeModelDescriptions({signal,originalCapsule:restored,models:{capabilities:()=>assert.fail('Frozen recovery must not rediscover capabilities')}});
  await Promise.all(profiles.map(profile=>recovery.describe({...profile,apiKey:'rotated-key'})));
  assert.deepEqual(profiles.map(profile=>recovery.get(profile)),before);assert.deepEqual(recovery.manifest(),manifest);
  for(const [field,value] of [['modelName','other'],['baseUrl','https://other.invalid/v1'],['maxOutputTokens',2000],['input',['text','image']]])
    assert.throws(()=>frozenNativeModelDescription({...profiles[0],[field]:value},manifest),/model_binding_changed/);
});
test('old recovery capsules retain their old bindings and never enable capability discovery',async()=>{
  const recovery=createNativeModelDescriptions({signal:new AbortController().signal,originalCapsule:{},models:{capabilities:()=>assert.fail('Legacy binding')}});
  const description=await recovery.describe(profiles[0]);
  assert.equal(description.contextWindow,128000);assert.equal(description.maxOutputTokens,8192);assert.equal(description.capabilities,undefined);
  assert.equal(recovery.manifest(),undefined);
});
