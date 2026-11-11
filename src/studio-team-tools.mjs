/** Studio selection constraints around the official agent-teams authority. */
const roleError = (message) => Object.assign(new Error(message), { code: 'TEAM_ROLE_UNAVAILABLE' });

/**
 * Resolve a role only for Studio-owned spawn/configuration operations.
 *
 * The DSH Team service and its official tools intentionally remain free to
 * create additional teammates. This helper is used only by Studio's optional
 * adapter, so an unknown name is rejected before it reaches DSH.
 */
export function studioConfiguredRole(run, name) {
  const candidate = String(name || '').trim();
  const role = run?.roles?.find(item => item?.name === candidate && item.name !== 'lead');
  if (!role) throw roleError('成员未在团队配置中，请返回团队编辑器添加');
  return role;
}

export function teamMemberAllowlist(run) {
  return [...new Set((run?.roles || []).filter(item => item?.name && item.name !== 'lead').map(item => String(item.name)))];
}

/**
 * Build the native DSH request for one Studio-configured teammate.
 *
 * DSH 0.2.2-RC1 currently ignores the optional `agentPreset` and
 * `allowedMemberNames` fields because TeamService does not expose them yet.
 * Passing both fields here is deliberately forward-compatible with a native
 * TeamService extension: Studio enforces the allowlist before this call, and
 * the current `agent/created` recompose hook remains the preset fallback,
 * while a patched DSH service can apply the preset before the child prompt.
 */
export function studioTeammateRequest({ role, run, prompt, signal, context = 'fresh', provider = 'spawn', agentPreset } = {}) {
  if (!role || typeof role !== 'object') throw roleError('团队角色来源无效');
  const request = {
    name: String(role.name || '').trim(),
    description: String(role.label || role.name || '').trim(),
    prompt: [{ type: 'text', text: String(prompt || '') }],
    context,
    provider,
    signal,
    allowedMemberNames: teamMemberAllowlist(run),
  };
  const selectedPreset = String(agentPreset || role.agentPreset || role.agentPresetId || '').trim();
  if (selectedPreset) request.agentPreset = selectedPreset;
  return request;
}

function studioPolicy(useOfficialTools) {
  if (useOfficialTools) {
    return '本会话使用官方 Agent Teams。Studio 负责已配置角色的 preset 映射；官方 Agent Teams 工具保持 DSH 原生能力，Lead 可按任务需要创建额外成员。所有任务、消息和状态均由 agent-teams 持久保存。成员必须通过 send_message 向 lead 汇报结果，必要时读取和认领共享任务。inactive 仅表示没有回合执行，不表示任务已完成。所有成员共享当前工作目录，文件写入先分配互不重叠的范围。';
  }
  return '本会话使用 Studio 的 Agent Teams 适配。Studio 自有 spawn_teammate 仅允许团队配置中的成员，并通过 DSH 原生 Agent Teams 持久化任务、消息和状态。成员必须通过 send_message 向 lead 汇报结果，必要时读取和认领共享任务。inactive 仅表示没有回合执行，不表示任务已完成。所有成员共享当前工作目录，文件写入先分配互不重叠的范围。仅使用已授权资源。';
}

export function installStudioTeamTools(agent,{teams,run,useOfficialTools=false}) {
  const ctx=agent.ctx;
  const string={type:'string'},required={type:'string',required:true};
  const output={schema:{type:'object',properties:{result:{type:'string'}},required:['result']},render:(_args,value)=>[{type:'text',text:value.result}]};
  const disposers=[];
  function tool(name,description,parameters,execute){disposers.push(ctx.tools.register({name,description,parameters:{type:'object',properties:Object.fromEntries(Object.entries(parameters).map(([key,{required,...schema}])=>[key,schema])),required:Object.entries(parameters).filter(([,schema])=>schema.required).map(([key])=>key)},output,execute:async(args,exec)=>({result:JSON.stringify(await execute(args,exec))})}));}
  disposers.push(ctx.systemPrompt.section({name:'studio:team-policy',order:105,text:studioPolicy(useOfficialTools)}));
  if(useOfficialTools)return;
  tool('spawn_teammate','启动用户已选择的专家成员。仅主理人可调用，名称必须与团队配置一致。',{name:required,prompt:required},async(args,exec)=>{const role=studioConfiguredRole(run,args.name);const existing=teams.listMembers(exec.agent).find(x=>x.name===role.name);if(existing){if(existing.status==='failed')throw new Error('该成员本次启动失败，请停止并新建运行；本次运行不能复用失败成员名');return {member:existing,reused:true,next:'使用 send_message 向此成员继续分配任务'};}return teams.spawnTeammate(exec.agent,studioTeammateRequest({role,run,prompt:`你是 ${role.label}，团队标识 ${role.name}。职责：${role.instructions}\n当前任务：${args.prompt}\n完成后必须用 send_message({target:"lead",message:"你的完整报告"}) 汇报。`,signal:exec.signal}));});
  tool('list_agents','读取官方团队成员及运行状态。',{},(_args,exec)=>teams.listMembers(exec.agent));
  tool('send_message','向团队成员发送持久消息，inactive 成员会开始或继续执行。',{target:required,message:required},(args,exec)=>teams.sendMessage(exec.agent,{target:args.target,content:[{type:'text',text:args.message}],signal:exec.signal}));
  tool('wait_agent','等待其他正在运行的成员产生变化。不会唤醒 inactive 成员；先发送消息再等待。',{timeout_ms:{type:'integer'}},(args,exec)=>{if(!teams.listMembers(exec.agent).some(x=>x.id!==exec.agent.id&&['running','provisioning'].includes(x.status)))return {noProgress:true,message:'没有活跃成员，请检查报告或发送消息唤醒成员'};return teams.waitForChange(exec.agent,Math.min(60000,Math.max(10000,args.timeout_ms||30000)),exec.signal);});
  tool('interrupt_agent','停止指定成员当前回合，保留成员和历史。',{target:required},(args,exec)=>teams.interrupt(exec.agent,args.target));
  tool('team_task_create','创建共享任务。',{subject:required,description:required,blocked_by:{type:'array',items:string},write_scopes:{type:'array',items:string}},(args,exec)=>teams.createTask(exec.agent,{subject:args.subject,description:args.description,blockedBy:args.blocked_by,writeScopes:args.write_scopes}));
  tool('team_task_list','读取共享任务及版本、负责人、依赖与状态。',{},(_args,exec)=>teams.listTasks(exec.agent));
  tool('team_task_get','更新前读取共享任务的最新版本。',{task_id:required},(args,exec)=>teams.getTask(exec.agent,args.task_id));
  tool('team_task_update','使用最新 revision 修改任务。主理人可用 reassign 分配 owner。',{task_id:required,expected_revision:{type:'integer',required:true},action:{type:'string',required:true,enum:['claim','release','edit','set_dependencies','complete','reopen','reassign','delete']},subject:string,description:string,owner:string,blocked_by:{type:'array',items:string},write_scopes:{type:'array',items:string}},(args,exec)=>teams.updateTask(exec.agent,{taskId:args.task_id,expectedRevision:args.expected_revision,action:args.action,subject:args.subject,description:args.description,owner:args.owner,blockedBy:args.blocked_by,writeScopes:args.write_scopes}));
  return () => {
    for (const dispose of disposers.splice(0).reverse()) if (typeof dispose === 'function') dispose();
  };
}
