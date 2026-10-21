/** Lazy Server definitions plus an identity-scoped metadata cache and offline seeds. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createExpertCatalog } from '../packages/expert-catalog/src/catalog.mjs';
import { loadExpertCatalog } from '../packages/expert-catalog/src/release.mjs';
import { createTemplateCatalogClient, templateDigest } from './template-catalog-client.mjs';
import { createTemplatePackageCache } from './template-package-cache.mjs';
import { createPublicTemplateCatalogClient } from './public-template-catalog.mjs';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
export async function createTemplateCatalogSource({ studioStoreDir, env = process.env, configuration, serverClient, fetchImpl=fetch }) {
  let settings;
  try { settings = JSON.parse(await readFile(join(studioStoreDir,'template-source.json'),'utf8')); } catch(error) { if (error.code !== 'ENOENT') throw error; }
  const origin = env.AGENTKIT_TEMPLATE_SERVER_URL || settings?.origin;
  if (!origin && (env.AGENTKIT_TEMPLATE_CATALOG_FILE || settings?.source==='local')) return loadExpertCatalog(env.AGENTKIT_TEMPLATE_CATALOG_FILE || join(studioStoreDir,'template-catalog','catalog.json'), { optional:!env.AGENTKIT_TEMPLATE_CATALOG_FILE, personalLocal:true });
  const environment=env.AGENTKIT_TEMPLATE_ENVIRONMENT||settings?.environment||'online';
  const fallback = createExpertCatalog(), direct = createTemplateCatalogClient({ origin, environment, configuration, serverClient, fetchImpl }), mirror=createPublicTemplateCatalogClient({environment,fetchImpl});
  let retryServerAt=0;
  const client={async action(name,payload={},options={}){
    if(origin)return direct.action(name,payload,options);
    const {values}=await(await configuration()).resolve();
    if(values.cloudAccessKey&&values.cloudSecretKey&&Date.now()>=retryServerAt){try{return await direct.action(name,payload,options);}catch(error){if(options.signal?.aborted)throw error;retryServerAt=Date.now()+60000;}}
    return mirror.action(name,payload,options);
  }};
  let active;
  async function state() {
    const { values } = await (await configuration()).resolve();
    const identity = createHash('sha256').update(JSON.stringify([origin||'public-ks3',environment,values.cloudAccessKey || 'anonymous'])).digest('hex');
    if (active?.identity === identity) return active;
    const root = join(studioStoreDir,'template-cache',identity), records = new Map(), index = new Map();
    active = { identity, root, records, index, packages:createTemplatePackageCache({directory:join(root,'downloads'),client,fetchImpl}) };
    return active;
  }
  const key = ref => `${ref.id}:${ref.digest || ''}`;
  async function save(path, value) {
    await mkdir(join(path,'..'),{recursive:true,mode:0o700}); const temporary=path+'.'+randomUUID()+'.next'; await writeFile(temporary,JSON.stringify(value),{mode:0o600}); await rename(temporary,path);
  }
  function remember(current, result) {
    for(const item of result.items) current.index.set(item.id,{...item,catalogId:result.catalogId});
    current.listing = result; return result;
  }
  async function ensure(ref, kind = 'agent', options = {}) {
    const current = await state();
    try { const local=fallback.get(ref); if (ref.digest === local.digest) return local; } catch {}
    if(current.records.has(key(ref)))return current.records.get(key(ref)).item;
    const metadata=current.index.get(ref.id), catalogId=ref.catalogId || metadata?.catalogId || current.listing?.catalogId;
    const cacheKey=createHash('sha256').update(key(ref)).digest('hex'), path=join(current.root,'definitions',cacheKey+'.json');
    let result;
    try { result=await client.action('GetStudioTemplate',{CatalogId:catalogId,Id:ref.id,Kind:kind,Digest:ref.digest || ''},options); }
    catch(error) { if(error.code!=='TEMPLATE_SERVER_UNAVAILABLE')throw error; try{result=JSON.parse(await readFile(path,'utf8'));}catch{throw error;} }
    if(templateDigest(result.item)!==result.digest || (ref.digest && result.digest!==ref.digest))fail('TEMPLATE_DEFINITION_CHANGED','模板定义与锁定摘要不一致');
    const record={...result,item:{...result.item,digest:result.digest}};current.records.set(key(record.item),record);current.records.set(key(ref),record);
    await save(path,result); return record.item;
  }
  function get(ref) {
    const item=active?.records.get(key(ref))?.item;
    if(item)return structuredClone(item);
    return fallback.get(ref);
  }
  function assets(ref) {
    const record=active?.records.get(key(ref)); if(!record)return fallback.assets(ref);
    const expand=group=>({...group,...(group.package?{package:{...record.packages[group.package.digest],...group.package,archive:{...record.archives[record.packages[group.package.digest].archiveId],catalogId:record.catalogId}}}:{}),additional:(group.additional||[]).map(expand)});
    return {root:undefined,dependencies:expand(record.item.dependencies||{skills:[],mcp:[]})};
  }
  const source={isRemote:true,client,ensure,get,assets,resource:get,
    async list() {
      const current=await state();
      try {
        const result=await client.action('ListStudioTemplates',{PageSize:1000});
        for(let page=2;result.hasMore;page++){const next=await client.action('ListStudioTemplates',{CatalogId:result.catalogId,Page:page,PageSize:1000});result.items.push(...next.items);result.hasMore=next.hasMore;}
        await save(join(current.root,'catalog.json'),result);return remember(current,result);
      }catch(error){
        if(error.status===401||error.status===403)throw error;
        try{const cached=JSON.parse(await readFile(join(current.root,'catalog.json'),'utf8'));return {...remember(current,cached),offline:true,notice:'正在显示本机目录缓存，尚未下载的资源需要连接 Server。'};}catch{return {...fallback.list(),offline:true,notice:'模板 Server 暂不可用，正在显示内置模板。'};}
      }
    },
    prepare(ref){const item=get(ref),catalogId=active?.records.get(key(ref))?.catalogId;return{name:item.name,description:item.description,spec:item.spec,requirements:item.requirements,runtimes:item.runtimes,examples:item.examples,templateSource:{catalog:'studio-builtin',...(catalogId?{catalogId}:{}),id:item.id,version:item.version,digest:item.digest}};},
    async listResources(query={}){
      const current=await state(),page=Number(query.cursor||1),result=await client.action('ListStudioTemplates',{Kind:query.kind,Query:query.query||'',Page:page,PageSize:Math.min(1000,query.limit||60)});
      for(const item of result.items)current.index.set(item.id,{...item,catalogId:result.catalogId});
      return{...result,nextCursor:result.hasMore?String(page+1):null};
    },
    async packageCache(){return(await state()).packages;},
    async avatar(ref){
      const current=await state(),item=current.index.get(ref.id);if(!item?.artwork?.asset)return null;
      const file=await current.packages.download({...item.artwork.asset,catalogId:item.catalogId}),bytes=await readFile(file);
      if(bytes.length>4*1024*1024)fail('TEMPLATE_ARTWORK_INVALID','专家图片超过大小限制');
      const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
      return mime?`data:${mime};base64,${bytes.toString('base64')}`:null;
    },
  };
  return source;
}
