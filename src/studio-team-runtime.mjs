/** Opt in without duplicating a user's already enabled official Teams bundle. */
export function ensureStudioTeamRuntime(ctx, { load = () => import('@deepseek-ai/dsh-experimental-agent-team') } = {}) {
  let stopped=false;
  ctx.effect(()=>()=>{stopped=true;},'agentkit-studio: team runtime ownership');
  const ready=(async()=>{
    // Loader composition may contain the optional official profile after Studio.
    // Wait outside plugin apply before deciding whether a service is missing.
    await ctx.root.loader.await();
    if(stopped||ctx.get('agentTeams'))return;
    const module=await load();
    if(stopped||ctx.get('agentTeams'))return;
    await ctx.plugin(module.default,{maxMembers:8,maxTasks:256,maxMessageBytes:65536,disposalTimeoutMs:5000});
    if(!ctx.get('agentTeams'))throw Object.assign(new Error('官方 agent-teams 服务未启动'),{code:'TEAM_RUNTIME_UNAVAILABLE'});
  })();
  void ready.catch(error=>console.warn('[agentkit-studio] team runtime unavailable:',error.code||'TEAM_RUNTIME_UNAVAILABLE'));
  return ready;
}
export async function usesOfficialTeamTools(ctx) {
  const manager=ctx.get('pluginManager');
  if(!manager?.listPlugins)return false;
  return (await manager.listPlugins()).some(row=>row.moduleName==='@deepseek-ai/dsh-experimental-tool-agent-team'&&row.fiberPhase==='active');
}
