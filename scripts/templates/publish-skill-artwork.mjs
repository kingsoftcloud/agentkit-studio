/** Publish only Skill artwork; retain every Agent, team, package and installed resource identity. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createGlobalConfiguration } from '../../src/global-config.mjs';
import { createTemplateCatalogClient } from '../../src/template-catalog-client.mjs';
import { createTemplateKs3Publisher } from '../../src/template-ks3-publisher.mjs';
import { applySkillArtwork } from '../workbuddy/skill-artwork.mjs';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
for(const key of ['--catalog','--package-root','--server','--bucket','--output','--revision'])if(!args.includes(key))throw new Error(`Missing ${key}`);
const output=resolve(arg('--output'));await mkdir(output,{recursive:true,mode:0o700});
const source=JSON.parse(await readFile(resolve(arg('--catalog')),'utf8')),previous=structuredClone(source);
const index=JSON.parse(await readFile(new URL('../workbuddy/skill-logo-sources.json',import.meta.url))),logos={},failures=[];
await mkdir(join(output,'originals'),{recursive:true,mode:0o700});
let next=0;
await Promise.all(Array.from({length:4},async()=>{while(next<index.logos.length){const entry=index.logos[next++];try {
  const url=new URL(entry.url);if(!['openplatform-cdn.codebuddy.cn','codebuddy-platform-1258344699.cos.accelerate.myqcloud.com'].includes(url.hostname)||url.protocol!=='https:'||url.search||url.username||url.password)throw new Error('Logo URL must be a public static asset');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length||bytes.length>4*1024*1024)throw new Error('Logo exceeds size limit');
  const format=url.pathname.endsWith('.svg')?'svg':'png',file=join(output,'originals',entry.key+'.'+format);await writeFile(file,bytes,{mode:0o600});
  const row={key:entry.key,file,format,sha256:createHash('sha256').update(bytes).digest('hex')};for(const name of [entry.key,...entry.aliases||[]])logos[name.toLowerCase()]=row;
}catch(error){failures.push({key:entry.key,reason:error.message});}}}));
await writeFile(join(output,'logo-index.json'),JSON.stringify(logos,null,2),{mode:0o600});
const result=await applySkillArtwork({catalog:source,packageRoot:resolve(arg('--package-root')),output:join(output,'artwork'),logos});
const withoutArtwork=value=>{const copy=structuredClone(value);delete copy.artwork;return copy;};
if(!isDeepStrictEqual(previous.items,source.items)||!isDeepStrictEqual(previous.packages,source.packages)
  ||!isDeepStrictEqual(previous.resources.filter(row=>row.kind!=='skill'),source.resources.filter(row=>row.kind!=='skill'))
  ||!isDeepStrictEqual(previous.resources.map(withoutArtwork),source.resources.map(withoutArtwork)))throw new Error('Artwork update changed Agent definitions or resource dependencies');
const configuration=createGlobalConfiguration(),{values}=await configuration.resolve();
const client=createTemplateCatalogClient({origin:arg('--server'),configuration:async()=>configuration,timeoutMs:180000});
const capability=await client.action('GetStudioTemplateCatalogCapabilities');if(!capability.PublishEnabled)throw new Error('Catalog publication is disabled');
if(Object.values(source.archives).some(asset=>!asset.key.startsWith(capability.StoragePrefix)))throw new Error('Source catalog belongs to a different owner');
const storage=createTemplateKs3Publisher({accessKey:values.cloudAccessKey,secretKey:values.cloudSecretKey,sessionToken:values.cloudSessionToken,bucket:arg('--bucket'),prefix:capability.StoragePrefix});
next=0;await Promise.all(Array.from({length:4},async()=>{while(next<result.images.length){const image=result.images[next++],receipt=await storage.put(image.file,{type:'image'});if(receipt.sha256!==image.sha256)throw new Error('Rendered logo changed');source.archives[receipt.sha256]=receipt;}}));
source.revision=arg('--revision');await writeFile(join(output,'catalog-uploaded.json'),JSON.stringify(source),{mode:0o600});
const publication=await client.action('PublishStudioTemplateCatalog',{Catalog:source,Visibility:'private'});
const proof={...publication,...result.report,distinctImages:result.images.length,logoFailures:failures,definitionsAndDependenciesUnchanged:true,installedResourceIdsUnchanged:true,appReinstallRequired:false};
await writeFile(join(output,'publication.json'),JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
