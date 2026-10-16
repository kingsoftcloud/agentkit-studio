import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentStore} from '../src/agent-store.mjs';
import {createStudioTeams,validateTeam} from '../src/studio-teams.mjs';
const definition=id=>({name:'研究团队',leadAgentId:id,instructions:'协作验证',members:[{name:'reviewer',label:'审查',agentId:id,instructions:'独立审查并汇报'}]});
test('team composition rejects ambiguous names and unsupported member counts',()=>{
 assert.throws(()=>validateTeam({...definition('a'),members:[]}),{code:'TEAM_INVALID'});
 assert.throws(()=>validateTeam({...definition('a'),members:[{name:'lead',agentId:'a',instructions:'x'}]}),{code:'TEAM_INVALID'});
 assert.throws(()=>validateTeam({...definition('a'),members:[...definition('a').members,...definition('a').members]}),{code:'TEAM_INVALID'});
});
test('team editing uses optimistic revision and existing runtime Agents; snapshots stay outside ordinary list',async()=>{
 const root=await mkdtemp(join(tmpdir(),'studio-team-'));
 try{
  const agents=createAgentStore({storeDir:join(root,'agents')});const local=await agents.create({name:'专家',spec:{instructions:{system:'原始指令'},bindings:{knowledgeBases:['kb'],memoryInstances:['memory']}}});
  const codex=await agents.create({name:'Codex',runtimeType:'codex'});
  const ctx={get:()=>undefined,on:()=>{},effect:()=>{}};const api=createStudioTeams({ctx,directory:join(root,'teams'),agents,getAdmission:()=>({})});
  await assert.rejects(api.save(definition(codex.metadata.id)),{code:'TEAM_AGENT_UNSUPPORTED'});
  const team=await api.save(definition(local.metadata.id));assert.equal(team.revision,1);
  const updates=await Promise.allSettled([api.save({...team,name:'更新一'}),api.save({...team,name:'更新二'})]);assert.equal(updates.filter(x=>x.status==='fulfilled').length,1);assert.equal(updates.find(x=>x.status==='rejected').reason.code,'TEAM_REVISION_CONFLICT');
  const snapshot=await agents.create({name:'运行快照',spec:local.spec,teamRole:{runId:'test',sourceAgentId:local.metadata.id}});
  await agents.update(local.metadata.id,{spec:{instructions:{system:'新指令'}}});assert.equal((await agents.get(snapshot.metadata.id)).spec.instructions.system,'原始指令');assert.deepEqual((await agents.get(snapshot.metadata.id)).spec.bindings,local.spec.bindings);
  assert.equal((await agents.list()).length,2);assert.equal((await agents.list({includeTeamRoles:true})).length,3);
  const catalog=await api.list();assert.equal(catalog.agents.find(x=>x.metadata.id===codex.metadata.id).selectable,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('team-only composition removes nested ordinary delegation without mutating the source',async()=>{
 const {teamBasePlugins}=await import('../src/studio-team-composition.mjs');
 const source=[{name:'group',group:true,config:[{name:'@deepseek-ai/dsh-tool-subagent'},{id:'tool-subagent-fork',name:'fork'},{name:'@deepseek-ai/dsh-tool-subagent-control/list-agents'},{name:'@deepseek-ai/dsh-persona'}]},{name:'@deepseek-ai/dsh-tool-bash'}];
 assert.deepEqual(teamBasePlugins(source)[0].config,[{name:'@deepseek-ai/dsh-persona'}]);assert.equal(source[0].config.length,4);
});

test('team tool adapters constrain member selection and reuse an existing official roster member',async()=>{
 const {installStudioTeamTools}=await import('../src/studio-team-tools.mjs');const definitions=new Map();let spawned=0;
 const agent={ctx:{tools:{register:tool=>definitions.set(tool.name,tool)},systemPrompt:{section:()=>{}}}};
 const teams={listMembers:()=>[{name:'reviewer',status:'inactive'}],spawnTeammate:()=>{spawned++;}};
 installStudioTeamTools(agent,{teams,run:{roles:[{name:'reviewer',label:'审查',instructions:'审查'}]}});
 const spawn=definitions.get('spawn_teammate');
 await assert.rejects(spawn.execute({name:'unknown',prompt:'x'},{agent,signal:new AbortController().signal}),/成员未在团队配置/);
 assert.equal(JSON.parse((await spawn.execute({name:'reviewer',prompt:'x'},{agent})).result).reused,true);assert.equal(spawned,0);
 assert.deepEqual(spawn.parameters.required,['name','prompt']);
});

test('team runtime waits for Loader and reuses an official profile service',async()=>{
 const {ensureStudioTeamRuntime}=await import('../src/studio-team-runtime.mjs');let loaded=0,plugins=0;const services=new Map();let settle;const loader=new Promise(resolve=>{settle=resolve;});
 const ctx={root:{loader:{await:()=>loader}},effect:()=>{},get:name=>services.get(name),plugin:()=>{plugins++;}};
 const ready=ensureStudioTeamRuntime(ctx,{load:async()=>{loaded++;return {default:{}};}});services.set('agentTeams',{});settle();await ready;
 assert.equal(loaded,0);assert.equal(plugins,0);
});
test('fresh profiles mount one official service and official tools are not registered twice',async()=>{
 const {ensureStudioTeamRuntime}=await import('../src/studio-team-runtime.mjs');const {installStudioTeamTools}=await import('../src/studio-team-tools.mjs');let service,plugins=0,tools=0;
 const ctx={root:{loader:{await:async()=>{}}},effect:()=>{},get:()=>service,plugin:async()=>{plugins++;service={};}};
 await ensureStudioTeamRuntime(ctx,{load:async()=>({default:{}})});assert.equal(plugins,1);
 installStudioTeamTools({ctx:{tools:{register:()=>tools++},systemPrompt:{section:()=>{}}}},{teams:{},run:{},useOfficialTools:true});assert.equal(tools,0);
});
