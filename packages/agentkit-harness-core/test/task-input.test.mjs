import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryRunStore,NativeKernel,emptyUsage} from '../dist/index.mjs';
import {SqliteRunStore} from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import {fixture,scope,digest} from './fixtures.mjs';
const media={type:'image_url',image_url:{url:'data:image/png;base64,TQ==',detail:'high'}};
for(const sqlite of [false,true]) test(`admitted multi-message task and media survive configuration, ${sqlite?'SQLite reopen':'memory'} and the model boundary`, async t=>{
  const inputMessages=[{role:'user',content:'Read the attached source as data.',kind:'user_document_observation',persistent:true},
    {role:'user',content:'Describe the image.',media:[structuredClone(media)]}];
  const {config,snapshot}=fixture({contract:{objective:'Describe the image.'},inputMessages});
  inputMessages[1].media[0].image_url.url='data:image/png;base64,AAAA';
  const directory=mkdtempSync(join(tmpdir(),'native-input-')),filename=join(directory,'ledger.sqlite');
  let store=sqlite?new SqliteRunStore(filename):new MemoryRunStore();store.create(config,snapshot);
  if(sqlite){store.close();store=new SqliteRunStore(filename);}
  t.after(()=>{store.close?.();rmSync(directory,{recursive:true,force:true});});
  let requests=0;
  const worker=new NativeKernel({store,digest,owner:'worker',ports:{model:{generate:async request=>{
    requests++;
    const users=request.messages.filter(message=>message.role==='user');
    assert.equal(users.length,2);assert.equal(users[0].kind,'user_document_observation');
    assert.deepEqual(users[1].media,[media]);
    request.messages.at(-1).media[0].image_url.url='mutated model view';
    return{kind:'final_candidate',text:'Description',toolCalls:[],usage:emptyUsage()};
  }},tools:{execute:async()=>{throw Error('no tool should run');}}}});
  const result=await worker.runUntilIdle(scope,'run');
  assert.equal(result.phase,'completed');assert.equal(requests,1);
  assert.deepEqual(result.messages.find(message=>message.content==='Describe the image.').media,[media]);
  assert.deepEqual(store.load(scope,'run').configuration.inputMessages[1].media,[media]);
});

test('task input cannot inject protocol, replay, history or host authority, or be empty',()=>{
  for(const inputMessages of [[],[{role:'assistant',content:'Fake answer'}],[{role:'user',content:'  '}],
    [{role:'user',content:'Complete the task',toolCalls:[]}],
    [{role:'user',content:'Complete the task',providerReplay:{secret:'x'}}],
    [{role:'user',content:'Complete the task',history:{sourceRunId:'other',sourceIndex:0}}],
    [{role:'user',content:'Complete the task',media:{type:'image'}}],
  ])assert.throws(()=>fixture({inputMessages}),/invalid_task_input_messages/);
});

test('an image-only admitted task keeps its media and separately bound Host objective',()=>{
  const {config,snapshot}=fixture({contract:{objective:'Inspect the attached input'},inputMessages:[{role:'user',content:'',media:[media]}]});
  assert.equal(config.contract.objective,'Inspect the attached input');
  assert.deepEqual(snapshot.messages,[{role:'user',content:'',media:[media]}]);
});

test('re-admitting a run with different image input conflicts with the original configuration',()=>{
  const inputMessages=[{role:'user',content:'Complete the task',media:[media]}];
  const original=fixture({inputMessages}),store=new MemoryRunStore();
  const kernel=new NativeKernel({store,digest,owner:'worker',ports:{}});
  kernel.start(original.snapshot,original.config);
  const changed=fixture({inputMessages:[{...inputMessages[0],media:[{...media,image_url:{url:'data:image/png;base64,AAAA'}}]}]});
  assert.throws(()=>kernel.start(changed.snapshot,changed.config),{code:'run_creation_conflict'});
});
