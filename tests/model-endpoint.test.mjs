import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeModelEndpoint as normalize} from '../src/model-endpoint.mjs';
test('completes host names, local endpoints and provider defaults',()=>{
  assert.equal(normalize(' api.example.com '),'https://api.example.com/v1');
  assert.equal(normalize('localhost:8000'),'http://localhost:8000/v1');
  assert.equal(normalize('[::1]:8000/v1/'),'http://[::1]:8000/v1');
  assert.equal(normalize('','ksyun'),'http://kspmas.ksyun.com/v1');
  assert.equal(normalize('','openai'),'https://api.openai.com/v1');
});
test('accepts pasted operation URLs and preserves custom gateway prefixes',()=>{
  for(const operation of ['chat/completions','responses','models']) assert.equal(normalize('https://gateway.test/openai/v1/'+operation+'/'),'https://gateway.test/openai/v1');
  assert.equal(normalize('https://gateway.test/custom/'),'https://gateway.test/custom');
  assert.equal(normalize(normalize('api.example.com/v1/chat/completions')),normalize('api.example.com/v1/chat/completions'));
});
test('refuses ambiguous credential-bearing endpoints rather than leaking them into configuration',()=>{
  for(const input of ['ftp://gateway.test',['https://', 'fixture-user:fixture-password', '@gateway.test/v1'].join(''),'https://gateway.test/v1?key=secret','https://gateway.test/#fragment']) assert.throws(()=>normalize(input),{code:'MODEL_ENDPOINT_INVALID'});
});
