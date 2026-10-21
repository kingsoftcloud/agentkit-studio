const OFFICIAL_TEAM_MODULE='@deepseek-ai/dsh-experimental-agent-team';
/** Grace period the declared official entry gets before Studio mounts a fallback. */
const OFFICIAL_TEAMS_WAIT_MS=20000;

/** Whether the composed Loader tree already carries the official Agent Teams entry.
 * A declared entry owns the `agentTeams` service even while it is still activating,
 * so Studio must not register a second copy next to it.
 */
function officialTeamsDeclared(ctx){
  try{
    const loader=ctx.root?.loader;
    if(typeof loader?.entries!=='function')return false;
    for(const entry of loader.entries())if(entry?.options?.name===OFFICIAL_TEAM_MODULE)return true;
  }catch{/* an unreadable tree cannot declare anything */ }
  return false;
}

/** Opt in without duplicating a user's already enabled official Teams bundle. */
export function ensureStudioTeamRuntime(ctx, { load = () => import('@deepseek-ai/dsh-experimental-agent-team'), waitMs = OFFICIAL_TEAMS_WAIT_MS } = {}) {
  let stopped=false;
  const timers=new Set();
  ctx.effect(()=>()=>{stopped=true;for(const timer of timers)clearTimeout(timer);timers.clear();},'agentkit-studio: team runtime ownership');
  const sleep=ms=>new Promise(resolve=>{const timer=setTimeout(()=>{timers.delete(timer);resolve();},ms);timers.add(timer);});
  const waitForDeclared=async()=>{
    const deadline=Date.now()+waitMs;
    while(!stopped&&!ctx.get('agentTeams')&&Date.now()<deadline)await sleep(Math.min(100,Math.max(1,deadline-Date.now())));
    return ctx.get('agentTeams');
  };
  const ready=(async()=>{
    // Loader composition may contain the optional official profile after Studio.
    // Wait outside plugin apply before deciding whether a service is missing.
    await ctx.root.loader.await();
    if(stopped||ctx.get('agentTeams'))return;
    // Enabling the official plugin from the market composes an `agent-team` entry.
    // Mounting Studio's own copy first registers `agentTeams` twice, and the
    // entry then fails with "service has been registered", which surfaces as a
    // failed enable. Let the declared entry activate; mount only if it never does.
    if(officialTeamsDeclared(ctx)&&await waitForDeclared())return;
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
