/** Local compositions reference ordinary Studio Agents. DSH owns all execution. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { usesOfficialTeamTools } from './studio-team-runtime.mjs';
import { installStudioTeamTools } from './studio-team-tools.mjs';
const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => structuredClone(value);
export function validateTeam(input) {
  const text = (value, label, max) => { const result=String(value||'').trim(); if(!result || result.length>max) throw fail('TEAM_INVALID',`${label}不能为空且不能超过 ${max} 字`); return result; };
  const members = Array.isArray(input.members) ? input.members : [];
  if(members.length<1 || members.length>8) throw fail('TEAM_INVALID','请选择 1 至 8 位团队成员');
  const names = new Set();
  const normalized=members.map(member=>{ const name=String(member.name||'').trim(); if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)||name.length>64||name==='lead'||names.has(name)) throw fail('TEAM_INVALID','成员标识须为唯一的小写英文或连字符，不能使用 lead'); names.add(name); return {name, label:text(member.label||name,'成员名称',80),agentId:text(member.agentId,'专家',100), instructions:text(member.instructions,'成员职责',8000)}; });
  return { name:text(input.name,'团队名称',80), description:String(input.description||'').trim().slice(0,1000), instructions:text(input.instructions||'分解任务，让每位成员独立完成职责，汇总并审查结果。','协作指令',16000), leadAgentId:text(input.leadAgentId,'主理专家',100), members:normalized };
}
export function createStudioTeams({ctx, directory, agents, getAdmission, runtimeReady=Promise.resolve()}) {
  const runs=new Map(), locks=new Map();
  const path=(kind,id)=>{if(!/^(team|teamrun)-[a-f0-9]{24}$/.test(id))throw fail('TEAM_ID_INVALID','团队或运行 ID 无效');return join(directory,kind,`${id}.json`);};
  async function read(kind,id){try{return JSON.parse(await readFile(path(kind,id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async function write(kind,item){const target=path(kind,item.id);await mkdir(join(directory,kind),{recursive:true,mode:0o700});const temp=`${target}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(item,null,2),{mode:0o600});await rename(temp,target);return copy(item);}
  async function all(kind){const files=await readdir(join(directory,kind)).catch(e=>{if(e.code==='ENOENT')return [];throw e;});return Promise.all(files.filter(x=>/^(team|teamrun)-[a-f0-9]{24}\.json$/.test(x)).map(x=>read(kind,x.slice(0,-5))));}
  async function serial(key,fn){const previous=locks.get(key)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}}
  async function expert(id){const agent=await agents.get(id);if(!agent||agent.metadata?.local!==true||!['dsh-native','harness'].includes(agent.spec?.runtime?.type))throw fail('TEAM_AGENT_UNSUPPORTED','请选用本机 DSH Native 或 Harness 专家；云端与 Codex 成员尚未接入');return agent;}
  const services=()=>{const teams=ctx.get('agentTeams'),controller=ctx.get('sessionController');if(!teams||!controller||!ctx.get('agentPresets'))throw fail('TEAM_RUNTIME_UNAVAILABLE','官方 agent-teams 或会话服务尚未就绪，请重试');return {teams,controller};};
  async function admitRoles(run, admission=getAdmission(), recovery=false){for(const role of run.roles){const agent=await agents.get(role.agentId);if(!agent)throw fail('TEAM_SNAPSHOT_MISSING','团队运行的专家快照缺失');await admission.ensure(role.agentId,{agent,allowUnavailableResources:recovery});}}
  async function mount(agent){
    const parent=agent.session.header.parentSession;const run=runs.get(parent||agent.id);if(!run)return;
    if(!ctx.get('agentTeams'))await runtimeReady;
    const {teams}=services();const root=parent?ctx.get('agents').get(parent):agent;
    const name=parent?teams.listMembers(root).find(x=>x.id===agent.id)?.name:'lead';
    const role=run.roles.find(x=>x.name===name);if(!role)throw fail('TEAM_ROLE_UNAVAILABLE','无法恢复团队成员身份');
    const snapshot=await agents.get(role.agentId);const admission=await getAdmission().ensure(role.agentId,{agent:snapshot,allowUnavailableResources:true});
    const registry=ctx.get('agentPresets');if(registry.composedPreset(agent.ctx)!==admission.presetId)await registry.recompose(agent.ctx,admission.presetId);
    // Child factory first inherits its parent's composition; rebind before its
    // publication promise resolves and before the first inbox prompt executes.
    if(admission.modelSelection){agent.ctx.on('agent/request',async(_payload,next)=>({...await next(),...admission.modelSelection}),{prepend:true});agent.ctx.on('system-prompt/assemble',async(_payload,_context,next)=>{const value=await next();return {...value,variables:{...value.variables,...admission.modelSelection}};});}
    installStudioTeamTools(agent, {teams,run,useOfficialTools:await usesOfficialTeamTools(ctx)});
  }
  ctx.on('agent/created',({agent})=>mount(agent),{prepend:true});
  const api={
    async restore(admission){for(const run of await all('runs')){runs.set(run.id,run);try{await admitRoles(run,admission,true);}catch(error){console.warn('[agentkit-studio] team snapshot recovery unavailable:',run.id,error.code||'TEAM_RECOVERY_FAILED');}}},
    async list(){const items=(await all('definitions')).filter(Boolean).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));const choices=(await agents.list()).filter(x=>!x.metadata?.teamRole).map(x=>({...x,selectable:x.metadata?.local===true&&['dsh-native','harness'].includes(x.spec?.runtime?.type)}));return {items,presets:[],agents:choices};},
    async save(payload){const id=payload.id||`team-${randomUUID().replaceAll('-','').slice(0,24)}`;return serial(id,async()=>{const previous=await read('definitions',id);if(previous&&payload.revision!==previous.revision)throw fail('TEAM_REVISION_CONFLICT','团队已被修改，请重新打开编辑');const value=validateTeam(payload);await Promise.all([value.leadAgentId,...value.members.map(x=>x.agentId)].map(expert));const templateSource=previous?.templateSource||payload.templateSource;return write('definitions',{...value,...(templateSource?{templateSource}:{}),id,revision:(previous?.revision||0)+1,createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()});});},
    async remove({id,revision}){return serial(id,async()=>{const item=await read('definitions',id);if(!item||item.revision!==revision)throw fail('TEAM_REVISION_CONFLICT','团队版本已变化');await unlink(path('definitions',id));return {removed:true};});},
    async start({id,revision,task,requestId}){const taskText=String(task||'').trim();if(!taskText||taskText.length>32000)throw fail('TEAM_TASK_INVALID','请输入不超过 32000 字的团队任务');if(!/^[a-f0-9-]{36}$/.test(requestId||''))throw fail('TEAM_REQUEST_INVALID','运行请求标识无效');return serial(requestId,async()=>{
      await runtimeReady;services();const known=[...runs.values()].find(x=>x.requestId===requestId);if(known)return api.status({runId:known.id});
      const team=await read('definitions',id);if(!team||revision!==team.revision)throw fail('TEAM_REVISION_CONFLICT','团队已变化，请刷新后运行');
      const run={id:`teamrun-${randomUUID().replaceAll('-','').slice(0,24)}`,teamId:id,teamRevision:revision,name:team.name,requestId,task:taskText,createdAt:new Date().toISOString(),roles:[]};
      const definitions=[{name:'lead',label:'团队主理人',agentId:team.leadAgentId,instructions:`你是「${team.name}」的主理人。用户已明确要求使用 Agent Teams。${team.instructions}\n必须通过 spawn_teammate 按以下标识启动全部已选成员：${team.members.map(x=>`${x.name}（${x.label}）：${x.instructions}`).join('；')}。不要用普通 subagent 替代。以本次用户任务为准，不自行扩充任务范围。为各成员分别创建可独立认领的共享任务，分配职责，使用 list_agents、send_message、team_task_list 和 wait_agent 等待全部成员的报告后再汇总。不要把成员的 inactive 状态当作任务成功。`},...team.members];
      for(const definition of definitions){const source=await expert(definition.agentId);const spec=copy(source.spec);spec.instructions={...spec.instructions,system:`${spec.instructions?.system||source.metadata.description||''}\n\n团队职责：${definition.instructions}`};const snapshot=await agents.create({name:`${team.name} · ${definition.label}`,runtimeType:spec.runtime.type,spec,teamRole:{teamId:id,runId:run.id,name:definition.name,sourceAgentId:source.metadata.id,sourceRevision:source.metadata.revision}});run.roles.push({...definition,agentId:snapshot.metadata.id,sourceAgentId:source.metadata.id,sourceRevision:source.metadata.revision});}
      await admitRoles(run);await write('runs',run);runs.set(run.id,run);
      const {controller}=services();const lead=await agents.get(run.roles[0].agentId);const admission=await getAdmission().ensure(lead.metadata.id,{agent:lead});
      try{await controller.create({sessionId:run.id,agentPreset:admission.presetId});if(admission.modelSelection)await controller.selectModel({sessionId:run.id,...admission.modelSelection,saveDefault:false});const resolved=await controller.resolveAgent(run.id);if(resolved.error)throw resolved.error;await ctx.get('commands').execute(resolved.agent,'/permission read-only',[],new AbortController().signal);await controller.prompt({sessionId:run.id,requestId,mode:'queue',content:[{type:'text',text:taskText}],clientTimeZone:'Asia/Shanghai'},AbortSignal.timeout(60000));}
      catch(error){run.error={code:error.code||'TEAM_START_FAILED',message:'团队启动未完成，请检查模型与资源后新建运行。'};await write('runs',run);throw error;}
      return api.status({runId:run.id});
    });},
    async status({runId}){await runtimeReady;const run=runs.get(runId)||await read('runs',runId);if(!run)throw fail('TEAM_RUN_NOT_FOUND','团队运行不存在');const {teams,controller}=services();const agent=ctx.get('agents').get(runId);const projection=await controller.projections({sessionId:runId},AbortSignal.timeout(10000)).catch(()=>null);let output='',outcome; if(projection){const page=await controller.page({address:{kind:'session',sessionId:runId},throughSeq:projection.asOfSeq,maxMessages:150},AbortSignal.timeout(10000));const end=(page.records||[]).filter(x=>x.type==='event'&&x.event.type==='turn/end').at(-1)?.event.data?.reason?.kind;outcome=end&&end!=='completed'?(['user','aborted'].includes(end)?'stopped':'failed'):undefined;output=(page.records||[]).filter(x=>x.type==='event'&&x.event.type==='assistant/message').at(-1)?.event.data?.message?.content?.filter(x=>x.type==='text').map(x=>x.text).join('')||'';}
      const members=agent?teams.listMembers(agent).map(copy):[];await Promise.all(members.filter(member=>member.status==='inactive').map(async member=>{try{const projected=await controller.projections({sessionId:member.id},AbortSignal.timeout(5000));const page=await controller.page({address:{kind:'session',sessionId:member.id},throughSeq:projected.asOfSeq,maxMessages:20},AbortSignal.timeout(5000));const end=(page.records||[]).filter(x=>x.type==='event'&&x.event.type==='turn/end').at(-1)?.event.data?.reason;if(end?.kind==='error'){member.lastError={code:String(end.error?.code||'TEAM_MEMBER_FAILED'),message:'最近一次执行失败，请打开成员会话查看详情'};}}catch{}}));
      return {...copy(run),sessionId:runId,status:run.error?'failed':agent?.status==='running'?'running':outcome||agent?.status||'inactive',members,tasks:agent?teams.listTasks(agent):[],output};},
    async history({id}){return {items:(await all('runs')).filter(x=>x.teamId===id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(x=>({id:x.id,name:x.name,createdAt:x.createdAt,teamRevision:x.teamRevision,task:x.task,error:x.error}))};},
    async resume({runId}){await runtimeReady;const run=runs.get(runId)||await read('runs',runId);if(!run)throw fail('TEAM_RUN_NOT_FOUND','运行不存在');runs.set(runId,run);await admitRoles(run,getAdmission(),true);const result=await services().controller.resolveAgent(runId);if(result.error)throw result.error;return api.status({runId});},
    async stop({runId}){const root=ctx.get('agents').get(runId);if(root){const {teams}=services();for(const member of teams.listMembers(root).filter(x=>x.role==='teammate'&&x.status==='running'))teams.interrupt(root,member.name);root.cancel({kind:'user'});}return api.status({runId});},
  };
  return api;
}
