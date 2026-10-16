import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentStore} from '../src/agent-store.mjs';
import {createStudioTeams} from '../src/studio-teams.mjs';
import {createTeamTemplateSummon} from '../src/team-template-summon.mjs';
import {createTemplateSummon} from '../src/template-summon.mjs';
import {createTemplateAuthoring} from '../src/template-authoring.mjs';
const fixture=async()=>{
 const root=await mkdtemp(join(tmpdir(),'team-template-'));
 const store=createAgentStore({storeDir:join(root,'agents')});
 const agent=(id,prompt)=>({id,name:id,version:'1.0.0',digest:'sha256:'+id,runtimes:['dsh-native'],requirements:[],spec:{runtime:{type:'dsh-native'},instructions:{system:prompt},bindings:{}},dependencies:{skills:[],mcp:[]}});
 const lead=agent('lead-template','完整主理指令 Ω'),member=agent('member-template','完整成员指令 中文');
 const team={id:'team-template-review',digest:'sha256:team',kind:'team',name:'预配审查团',version:'1.0.0',instructions:'分工与汇总',roles:[{name:'lead',label:'主理专家',template:{id:lead.id,digest:lead.digest}},{name:'reviewer',label:'审查专家',instructions:'审查后回报',template:{id:member.id,digest:member.digest}}]};
 const catalog={ensure:async()=>{},get:ref=>structuredClone([lead,member,team].find(x=>x.id===ref.id)),prepare:ref=>{const x=catalog.get(ref);return {name:x.name,spec:x.spec,templateSource:{catalog:'studio-builtin',id:x.id,version:x.version,digest:x.digest}};}};
 const resources=async kind=>({items:kind==='model'?[{id:'default'}]:[]});
 const dependencies={materialize:async()=>[],resolveMcp:async()=>({ids:[],missing:[]}),validate:async()=>{}};
 const authoring=createTemplateAuthoring({catalog,store,resources,dependencies,platformResources:async()=>({items:[]})});
 const summon=createTemplateSummon({catalog,authoring,store,dependencies,resources,models:{profile:async()=>({id:'default'})},operationDir:join(root,'summons')});
 const teams=createStudioTeams({ctx:{get:()=>null,on:()=>{}},agents:store,directory:join(root,'teams'),getAdmission:()=>null});
 return {root,store,teams,summon,catalog,api:createTeamTemplateSummon({catalog,summon,teams}),team};
};
test('team template creates all ordinary Agents without any pre-existing experts, retains prompts and source when edited',async()=>{
 const x=await fixture();try {
  assert.equal((await x.store.list()).length,0);
  const payload={ref:{id:x.team.id,digest:x.team.digest,catalogId:'private'},requestId:'11111111-2222-3333-4444-555555555555'};
  const value=await x.api.summon(payload);assert.equal(value.status,'created');assert.equal(value.team.members.length,1);
  assert.equal((await x.store.get(value.team.leadAgentId)).spec.instructions.system,'完整主理指令 Ω');
  assert.equal((await x.store.get(value.team.members[0].agentId)).spec.instructions.system,'完整成员指令 中文');
  const edited=await x.teams.save({...value.team,name:'我的定制团队'});assert.equal(edited.templateSource.id,x.team.id);
  const again=await x.api.summon({...payload,requestId:'11111111-2222-3333-4444-666666666666'});
  assert.equal(again.team.id,value.team.id);assert.equal(again.team.name,'我的定制团队');assert.equal((await x.store.list()).length,2);
 }finally{await rm(x.root,{recursive:true,force:true});}
});
test('checks every role and returns missing dependencies before creating a partial team',async()=>{
 const x=await fixture();try{
  let created=0;x.summon.plan=async({ref})=>({missing:ref.id==='member-template'?[{kind:'mcp',key:'private'}]:[]});x.summon.summon=async()=>{created++;};
  const value=await x.api.summon({ref:{id:x.team.id},requestId:'11111111-2222-3333-4444-555555555555'});
  assert.equal(value.status,'needs-input');assert.equal(value.role,'审查专家');assert.equal(created,0);assert.equal((await x.teams.list()).items.length,0);
 }finally{await rm(x.root,{recursive:true,force:true});}
});
