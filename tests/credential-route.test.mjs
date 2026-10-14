import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../src/host/bootstrap.mjs',import.meta.url),'utf8');
const start = source.indexOf("      if (endpoint === 'credentials/put') {");
const body = source.slice(start,source.indexOf("      if (endpoint === 'mcp/create')",start));
const route = service => new Function('credentialsService',`return async payload => { const endpoint='credentials/put'; ${body} };`)(service);
test('an environment credential is acknowledged only when the submitted value is identical',async()=>{
 const failure = Object.assign(new Error('environment credentials are read-only'),{code:'READ_ONLY'});
 const handler = route({set:async()=>{throw failure;},describe:async()=>({configured:true,source:'env'}),resolve:async()=>({value:'e2e-existing'})});
 assert.equal((await handler({name:'E2E_KEY',value:'e2e-existing'})).value.source,'env');
 await assert.rejects(()=>handler({name:'E2E_KEY',value:'e2e-different'}),{code:'READ_ONLY'});
});
test('successful DSH credential writes report durable managed storage',async()=>{
 const result = await route({set:async()=>{}})({name:'E2E_KEY',value:'e2e-value',persistence:'session'});
 assert.equal(result.value.persistence,'managed-store');
});
