import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPublicTemplateCatalogClient} from '../src/public-template-catalog.mjs';
import {templateDigest} from '../src/template-catalog-client.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTemplateCatalogSource} from '../src/template-catalog-source.mjs';

function fixture(environment='pre-online') {
 const origin='https://agentkit.ks3-cn-beijing.ksyuncs.com',base=origin+`/studio-templates/${environment}/v1/`,catalogId='public-test';
 const bodies=new Map(),calls=[];
 function put(path,value){const body=JSON.stringify(value);bodies.set(base+path,body);return{url:base+path,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')};}
 const item={id:'engineer',kind:'agent',name:'工程专家',spec:{runtime:{type:'harness'},instructions:{system:'完整提示词'}}};
 const digest=templateDigest(item),asset={sha256:'a'.repeat(64),bytes:5,type:'zip',DownloadUrl:base+'assets/'+ 'a'.repeat(64)+'.zip'};
 const detail=put('catalogs/public-test/agent/engineer.json',{catalogId,item,digest,packages:{},archives:{}});
 const list=put('catalogs/public-test/agents.json',{contract:'agentkit.studio.templates/v1',catalogId,categories:[],items:[{...item,digest}],total:1});
 const definitions=put('catalogs/public-test/definitions.json',{'agent/engineer':{digest,...detail}});
 const assets=put('catalogs/public-test/assets.json',{[asset.sha256]:asset});
 const manifest=put('catalogs/public-test/manifest.json',{format:'agentkit.public-template-catalog/v1',environment,catalogId,listings:{agent:list},definitions,assets});
 put('latest.json',{format:'agentkit.public-template-channel/v1',environment,catalogId,manifest});
 const fetchImpl=async(url,options={})=>{assert.equal(new Headers(options.headers).has('Authorization'),false);calls.push(String(url));let body=bodies.get(String(url));return new Response(body||'missing',{status:body?200:404,headers:{'content-length':String(Buffer.byteLength(body||'missing'))}});};
 return{client:createPublicTemplateCatalogClient({origin,environment:'pre-online',fetchImpl}),fetchImpl,bodies,calls,base,asset,digest};
}
test('an empty Studio configuration uses the public registry without an account, local Server, or prior cache',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'studio-public-clean-'));t.after(()=>rm(directory,{recursive:true,force:true}));const f=fixture();
 const source=await createTemplateCatalogSource({studioStoreDir:directory,env:{AGENTKIT_TEMPLATE_ENVIRONMENT:'pre-online'},configuration:async()=>({resolve:async()=>({values:{}})}),serverClient:()=>{throw Error('Fresh anonymous discovery must not require a cloud credential');},fetchImpl:f.fetchImpl});
 const list=await source.list();assert.equal(list.source,'public-snapshot');assert.equal(list.total,1);await source.ensure({id:'engineer',digest:f.digest});assert.equal(source.get({id:'engineer',digest:f.digest}).spec.instructions.system,'完整提示词');assert.ok(f.calls.every(x=>x.startsWith('https://agentkit.ks3-cn-beijing.ksyuncs.com/studio-templates/pre-online/')));
});
test('a clean client defaults to the production online template environment',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'studio-public-online-default-'));t.after(()=>rm(directory,{recursive:true,force:true}));const f=fixture('online');
 const source=await createTemplateCatalogSource({studioStoreDir:directory,env:{},configuration:async()=>({resolve:async()=>({values:{}})}),serverClient:()=>{throw Error('Default public discovery must not require a cloud credential');},fetchImpl:f.fetchImpl});
 const list=await source.list();assert.equal(list.source,'public-snapshot');assert.equal(list.total,1);assert.ok(f.calls.every(x=>x.startsWith('https://agentkit.ks3-cn-beijing.ksyuncs.com/studio-templates/online/')));
});
test('a clean client browses public templates and obtains immutable definitions and unsigned assets without credentials',async()=>{
 const f=fixture(),list=await f.client.action('ListStudioTemplates',{PageSize:1000});assert.equal(list.total,1);
 const detail=await f.client.action('GetStudioTemplate',{CatalogId:list.catalogId,Id:'engineer',Digest:f.digest});assert.equal(detail.item.spec.instructions.system,'完整提示词');
 const ticket=await f.client.action('GetStudioTemplateDownload',{CatalogId:list.catalogId,AssetId:f.asset.sha256});assert.equal(ticket.DownloadUrl,f.asset.DownloadUrl);assert.equal(ticket.Public,true);assert.ok(!ticket.DownloadUrl.includes('?'));
 assert.equal((await f.client.action('ListStudioTemplates',{Query:'不存在'})).total,0);
 await assert.rejects(f.client.action('GetStudioTemplate',{CatalogId:'another-version',Id:'engineer',Digest:f.digest}),{code:'TEMPLATE_DEFINITION_CHANGED'});
});
test('an unavailable KOP uses the Server snapshot and does not retry for every card image',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'studio-public-fallback-'));t.after(()=>rm(directory,{recursive:true,force:true}));const f=fixture();let calls=0;
 const source=await createTemplateCatalogSource({studioStoreDir:directory,env:{AGENTKIT_TEMPLATE_ENVIRONMENT:'pre-online'},configuration:async()=>({resolve:async()=>({values:{cloudAccessKey:'fixture',cloudSecretKey:'fixture'}})}),serverClient:async()=>({action:async()=>{calls++;throw Object.assign(Error('not registered'),{code:'SERVER_ACTION_NOT_REGISTERED'});}}),fetchImpl:f.fetchImpl});
 const listing=await source.list();await source.ensure({id:'engineer',digest:f.digest});assert.equal(listing.source,'public-snapshot');assert.equal(calls,1);
});
test('a public mirror refuses a changed payload or any cross-environment reference',async()=>{
 const f=fixture();f.bodies.set(f.base+'catalogs/public-test/agents.json','{"tampered":true}');
 await assert.rejects(f.client.action('ListStudioTemplates',{}),{code:'TEMPLATE_PUBLIC_INTEGRITY_FAILED'});
 const other=fixture(),latest=JSON.parse(other.bodies.get(other.base+'latest.json'));latest.manifest.url=latest.manifest.url.replace('/pre-online/','/online/');other.bodies.set(other.base+'latest.json',JSON.stringify(latest));
 await assert.rejects(other.client.action('ListStudioTemplates',{}),{code:'TEMPLATE_PUBLIC_ORIGIN_INVALID'});
});
