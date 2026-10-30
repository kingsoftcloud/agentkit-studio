import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NativeKernel, canonical, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';

test('C1/C8 local contract: three concurrent session kinds resume their exact committed history after SIGKILL', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-multi-session-')), filename = join(directory, 'runs.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scope = { tenantId: 'contract-tenant', workspaceId: 'contract-workspace', userId: 'contract-owner', agentId: 'contract-agent' };
  const sessions = ['private-main', 'independent-task', 'group-conversation'];
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {NativeKernel,configure,canonical,emptyUsage} from '@kingsoftcloud/agentkit-harness-core';
    import {SqliteRunStore} from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
    import {createHash} from 'node:crypto';
    const scope=${JSON.stringify(scope)}, sessions=${JSON.stringify(sessions)}, store=new SqliteRunStore(${JSON.stringify(filename)});
    const counts=new Map(); let waiting=0;
    const kernel=new NativeKernel({store,owner:'killed-owner',now:()=>100,digest:v=>createHash('sha256').update(canonical(v)).digest('hex'),ports:{
      model:{generate:async request=>{
        const count=(counts.get(request.sessionId)||0)+1;counts.set(request.sessionId,count);
        if(count===1)return {kind:'tool_calls',text:'',toolCalls:[{callId:'read-'+request.sessionId,name:'read',arguments:{}}],usage:emptyUsage()};
        if(++waiting===3) process.kill(process.pid,'SIGKILL');
        return new Promise(()=>{});
      }},tools:{execute:async request=>({status:'ok',content:'committed evidence for '+request.sessionId})}
    }});
    for(const sessionId of sessions)kernel.start({scope,sessionId,runId:sessionId,turnId:'turn',buildId:'contract-build',parentRunId:null,taskChainId:sessionId},configure({
      profile:{profileId:'contract',profileVersion:'1',providerFamily:'fixture',compatibilityDigest:'contract/v1'},
      contract:{objective:'Task '+sessionId},hostBindingDigest:'contract-host',modelRecoveryPolicy:'pure-inference/v1',
      limits:{leaseMs:1000,maxModelCalls:4},tools:[{name:'read',description:'Read evidence',parameters:{type:'object'},readOnly:true,concurrentSafe:true,permissions:[],timeoutMs:1000,contextRole:'none',observationRole:'none',progressObservation:false,contextRetention:'normal'}]
    }));
    await Promise.all(sessions.map(sessionId=>kernel.runUntilIdle(scope,sessionId)));
  `], { encoding: 'utf8', cwd: process.cwd(), timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const store = new SqliteRunStore(filename); t.after(() => store.close());
  const before = new Map(sessions.map(session => [session, store.load(scope, session)]));
  let recovered = 0;
  const kernel = new NativeKernel({ store, owner: 'replacement-owner', now: () => 50000,
    digest: value => createHash('sha256').update(canonical(value)).digest('hex'), ports: {
      model: { generate: async request => {
        recovered++;
        assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes(`committed evidence for ${request.sessionId}`)));
        for (const other of sessions.filter(session => session !== request.sessionId))
          assert.equal(JSON.stringify(request.messages).includes(`committed evidence for ${other}`), false);
        return { kind: 'final_candidate', text: `Recovered ${request.sessionId}`, toolCalls: [], usage: emptyUsage() };
      } }, tools: { execute: async () => assert.fail('Committed tools must not execute twice') },
    } });
  for (const session of sessions) {
    const result = await kernel.runUntilIdle(scope, session);
    assert.equal(result.phase, 'completed'); assert.equal(result.sessionId, session);
    const after = store.load(scope, session);
    assert.deepEqual(after.events.slice(0, before.get(session).events.length), before.get(session).events);
    assert.deepEqual(after.configuration, before.get(session).configuration);
    assert.ok(after.receipts.some(receipt => receipt.status === 'uncertain'), 'Lost inference remains visible');
    assert.equal(after.snapshot.usage.toolCalls, 1);
  }
  assert.equal(recovered, 3);
});
