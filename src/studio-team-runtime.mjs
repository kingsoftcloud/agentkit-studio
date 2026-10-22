const OFFICIAL_TEAM_MODULE='@deepseek-ai/dsh-experimental-agent-team';
/** Grace period the declared official entry gets before Studio mounts a fallback. */
const OFFICIAL_TEAMS_WAIT_MS=20000;

/** Official Agent Teams entries already composed into the Loader tree. */
function officialTeamEntries(ctx){
  const found=[];
  try{
    const loader=ctx.root?.loader;
    if(typeof loader?.entries!=='function')return found;
    for(const entry of loader.entries())if(entry?.options?.name===OFFICIAL_TEAM_MODULE)found.push(entry);
  }catch{/* an unreadable tree carries no entries */ }
  return found;
}

/** Stable identity for entries that may be rebuilt between tree reads. */
function entryKey(entry){
  return entry?.options?.id ?? entry;
}

/** Whether the tree can activate its own copy of the `agentTeams` service. */
function entryDisabled(entry){
  try{ return Boolean(entry?.disabled); }catch{ return false; }
}

/**
 * Opt in without duplicating an official Teams entry that is, or is about to
 * become, the owner of the `agentTeams` service.
 *
 * The service name is process-wide, so only one plugin may register it:
 * - An enabled official entry declared at boot owns the name; wait for it and
 *   mount Studio's copy only if it never activates.
 * - An installed but switched-off entry also owns the name on its next enable.
 *   Mounting a fallback here is what turns a later market enable into
 *   `service "agentTeams" has been registered at <TeamService>`.
 * - An entry that appears after Studio started (market install) takes the
 *   service over from a mounted fallback before it applies.
 */
export function ensureStudioTeamRuntime(ctx, { load = () => import('@deepseek-ai/dsh-experimental-agent-team'), waitMs = OFFICIAL_TEAMS_WAIT_MS } = {}) {
  let stopped=false;
  let fallback;
  const timers=new Set();
  ctx.effect(()=>()=>{stopped=true;for(const timer of timers)clearTimeout(timer);timers.clear();},'agentkit-studio: team runtime ownership');
  const sleep=ms=>new Promise(resolve=>{const timer=setTimeout(()=>{timers.delete(timer);resolve();},ms);timers.add(timer);});
  const hasService=()=>Boolean(ctx.get('agentTeams'));
  const releaseFallback=()=>{
    if(stopped||!fallback)return;
    const mounted=fallback;
    fallback=undefined;
    if(typeof mounted?.dispose!=='function')return;
    // Cordis unloads in a microtask. The official entry imports its module
    // before applying, so the service is unregistered before it registers.
    void Promise.resolve(mounted.dispose()).catch(error=>console.warn('[agentkit-studio] team runtime fallback dispose failed:',error?.message||error));
  };
  // The market installs its bundle after Studio mounted a fallback. Hand the
  // process-wide service name over as soon as the official entry is created:
  // `loader/entry-init` fires before the entry imports and applies its module.
  if(typeof ctx.on==='function')ctx.on('loader/entry-init',()=>{
    if(stopped||!fallback)return;
    queueMicrotask(()=>{
      if(stopped||!fallback)return;
      if(officialTeamEntries(ctx).length)releaseFallback();
    });
  },{global:true});
  const waitForDeclared=async()=>{
    const deadline=Date.now()+waitMs;
    while(!stopped&&!hasService()&&Date.now()<deadline)await sleep(Math.min(100,Math.max(1,deadline-Date.now())));
    return hasService();
  };
  const ready=(async()=>{
    // Loader composition may contain the optional official profile after Studio.
    // Wait outside plugin apply before deciding whether a service is missing.
    await ctx.root.loader.await();
    if(stopped||hasService())return;
    const declared=officialTeamEntries(ctx);
    if(declared.length){
      // Enabling the official plugin from the market composes an `agent-team`
      // entry. Mounting Studio's own copy first registers `agentTeams` twice,
      // and the entry then fails with "service has been registered", which
      // surfaces as a failed enable. Let the declared entry activate; mount
      // only if it never does.
      if(declared.some(entry=>!entryDisabled(entry))){ if(await waitForDeclared())return; }
      else{
        // Installed but switched off: its entry owns the name on enable, so a
        // fallback mounted now would break that enable. Leave it to the user.
        console.info('[agentkit-studio] official agent-teams bundle is installed but disabled; Studio fallback stays unmounted');
        return;
      }
    }
    if(stopped||hasService())return;
    const beforeMount=new Set(officialTeamEntries(ctx).map(entryKey));
    const module=await load();
    if(stopped||hasService())return;
    const mounted=ctx.plugin(module.default,{maxMembers:8,maxTasks:256,maxMessageBytes:65536,disposalTimeoutMs:5000});
    fallback=mounted;
    await mounted;
    // A market entry created while the fallback was loading must own the
    // process-wide service name; yield it now instead of failing its enable.
    if(officialTeamEntries(ctx).some(entry=>!beforeMount.has(entryKey(entry)))){
      releaseFallback();
      return;
    }
    if(!hasService())throw Object.assign(new Error('官方 agent-teams 服务未启动'),{code:'TEAM_RUNTIME_UNAVAILABLE'});
  })();
  void ready.catch(error=>console.warn('[agentkit-studio] team runtime unavailable:',error.code||'TEAM_RUNTIME_UNAVAILABLE'));
  return ready;
}
export async function usesOfficialTeamTools(ctx) {
  const manager=ctx.get('pluginManager');
  if(!manager?.listPlugins)return false;
  return (await manager.listPlugins()).some(row=>row.moduleName==='@deepseek-ai/dsh-experimental-tool-agent-team'&&row.fiberPhase==='active');
}
