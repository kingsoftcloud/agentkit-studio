/** Publish connector pictures only, preserving all Agent/team/Skill definitions and installed IDs. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createGlobalConfiguration} from '../../src/global-config.mjs';
import {createTemplateCatalogClient} from '../../src/template-catalog-client.mjs';
import {createTemplateKs3Publisher} from '../../src/template-ks3-publisher.mjs';
import {loadConnectorLogos,applyConnectorArtwork} from '../workbuddy/connector-artwork.mjs';

const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
for(const key of ['--catalog','--connector-root','--server','--bucket','--output','--revision']) {
  if(!args.includes(key)||!arg(key)||arg(key).startsWith('--'))throw new Error(`Missing ${key}`);
}
const output=resolve(arg('--output'));await mkdir(output,{recursive:true,mode:0o700});
const catalog=JSON.parse(await readFile(resolve(arg('--catalog')),'utf8')),previous=structuredClone(catalog);
const index=await loadConnectorLogos({connectorRoot:resolve(arg('--connector-root')),output:join(output,'originals')});
await writeFile(join(output,'logo-index.json'),JSON.stringify(index,null,2),{mode:0o600});
const result=await applyConnectorArtwork({catalog,output:join(output,'artwork'),logos:index.logos});
const withoutArtwork=row=>{const copy=structuredClone(row);delete copy.artwork;return copy;};
if(!isDeepStrictEqual(previous.items,catalog.items)||!isDeepStrictEqual(previous.packages,catalog.packages)
  ||!isDeepStrictEqual(previous.resources.filter(row=>row.kind!=='mcp'),catalog.resources.filter(row=>row.kind!=='mcp'))
  ||!isDeepStrictEqual(previous.resources.map(withoutArtwork),catalog.resources.map(withoutArtwork))) {
  throw new Error('Connector artwork update changed Agent definitions, Skill artwork or resource dependencies');
}
const configuration=createGlobalConfiguration(),{values}=await configuration.resolve();
const client=createTemplateCatalogClient({origin:arg('--server'),configuration:async()=>configuration,timeoutMs:180000});
const capability=await client.action('GetStudioTemplateCatalogCapabilities');
if(!capability.PublishEnabled)throw new Error('Catalog publication is disabled');
if(Object.values(catalog.archives).some(asset=>!asset.key.startsWith(capability.StoragePrefix)))throw new Error('Source catalog belongs to a different owner');
const storage=createTemplateKs3Publisher({accessKey:values.cloudAccessKey,secretKey:values.cloudSecretKey,sessionToken:values.cloudSessionToken,bucket:arg('--bucket'),prefix:capability.StoragePrefix});
let next=0;
await Promise.all(Array.from({length:4},async()=>{
  while(next<result.images.length) {
    const image=result.images[next++],receipt=await storage.put(image.file,{type:'image'});
    if(receipt.sha256!==image.sha256)throw new Error('Rendered connector logo changed');
    catalog.archives[receipt.sha256]=receipt;
  }
}));
catalog.revision=arg('--revision');
await writeFile(join(output,'catalog-uploaded.json'),JSON.stringify(catalog),{mode:0o600});
const publication=await client.action('PublishStudioTemplateCatalog',{Catalog:catalog,Visibility:'private'});
const proof={...publication,...result.report,sourceImages:index.sourceImages,ambiguousAliases:index.ambiguous,sourceFailures:index.failures,distinctImages:result.images.length,definitionsAndDependenciesUnchanged:true,skillArtworkUnchanged:true,installedResourceIdsUnchanged:true,appReinstallRequired:false};
await writeFile(join(output,'publication.json'),JSON.stringify(proof,null,2),{mode:0o600});
console.log(JSON.stringify(proof));
