/** Anonymous read-only mirror of a Server-published immutable catalog. */
import {createHash} from 'node:crypto';
const fail=(code,message,status=0)=>{throw Object.assign(new Error(message),{code,status});};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function createPublicTemplateCatalogClient({origin='https://agentkit.ks3-cn-beijing.ksyuncs.com',environment='pre-online',fetchImpl=fetch}={}) {
 if(!['pre-online','online'].includes(environment)||!/^https:\/\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.ks3-cn-(?:beijing|shanghai|guangzhou|ningbo|qinghai|qingyang)\.ksyuncs\.com$/.test(origin))fail('TEMPLATE_PUBLIC_ORIGIN_INVALID','公开模板地址或环境无效');
 const prefix=`/studio-templates/${environment}/v1/`,versions=new Map(),files=new Map();let latest,loadedAt=0;
 function checkedUrl(value){let url;try{url=new URL(value);}catch{fail('TEMPLATE_PUBLIC_ORIGIN_INVALID','公开模板地址无效');}if(url.origin!==origin||!url.pathname.startsWith(prefix)||url.search||url.hash||url.username||url.password||/%/.test(url.pathname))fail('TEMPLATE_PUBLIC_ORIGIN_INVALID','公开模板不能跨桶或跨环境读取');return url.href;}
 async function json(ref,{signal}={},unlocked=false){
  const url=checkedUrl(ref.url);if(!unlocked&&(!/^[a-f0-9]{64}$/.test(ref.sha256||'')||!Number.isInteger(ref.bytes)||ref.bytes<1||ref.bytes>16*1024*1024))fail('TEMPLATE_PUBLIC_INTEGRITY_FAILED','公开模板元数据摘要无效');
  let response;try{response=await fetchImpl(url,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch{if(signal?.aborted)fail('TEMPLATE_CANCELLED','已取消模板操作');fail('TEMPLATE_SERVER_UNAVAILABLE','公开模板目录暂时无法连接');}
  if(!response.ok||!response.body){await response.body?.cancel();fail('TEMPLATE_SERVER_UNAVAILABLE','公开模板目录暂不可用',response.status);}
  const parts=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>(unlocked?65536:ref.bytes)){await response.body.cancel?.().catch(()=>{});fail('TEMPLATE_PUBLIC_INTEGRITY_FAILED','公开模板元数据超过声明大小');}parts.push(chunk);}
  const bytes=Buffer.concat(parts);if(!unlocked&&(bytes.length!==ref.bytes||hash(bytes)!==ref.sha256))fail('TEMPLATE_PUBLIC_INTEGRITY_FAILED','公开模板元数据校验失败');
  try{return JSON.parse(bytes);}catch{fail('TEMPLATE_PUBLIC_INTEGRITY_FAILED','公开模板元数据格式无效');}
 }
 async function file(ref,options){checkedUrl(ref.url);const key=ref.sha256;if(files.has(key))return files.get(key);const value=await json(ref,options);files.set(key,value);return value;}
 async function snapshot(id,options){
  if(id&&versions.has(id))return versions.get(id);
  if(!latest||Date.now()-loadedAt>30000){const channel=await json({url:origin+prefix+'latest.json'},options,true);if(channel.format!=='agentkit.public-template-channel/v1'||channel.environment!==environment)fail('TEMPLATE_PUBLIC_ORIGIN_INVALID','公开目录的环境不匹配');const manifest=await file(channel.manifest,options);if(manifest.format!=='agentkit.public-template-catalog/v1'||manifest.environment!==environment||manifest.catalogId!==channel.catalogId)fail('TEMPLATE_PUBLIC_INTEGRITY_FAILED','公开目录版本不匹配');latest=manifest;loadedAt=Date.now();versions.set(manifest.catalogId,manifest);}
  if(id&&id!==latest.catalogId)fail('TEMPLATE_DEFINITION_CHANGED','模板目录已更新，请刷新后重试',409);return latest;
 }
 return{async action(action,payload={},options={}){
  const manifest=await snapshot(payload.CatalogId,options);
  if(action==='GetStudioTemplateCatalogCapabilities')return{Contract:'agentkit.studio.templates/v1',PublishEnabled:false,Distribution:'public-snapshot',Environment:environment};
  if(action==='ListStudioTemplates'){
   const kind=payload.Kind||'agent';if(!['agent','team','skill','mcp'].includes(kind)||!manifest.listings[kind])fail('TEMPLATE_DEFINITION_CHANGED','模板类型不可用',404);
   const result=await file(manifest.listings[kind],options),needle=String(payload.Query||'').trim().toLowerCase();let items=result.items.filter(x=>(!payload.CategoryId||x.categoryId===payload.CategoryId)&&(!payload.Runtime||x.runtimes?.includes(payload.Runtime))&&(!needle||[x.name,x.description,...x.tags||[]].join(' ').toLowerCase().includes(needle)));
   const page=Math.max(1,Number(payload.Page)||1),size=Math.min(1000,Math.max(1,Number(payload.PageSize)||500)),start=(page-1)*size;
   return{...result,source:'public-snapshot',environment,items:items.slice(start,start+size),total:items.length,hasMore:start+size<items.length};
  }
  if(action==='GetStudioTemplate'){
   const index=await file(manifest.definitions,options),entry=index[`${payload.Kind||'agent'}/${payload.Id}`];if(!entry)fail('TEMPLATE_DEFINITION_CHANGED','模板不存在',404);if(payload.Digest&&payload.Digest!==entry.digest)fail('TEMPLATE_DEFINITION_CHANGED','模板已变化，请刷新目录',409);return file(entry,options);
  }
  if(action==='GetStudioTemplateDownload'){
   const assets=await file(manifest.assets,options),asset=assets[payload.AssetId];if(!asset)fail('TEMPLATE_DEFINITION_CHANGED','模板资源不存在',404);checkedUrl(asset.DownloadUrl);return{...asset,Public:true,ExpiresIn:0};
  }
  fail('ACTION_NOT_ALLOWED','公开模板目录仅支持读取');
 }};
}
