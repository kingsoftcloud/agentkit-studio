import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { NativeKernel, MemoryRunStore, emptyUsage, todoToolDefinitions, artifactToolDefinitions } from '../dist/index.mjs';
import { fixture, scope, digest, tool } from './fixtures.mjs';

const todos=Array.from({length:6},(_,i)=>({content:`Source ${i}: ${'evidence '.repeat(100)}`,status:'completed',priority:'high'}));
for(const staged of [true,false]) for(const modern of [false,true]) for(const backend of modern?['memory','sqlite']:['memory']) {
  test(`${backend} ${staged?'kernel staging':'external execution'}: ${modern?'owner policy':'legacy'} keeps the declared deadline boundary`,async t=>{
    const definitions=staged?todoToolDefinitions():[tool({name:'write_fixture',readOnly:false,concurrentSafe:false})];
    const {config,snapshot}=fixture({tools:[...definitions,...artifactToolDefinitions()],
      ...(staged?{todoPolicy:'session-todos/v1'}:{}),...(modern?{toolExecutionPolicy:'owner-execution/v1'}:{}),
      artifactPolicy:'runtime-artifacts/v1',limits:{maxToolResultBytes:1024,maxModelCalls:3,maxToolCalls:4}});
    const directory=backend==='sqlite'?mkdtempSync(join(tmpdir(),'native-tool-phases-')):null;
    const store=directory?new SqliteRunStore(join(directory,'run.sqlite')):new MemoryRunStore();
    if(directory)t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
    let clock=0,models=0,effects=0,archives=0;
    const kernel=new NativeKernel({store,digest,owner:'phases',monotonicNow:()=>clock,ports:{
      model:{generate:async()=>++models===1?{kind:'tool_calls',text:'',toolCalls:[{
        callId:'call',name:staged?'TodoWrite':'write_fixture',arguments:staged?{todos}:{}}],usage:emptyUsage()}
        :{kind:'final_candidate',text:'Actual final answer',toolCalls:[],usage:emptyUsage()}},
      tools:{execute:async()=>{assert.equal(staged,false);effects++;return{status:'ok',content:'observed '.repeat(1000)};}},
      artifacts:{write:async({content,mediaType})=>{
        archives++;clock+=2000; // Post-execution bookkeeping exceeds the 1s tool I/O budget.
        return{uri:`artifact://owned/${archives}`,digest:'sha256:'+createHash('sha256').update(content).digest('hex'),
          sizeBytes:Buffer.byteLength(content),mediaType,metadata:{}};
      }},
    }});
    kernel.start(snapshot,config);const done=await kernel.runUntilIdle(scope,'run');
    assert.equal(archives,1);assert.equal(effects,staged?0:1);
    if(modern){
      assert.equal(done.phase,'completed');assert.equal(done.finalText,'Actual final answer');
      if(staged){assert.deepEqual(done.todos.items,todos);assert.equal(done.todos.revision,1);}
      assert.equal(store.load(scope,'run').events.some(e=>e.kind==='tool.failure_observed'),false);
      await kernel.runUntilIdle(scope,'run');assert.equal(archives,1);assert.equal(effects,staged?0:1);
    }else{
      assert.equal(done.phase,'interrupted');assert.equal(done.reason,'effect_outcome_unknown');
      if(staged)assert.equal(done.todos.revision,0);
    }
  });
}

test('an external tool called TodoWrite does not acquire kernel staging capability',async()=>{
  let clock=0,effects=0,models=0;
  const {config,snapshot}=fixture({toolExecutionPolicy:'owner-execution/v1',tools:[tool({name:'TodoWrite',readOnly:false,concurrentSafe:false})]});
  const store=new MemoryRunStore(),kernel=new NativeKernel({store,digest,owner:'external-todo',monotonicNow:()=>clock,
    ports:{model:{generate:async()=>{models++;return{kind:'tool_calls',text:'',toolCalls:[{callId:'external',name:'TodoWrite',arguments:{}}],usage:emptyUsage()};}},
      tools:{execute:async()=>{effects++;clock+=2000;return{status:'ok',content:'external outcome'};}}}});
  kernel.start(snapshot,config);const done=await kernel.runUntilIdle(scope,'run');
  assert.equal(done.phase,'interrupted');assert.equal(effects,1);assert.equal(models,1);
  assert.equal(done.todos,undefined);
});

test('cancellation during kernel result projection prevents its fenced task-list commit',async()=>{
  const {config,snapshot}=fixture({todoPolicy:'session-todos/v1',toolExecutionPolicy:'owner-execution/v1',
    tools:[...todoToolDefinitions(),...artifactToolDefinitions()],artifactPolicy:'runtime-artifacts/v1',limits:{maxToolResultBytes:1024}});
  const store=new MemoryRunStore();let models=0,archives=0;
  const kernel=new NativeKernel({store,digest,owner:'cancel-staging',ports:{
    model:{generate:async()=>{models++;return{kind:'tool_calls',text:'',toolCalls:[{name:'TodoWrite',callId:'write',arguments:{todos}}],usage:emptyUsage()};}},
    tools:{execute:async()=>assert.fail('kernel update cannot enter external execution')},
    artifacts:{write:async({content,mediaType})=>{
      archives++;kernel.submit(scope,'run',{commandId:'cancel',kind:'cancel',payload:{}});
      return{uri:'artifact://owned/cancelled',digest:'sha256:'+createHash('sha256').update(content).digest('hex'),
        sizeBytes:Buffer.byteLength(content),mediaType,metadata:{}};
    }},
  }});
  kernel.start(snapshot,config);const done=await kernel.runUntilIdle(scope,'run');
  assert.equal(done.phase,'canceled');assert.equal(done.todos.revision,0);assert.equal(models,1);assert.equal(archives,1);
  assert.equal(store.load(scope,'run').events.some(e=>e.kind==='todo.updated'),false);
});
