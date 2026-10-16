import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTemplatePublicStore } from '../src/template-public-store.mjs';
import { createPublicTemplateCatalogClient } from '../src/public-template-catalog.mjs';
const sha = data => createHash('sha256').update(data).digest('hex');

test('publishing and anonymous reads use one environment; activation happens after immutable bytes', async t => {
  const root = await mkdtemp(join(tmpdir(),'public-template-store-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const objects = new Map(), writes = [];
  const fetchImpl = async (url, options = {}) => {
    assert.ok(String(url).startsWith('https://agentkit.ks3-cn-beijing.ksyuncs.com/studio-templates/pre-online/v1/'));
    const headers = new Headers(options.headers), old = objects.get(url), method = options.method || 'GET';
    if (method === 'PUT') {
      assert.equal(headers.get('x-kss-acl'),'public-read'); assert.ok(headers.has('Authorization'));
      if (old && headers.get('if-match') !== old.headers.etag) return new Response('',{status:412});
      const body = Buffer.from(options.body), record = {body, headers:{'content-length':String(body.length),'x-kss-meta-sha256':sha(body),etag:'"'+sha(body)+'"'}};
      objects.set(url,record);writes.push(url);return new Response(null,{status:200});
    }
    if (!old) return new Response(null,{status:404});
    return new Response(method === 'HEAD' ? null : old.body,{status:200,headers:old.headers});
  };
  const store = createTemplatePublicStore({accessKey:'fixture',secretKey:'fixture',bucket:'agentkit',environment:'pre-online',owner:'a'.repeat(64),fetchImpl});
  const data = Buffer.from('complete skill'), path = join(root,'skill.zip');await writeFile(path,data);
  const asset = await store.putAsset(path,{sha256:sha(data),bytes:data.length,type:'zip'});
  const id = '12345678-1234-1234-1234-123456789012';
  const list = await store.putSnapshot(id,{catalogId:id,items:[],categories:[],total:0});
  const definitions = await store.putSnapshot(id,{}), assets = await store.putSnapshot(id,{[asset.sha256]:{...asset,DownloadUrl:store.origin+'/'+asset.key}});
  const manifest = await store.putSnapshot(id,{format:'agentkit.public-template-catalog/v1',environment:'pre-online',catalogId:id,listings:{agent:list},definitions,assets});
  await store.activate(id,manifest);
  const client = createPublicTemplateCatalogClient({fetchImpl});
  assert.equal((await client.action('ListStudioTemplates')).catalogId,id);
  assert.equal((await client.action('GetStudioTemplateDownload',{CatalogId:id,AssetId:asset.sha256})).Public,true);
  assert.ok(writes.at(-1).endsWith('/latest.json'));
  const before = writes.length;await store.putAsset(path,asset);assert.equal(writes.length,before);
  await assert.rejects(store.activate(id,{...manifest,url:manifest.url.replace('/pre-online/','/online/')}));
  await assert.rejects(store.putAsset(path,{...asset,sha256:'b'.repeat(64)}));
});
