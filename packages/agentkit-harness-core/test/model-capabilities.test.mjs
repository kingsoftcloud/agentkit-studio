import test from 'node:test';
import assert from 'node:assert/strict';
import { admitModelCapabilities, modelCatalogLimits, modelTokenLimit, validateModelCapabilities } from '../dist/model-capabilities.mjs';

test('catalog capacities decode bounded numeric metadata without inferring an output maximum', () => {
  for (const [input,expected] of [[128000,128000],['1024k',1048576],['1m',1048576],['1.5K',1536],['128000',128000],['huge',null],[-1,null],[Infinity,null],['1e100',null]])
    assert.equal(modelTokenLimit(input),expected);
  assert.deepEqual(modelCatalogLimits({context_length:'1024k',apiKey:'not copied'}),{contextWindow:1048576});
  const fact=admitModelCapabilities({}, {contextWindow:1048576});
  assert.equal(fact.contextWindow,1048576); assert.equal(fact.contextSource,'catalog');
  assert.equal(fact.maxOutputTokens,8192); assert.equal(fact.outputSource,'default'); assert.equal(fact.advertisedMaxOutputTokens,null);
});
test('operating budgets respect both explicit limits and advertised capacity, independently of raw vendor fields', () => {
  const fact=admitModelCapabilities({contextWindow:200000,maxOutputTokens:65536,input:['text','image']},
    {contextWindow:128000,maxOutputTokens:32768,input:['text'],inputKnown:true});
  assert.equal(fact.contextWindow,128000); assert.equal(fact.maxOutputTokens,32768);
  assert.equal(fact.contextSource,'catalog'); assert.equal(fact.outputSource,'catalog'); assert.deepEqual(fact.input,['text']);
  const narrow=admitModelCapabilities({contextWindow:32000,maxOutputTokens:2000},{contextWindow:128000,maxOutputTokens:8192,inputKnown:false});
  assert.equal(narrow.contextWindow,32000);assert.equal(narrow.maxOutputTokens,2000);assert.equal(narrow.contextSource,'profile');
  assert.equal(admitModelCapabilities({}, {contextWindow:8192,maxOutputTokens:8192}).maxOutputTokens,2048);
  const reasoning=admitModelCapabilities({}, {contextWindow:1048576,maxOutputTokens:131072});
  assert.equal(reasoning.maxOutputTokens,131072);assert.equal(reasoning.outputSource,'catalog');
  assert.equal(admitModelCapabilities({maxOutputTokens:32768},{contextWindow:1048576,maxOutputTokens:131072}).maxOutputTokens,32768);
});
test('missing and malformed capacities stay explicitly unknown, and facts reject extra or contradictory fields', () => {
  const fact=admitModelCapabilities({input:['text','image']},null,'unavailable');
  assert.equal(fact.advertisedContextWindow,null);assert.equal(fact.catalogState,'unavailable');assert.deepEqual(fact.input,['text','image']);
  for(const changed of [{credential:'secret'}, {maxOutputTokens:fact.contextWindow},{contextSource:'guess'}, {input:['image']},
    {advertisedContextWindow:1000},{maxOutputTokens:-1}]) assert.throws(()=>validateModelCapabilities({...fact,...changed}),/invalid_model_capabilities/);
});
