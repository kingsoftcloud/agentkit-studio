import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage, canonical, planNativeContext, validateContextMessages } from '../dist/index.mjs';
import { fixture, tool, scope, digest } from './fixtures.mjs';
import { projectMessagesOpenAI } from '../../agentkit-harness-node/src/native/model-openai-chat.mjs';

const policy = extra => ({ tokenizerId: 'layout-counter', tokenizerDigest: 'layout/v1', enabled: true,
  triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null,
  maxCompactionsWithoutProgress: 4, minModelTurnsBetween: 2, maxSummaryRetries: 2, budgetTiming: 'before-model/v1', ...extra });
const count = (messages, tools) => Math.ceil(canonical({ messages, tools }).length / 4);
const counters = { countRequest: async (messages, tools) => count(messages, tools), countText: async text => Math.ceil(text.length / 4) };
function setup(placement) {
  return fixture({ instructions: 'Stable Host instructions.', tools: [tool()], contextPolicy: policy(placement ? { continuityPlacement: placement } : {}),
    profile: { profileId: 'test', profileVersion: '1', providerFamily: 'openai-chat', compatibilityDigest: 'layout/v1',
      contextWindow: 12000, maxOutputTokens: 128 } });
}
const call = id => ({ callId: id, name: 'read', arguments: {} });
const withoutHost = messages => messages.filter(message => message.kind !== 'execution_continuity');
const common = (a,b) => { let i=0; while(i<Math.min(a.length,b.length)&&a[i]===b[i])i++; return i; };

test('ordered layout preserves every role and byte while moving only current Host state after complete history', async () => {
  const legacy = setup(), ordered = setup('after-history/v1');
  const messages = [...legacy.snapshot.messages, { role: 'assistant', content: '', toolCalls: [call('one')] },
    { role: 'tool', callId: 'one', name: 'read', content: 'actual observed bytes' }];
  const original = structuredClone(messages), views=[];
  for (const config of [legacy.config, ordered.config]) {
    const planned = await planNativeContext({ ...legacy.snapshot, messages }, config, config.tools, counters, digest, false, true);
    assert.equal(planned.action, 'ready'); validateContextMessages(planned.messages);
    assert.deepEqual(withoutHost(planned.messages), messages); assert.deepEqual(messages, original);
    assert.equal(planned.admission.countedInputTokens, count(planned.messages, config.tools)); views.push(planned.messages);
  }
  assert.equal(views[0][1].kind, 'execution_continuity'); assert.equal(views[1].at(-1).kind, 'execution_continuity');
  assert.equal(views[0][1].content, views[1].at(-1).content);
});
test('actual chat serialization retains a longer unchanged prefix when only current execution state changes', async () => {
  const prefixes=[];
  for (const placement of [undefined, 'after-history/v1']) {
    const {config,snapshot}=setup(placement), messages=[...snapshot.messages, {role:'user',kind:'guidance',content:'Stable source data. '.repeat(1000)}];
    const initial={...snapshot,messages};
    const later={...initial,usage:{...initial.usage,toolCalls:1,modelCalls:1},messages:[...messages,
      {role:'assistant',content:'',toolCalls:[call('read')]},{role:'tool',callId:'read',name:'read',content:'actual result'}]};
    const bodies=[];
    for(const state of [initial,later]){
      const planned=await planNativeContext(state,config,config.tools,counters,digest,false,true);
      assert.equal(planned.action,'ready');
      bodies.push(JSON.stringify({model:'controlled',messages:projectMessagesOpenAI({profile:config.profile,messages:planned.messages})}));
    }
    prefixes.push(common(...bodies));
  }
  assert.ok(prefixes[1]>19000); assert.ok(prefixes[0]<prefixes[1]/2);
});
test('summary adoption retains the counted ordered layout and cannot mutate source transcript or manufacture authority', async () => {
  const {config,snapshot}=setup('after-history/v1');
  const messages=[...snapshot.messages,{role:'assistant',content:'',toolCalls:[call('old')]},
    {role:'tool',callId:'old',name:'read',content:'Old observation. '.repeat(2000)},
    {role:'assistant',content:'',toolCalls:[call('fresh')]},{role:'tool',callId:'fresh',name:'read',content:'Current observed data'}];
  const original=structuredClone(messages);let state={...snapshot,messages,usage:{...snapshot.usage,modelCalls:3,toolCalls:2}};
  let planned=await planNativeContext(state,config,config.tools,counters,digest,true,true), attempts=0;
  while(planned.action==='compact'){
    assert.ok(++attempts<32);state={...state,contextState:planned.state};
    state.contextState.compaction.proposal='Historical observations only; the current task remains incomplete.';
    planned=await planNativeContext(state,config,config.tools,counters,digest,false,true);
  }
  assert.equal(planned.action,'ready');assert.ok(attempts>0);validateContextMessages(planned.messages);
  assert.equal(planned.messages.at(-1).kind,'execution_continuity');
  assert.ok(planned.messages.some(message=>message.kind==='compaction_summary'&&message.content.includes('untrusted')));
  assert.ok(planned.messages.some(message=>message.content==='Current observed data'));assert.deepEqual(messages,original);
});
test('the real Kernel dispatch sees the same ordered view that its counter admitted', async () => {
  const {config,snapshot}=setup('after-history/v1'),store=new MemoryRunStore();let models=0;const counted=[];
  const kernel=new NativeKernel({store,digest,owner:'worker',ports:{
    context:{tokens:{tokenizerId:'layout-counter',tokenizerDigest:'layout/v1',countText:async request=>Math.ceil(request.text.length/4),
      countRequest:async request=>{counted.push(structuredClone(request.messages));return count(request.messages,request.tools);}}},
    model:{generate:async request=>{
      assert.equal(request.messages.at(-1).kind,'execution_continuity');validateContextMessages(request.messages);
      assert.ok(counted.some(messages=>canonical(messages)===canonical(request.messages)));
      return ++models===1?{kind:'tool_calls',text:'',toolCalls:[call('read')],usage:emptyUsage()}
        :{kind:'final_candidate',text:'Actual observation received.',toolCalls:[],usage:emptyUsage()};
    }},tools:{execute:async()=>({status:'ok',content:'Actual observation'})}}});
  kernel.start(snapshot,config);const result=await kernel.runUntilIdle(scope,'run');
  assert.equal(result.phase,'completed');assert.equal(models,2);
  assert.equal(result.messages.some(message=>message.kind==='execution_continuity'),false,'Derived current state is not appended to canonical history');
});
