/** Upload private complete resources before publishing an immutable Server index. */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGlobalConfiguration } from '../../src/global-config.mjs';
import { createTemplateCatalogClient, templateDigest } from '../../src/template-catalog-client.mjs';
import { createTemplateKs3Publisher } from '../../src/template-ks3-publisher.mjs';
import { seed } from '../../packages/expert-catalog/src/seed.mjs';
const args = process.argv.slice(2), arg = name => args[args.indexOf(name)+1];
for (const flag of ['--catalog','--server','--bucket','--output','--revision']) if (!args.includes(flag)) throw new Error(`Missing ${flag}`);
const run = promisify(execFile), input = resolve(arg('--catalog')), output = resolve(arg('--output')); await mkdir(output, { recursive: true, mode: 0o700 });
const configuration = createGlobalConfiguration(), { values } = await configuration.resolve();
const client = createTemplateCatalogClient({ origin: arg('--server'), configuration: async () => configuration, timeoutMs:180000 });
const capabilities = await client.action('GetStudioTemplateCatalogCapabilities');
if (!capabilities.PublishEnabled) throw new Error('Server has not enabled catalog publication');
if(args.includes('--resume')) {
  const uploaded=JSON.parse(await readFile(join(output,'catalog-uploaded.json'),'utf8'));
  if(uploaded.revision!==arg('--revision'))throw new Error('Resume must retain the exact original catalog revision');
  const published=await client.action('PublishStudioTemplateCatalog',{Catalog:uploaded,Visibility:'private'});
  await writeFile(join(output,'publication.json'),JSON.stringify({...published,packages:Object.keys(uploaded.packages).length,private:true},null,2),{mode:0o600});
  console.log(JSON.stringify({...published,private:true,reconciled:true}));process.exit(0);
}
const source = JSON.parse(await readFile(input,'utf8'));
source.categories = [...seed.categories, ...source.categories]; source.items = [...seed.items, ...source.items]; source.revision = arg('--revision'); source.archives = {};
const storage = createTemplateKs3Publisher({ accessKey: values.cloudAccessKey, secretKey: values.cloudSecretKey, sessionToken: values.cloudSessionToken, bucket: arg('--bucket'), prefix: capabilities.StoragePrefix });
for (const item of source.items) if (item.dependencies?.package) source.packages[item.dependencies.package.digest] ||= item.dependencies.package;
const packages = Object.values(source.packages), images = new Map(); let next = 0, completed = 0;
await Promise.all(Array.from({length:4}, async () => {
  while(next < packages.length) {
    const bundle = packages[next++], manifest = join(output, `${bundle.digest}.files.json`), archive = join(output, `${bundle.digest}.zip`);
    await writeFile(manifest, JSON.stringify(bundle.files), {mode:0o600});
    try { await access(archive); } catch { await run('python3', [resolve('scripts/templates/pack-assets.py'), join(dirname(input), bundle.path), manifest, archive], {maxBuffer:1024*1024}); }
    const receipt = await storage.put(archive,{expandedBytes:bundle.files.reduce((sum,file)=>sum+file.size,0),packageDigest:bundle.digest});
    source.archives[receipt.sha256] = receipt; bundle.archiveId = receipt.sha256;
    completed++; if (completed % 25 === 0) console.log(JSON.stringify({stage:'private-assets',completed,total:packages.length}));
  }
}));
for (const item of [...source.items,...source.resources||[]].filter(item=>item.artwork?.path)) {
  const artwork = item.artwork;
  if (!images.has(artwork.sha256)) {
    const receipt = await storage.put(join(dirname(input),artwork.packagePath || item.dependencies.package.path,artwork.path), {type:'image'});
    if (receipt.sha256 !== artwork.sha256) throw new Error('Avatar changed before publication');
    images.set(receipt.sha256,receipt); source.archives[receipt.sha256] = receipt;
  }
  artwork.blobId = artwork.sha256;
}
for (const item of (source.resources || []).filter(item=>item.kind==='team')) for (const role of item.roles) {
  const agent = source.items.find(row=>row.id===role.template.id);
  if (!agent) throw new Error('Team Agent template is missing');
  role.template.digest=templateDigest(agent);
}
await writeFile(join(output,'catalog-uploaded.json'),JSON.stringify(source),{mode:0o600});
const published = await client.action('PublishStudioTemplateCatalog',{Catalog:source,Visibility:'private'});
await writeFile(join(output,'publication.json'),JSON.stringify({...published,packages:packages.length,images:images.size,private:true},null,2),{mode:0o600});
console.log(JSON.stringify({...published,packages:packages.length,private:true}));
