/** Durable progress is polled over the existing authenticated Host RPC. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
export function createTemplateWorkflows({ directory, summon, summonTeam, prepare, install, catalog, authoring, dependencies, resourceLibrary }) {
  prepare ||= async (ref, options={}) => {await catalog.ensure?.(ref,'agent',options);const value=authoring.prepare(ref),item=catalog.get(ref);value.spec.bindings.skills=(await dependencies.materialize(item,options)).map(row=>row.resourceId);options.onProgress?.({phase:'checking-mcp',label:'正在检查 MCP 连接'});const mcp=await dependencies.resolveMcp(item,{install:true});value.spec.bindings.mcpServers=mcp.ids;return value;};
  install ||= (ref,options)=>resourceLibrary.install(ref,options);
  const jobs = new Map();
  let closed = false;
  const file = id => join(directory,`${id}.json`);
  const valid = id => { if(!/^[a-zA-Z0-9-]{16,80}$/.test(id||''))throw new Error('模板操作标识无效'); };
  const view = job => structuredClone(job.state);
  async function start(payload) {
    if (closed) throw Object.assign(new Error('模板服务已关闭'), { code: 'TEMPLATE_SERVICE_CLOSED' });
    const id=payload.requestId;valid(id);const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    let existing=jobs.get(id);
    if(existing){if(existing.fingerprint!==fingerprint)throw new Error('不能更改进行中操作的资源');if(existing.state.status==='running'||existing.state.status==='succeeded')return view(existing);}
    let persisted;try{persisted=JSON.parse(await readFile(file(id)));}catch{}
    if(persisted?.fingerprint&&persisted.fingerprint!==fingerprint)throw new Error('模板操作与此前请求不一致');
    if (persisted?.status === 'succeeded') { const { fingerprint: _fingerprint, ...completed } = persisted; return structuredClone(completed); }
    const job={fingerprint,controller:new AbortController(),state:{requestId:id,status:'running',progress:{phase:'checking',label:'正在读取模板与依赖'},cancellable:true}};jobs.set(id,job);
    let queue=Promise.resolve();
    const persist=()=>{const snapshot=JSON.stringify({...job.state,fingerprint});queue=queue.then(async()=>{await mkdir(directory,{recursive:true,mode:0o700});const temp=file(id)+'.next';await writeFile(temp,snapshot,{mode:0o600});await rename(temp,file(id));}).catch(()=>{});return queue;};
    await persist();
    const options={signal:job.controller.signal,onProgress:event=>{job.state.progress=event;job.state.cancellable=event.cancellable!==false&&event.phase!=='creating';}};
    job.promise=Promise.resolve().then(async()=>{
      try {
        const result=await (payload.kind==='prepare'?prepare(payload.ref,options):payload.kind==='install-skill'?install(payload.ref,options):payload.kind==='summon-team'?summonTeam({...payload,...options}):summon({...payload,...options}));
        job.state={...job.state,status:'succeeded',cancellable:false,result};
      }catch(error){job.state={...job.state,status:job.controller.signal.aborted||error.code==='TEMPLATE_CANCELLED'?'cancelled':'failed',cancellable:false,error:{code:job.controller.signal.aborted?'TEMPLATE_CANCELLED':error.code||'TEMPLATE_OPERATION_FAILED',message:job.controller.signal.aborted?'已取消，可重新尝试；下载缓存仍可复用':error.message||'模板操作失败，请重试'}};}
      await persist();
    });
    return view(job);
  }
  return {async close(){closed=true;for(const job of jobs.values())job.controller.abort();let timer;try{await Promise.race([Promise.allSettled([...jobs.values()].map(job=>job.promise)),new Promise(resolve=>{timer=setTimeout(resolve,2000);timer.unref?.();})]);}finally{clearTimeout(timer);jobs.clear();}},start,prepare,async detail(ref){await catalog.ensure?.(ref);const{dependencies,migration,...item}=catalog.get(ref);return{...item,dependencies:{skills:dependencies?.skills||[],mcp:dependencies?.mcp||[]}};},async cache(){return catalog.packageCache?(await catalog.packageCache()).stats():{files:0,bytes:0,activeDownloads:0};},async clearCache(){return catalog.packageCache?(await catalog.packageCache()).clear():{cleared:true};},async status({requestId}){valid(requestId);const job=jobs.get(requestId);if(job)return view(job);const saved=JSON.parse(await readFile(file(requestId)));if(saved.status==='running')return{...saved,status:'interrupted',error:{code:'TEMPLATE_INTERRUPTED',message:'上次操作被中断，可重新召唤继续'}};delete saved.fingerprint;return saved;},async cancel({requestId}){valid(requestId);const job=jobs.get(requestId);if(job?.state.status==='running'&&job.state.cancellable)job.controller.abort();return job?view(job):{requestId,status:'unknown',cancellable:false};}};
}
