/** A team template materializes ordinary Agent templates through the existing summon pipeline. */
import { createHash } from 'node:crypto';
import { paginateResources } from './resource-catalog.mjs';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function createTeamTemplateSummon({catalog,summon,teams}) {
  async function definition(ref,options={}) {
    await catalog.ensure?.(ref,'team',options);const item=catalog.isRemote?catalog.get(ref):(catalog.resource?.(ref)||catalog.get(ref));
    if(item.kind!=='team'||!Array.isArray(item.roles)||item.roles.length<2||item.roles.length>9||item.roles[0].name!=='lead')fail('TEAM_TEMPLATE_INVALID','专家团模板角色定义无效');
    return item;
  }
  const roleRef=(item,role,ref)=>({...role.template,catalogId:ref.catalogId});
  return {
    async list(query={}) {return catalog.listResources?catalog.listResources({...query,kind:'team'}):paginateResources((catalog.resources?.()||[]).filter(row=>row.kind==='team'),query,{source:'personal-catalog'});},
    async detail(ref){return definition(ref);},
    async summon(payload) {
      if(!/^[a-zA-Z0-9-]{16,80}$/.test(payload.requestId||''))fail('TEAM_REQUEST_INVALID','召唤请求标识无效');
      const item=await definition(payload.ref,{signal:payload.signal}),bindings=payload.bindings||{};
      const known=(await teams.list()).items.find(row=>row.templateSource?.id===item.id&&row.templateSource.digest===item.digest&&JSON.stringify(row.templateSource.bindings||{})===JSON.stringify(bindings));
      if(known)return {status:'created',team:known,reused:true};
      // Check every role before installing/creating anything. Missing dependencies never become a runnable team.
      for(const role of item.roles) {
        payload.signal?.throwIfAborted();payload.onProgress?.({phase:'checking',label:`正在检查${role.label}的模型与依赖`});
        const plan=await summon.plan({ref:roleRef(item,role,payload.ref),bindings});
        if(plan.missing.length)return {status:'needs-input',role:role.label,plan};
      }
      const selected=[];
      for(let index=0;index<item.roles.length;index++) {
        const role=item.roles[index];payload.signal?.throwIfAborted();
        const result=await summon.summon({ref:roleRef(item,role,payload.ref),bindings,requestId:`${payload.requestId}-role-${index}`,signal:payload.signal,
          onProgress:event=>payload.onProgress?.({...event,label:`${index+1}/${item.roles.length} ${role.label} · ${event.label||event.phase}`})});
        if(result.status!=='created')return {...result,role:role.label};
        selected.push({...role,agentId:result.agent.metadata.id});
      }
      const id=`team-${createHash('sha256').update(payload.requestId).digest('hex').slice(0,24)}`;
      const team=await teams.save({id,name:item.name,description:item.description,instructions:item.instructions,leadAgentId:selected[0].agentId,
        members:selected.slice(1).map(({template,...role})=>role),templateSource:{id:item.id,digest:item.digest,version:item.version,artwork:item.artwork?{...item.artwork,available:true}:undefined,bindings}});
      return {status:'created',team,reused:false};
    },
  };
}
