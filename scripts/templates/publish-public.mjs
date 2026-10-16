/** Public environment distribution; credentials remain in the operator's Host config. */
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {createGlobalConfiguration} from '../../src/global-config.mjs';
import {canonicalJson} from '../../src/template-catalog-client.mjs';
import {createTemplatePublicStore} from '../../src/template-public-store.mjs';
const args=process.argv.slice(2),mode=args[0],arg=name=>args[args.indexOf(name)+1];
for(const flag of ['--environment','--bucket','--owner','--output'])if(!args.includes(flag)||!arg(flag)||arg(flag).startsWith('--'))throw Error(`Missing ${flag}`);
const output=resolve(arg('--output')),environment=arg('--environment'),owner=arg('--owner');await mkdir(output,{recursive:true,mode:0o700});
const {values}=await createGlobalConfiguration().resolve();
const store=createTemplatePublicStore({accessKey:values.cloudAccessKey,secretKey:values.cloudSecretKey,sessionToken:values.cloudSessionToken,bucket:arg('--bucket'),environment,owner});
if(mode==='assets'){
  for(const flag of ['--catalog','--paths','--revision','--redistribution-confirmed'])if(!args.includes(flag))throw Error(`Missing ${flag}`);
  const catalog=JSON.parse(await readFile(resolve(arg('--catalog')),'utf8')),paths=JSON.parse(await readFile(resolve(arg('--paths')),'utf8'));
  catalog.revision=arg('--revision');catalog.distribution={environment,origin:store.origin};delete catalog.publication;
  const assets=Object.values(catalog.archives);let next=0,completed=0;
  if(assets.some(asset=>!paths[asset.sha256]))throw Error('Every public asset needs a local verified source');
  await Promise.all(Array.from({length:8},async()=>{
    while(next<assets.length){const asset=assets[next++];let receipt;
      for(let attempt=0;attempt<3;attempt++){try{receipt=await store.putAsset(paths[asset.sha256],asset);break;}catch(error){if(attempt===2)throw error;}}
      catalog.archives[asset.sha256]=receipt;completed++;
      if(completed%50===0)console.log(JSON.stringify({stage:'public-assets',environment,completed,total:assets.length}));
    }
  }));
  catalog.publication={mode:'operator-confirmed-redistribution',owner,contentDigest:createHash('sha256').update(canonicalJson(catalog)).digest('hex')};
  await writeFile(join(output,'catalog-public.json'),JSON.stringify(catalog),{mode:0o600});
  console.log(JSON.stringify({stage:'assets-verified',environment,assets:assets.length,bytes:assets.reduce((n,x)=>n+x.bytes,0)}));
}else if(mode==='snapshot'){
  if(!args.includes('--snapshot'))throw Error('Missing --snapshot');
  const directory=resolve(arg('--snapshot')),publication=JSON.parse(await readFile(join(directory,'publication.json'),'utf8'));
  if(publication.environment!==environment)throw Error('Snapshot environment does not match');
  const files=(await readdir(directory)).filter(x=>/^[a-f0-9]{64}\.json$/.test(x));let next=0,completed=0;
  await Promise.all(Array.from({length:8},async()=>{
    while(next<files.length){const name=files[next++],value=await readFile(join(directory,name));let reference;
      for(let attempt=0;attempt<3;attempt++){try{reference=await store.putSnapshot(publication.catalogId,value);break;}catch(error){if(attempt===2)throw error;}}
      if(basename(new URL(reference.url).pathname)!==name)throw Error('Server JSON bytes changed during upload');
      completed++;if(completed%100===0)console.log(JSON.stringify({stage:'public-snapshot',completed,total:files.length}));
    }
  }));
  // Activate only after every immutable definition, index and manifest is readable.
  const channel=await store.activate(publication.catalogId,publication.manifest);
  await writeFile(join(output,'publication.json'),JSON.stringify({...publication,channel,jsonFiles:files.length}),{mode:0o600});
  console.log(JSON.stringify({stage:'activated',catalogId:publication.catalogId,environment,jsonFiles:files.length}));
}else throw Error('Usage: publish-public.mjs assets|snapshot --environment pre-online|online --bucket BUCKET --owner SHA256 --output DIR ...');
