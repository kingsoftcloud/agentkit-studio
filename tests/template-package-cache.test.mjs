import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createZip } from '../src/zip.mjs';
import { createTemplatePackageCache } from '../src/template-package-cache.mjs';
import { verifyPackage } from '../src/catalog-dependencies.mjs';
import { createTemplateWorkflows } from '../src/template-workflows.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'studio-download-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const payload = Buffer.from('FULL_REFERENCE_8316\n'.repeat(9000));
  const entries=[{name:'skills/demo/SKILL.md',data:Buffer.from('---\nname: demo\ndescription: Demo\n---\nRead references/context.txt')},{name:'skills/demo/references/context.txt',data:payload},{name:'skills/demo/scripts/check.sh',data:Buffer.from('#!/bin/sh\necho full-assets\n'),executable:true}];
  const zip=createZip(entries),files=entries.map(row=>({path:row.name,size:row.data.length,sha256:hash(row.data),executable:!!row.executable}));
  const calls=[],tickets=[];let corrupt=false;
  const server=createServer((req,res)=>{
    calls.push(req.headers.range||'full');let offset=req.headers.range?Number(req.headers.range.match(/bytes=(\d+)-/)[1]):0;
    res.writeHead(offset?206:200,{'Content-Length':zip.length-offset,ETag:'"fixed-version"',...(offset?{'Content-Range':`bytes ${offset}-${zip.length-1}/${zip.length}`}:{})});
    const data=corrupt?Buffer.alloc(zip.length,1):zip;
    const timer=setInterval(()=>{const end=Math.min(offset+8192,data.length);res.write(data.subarray(offset,end));offset=end;if(offset===data.length){clearInterval(timer);res.end();}},3);
    req.on('close',()=>clearInterval(timer));
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const asset={catalogId:'private-release',sha256:hash(zip),bytes:zip.length,expandedBytes:entries.reduce((n,r)=>n+r.data.length,0),type:'zip'};
  const client={action:async(action,payload)=>{assert.equal(action,'GetStudioTemplateDownload');tickets.push(payload);return{...asset,DownloadUrl:`http://127.0.0.1:${server.address().port}/file`};}};
  const cache=createTemplatePackageCache({directory:join(directory,'downloads'),client,allowTestLoopback:true});
  const bundle={digest:hash(JSON.stringify(files)),files,archive:asset};
  return{directory,cache,asset,bundle,calls,tickets,payload,setCorrupt:value=>{corrupt=value;}};
}
test('streamed bytes support cancel/resume with Range; complete cache and installed Skills avoid new downloads',async t=>{
  const f=await fixture(t),controller=new AbortController(),progress=[];
  await assert.rejects(()=>f.cache.download(f.asset,{signal:controller.signal,onProgress:event=>{progress.push(event);if(event.phase==='downloading'&&event.received>=32768)controller.abort();}}),{code:'TEMPLATE_CANCELLED'});
  const path=await f.cache.download(f.asset,{onProgress:event=>progress.push(event)});
  assert.ok(f.calls.some(row=>row.startsWith('bytes=')));assert.equal(hash(await readFile(path)),f.asset.sha256);
  const calls=f.calls.length;await f.cache.download(f.asset);assert.equal(f.calls.length,calls);
  const destination=join(f.directory,'installed',f.bundle.digest);
  await f.cache.ensure(f.bundle,{destination,verify:verifyPackage});
  assert.deepEqual(await readFile(join(destination,'skills/demo/references/context.txt')),f.payload);
  assert.ok((await stat(join(destination,'skills/demo/scripts/check.sh'))).mode&0o100);
  await f.cache.clear();assert.equal((await f.cache.stats()).files,0);
  await f.cache.ensure(f.bundle,{destination,verify:verifyPackage});assert.equal(f.calls.length,calls);
  assert.ok(progress.some(row=>row.phase==='downloading'&&row.received>0&&row.received<row.total));
});
test('concurrent readers share one transfer, and cancelling one reader does not cancel another',async t=>{
  const f=await fixture(t),one=new AbortController(),two=new AbortController();
  const first=f.cache.download(f.asset,{signal:one.signal,onProgress:event=>{if(event.received>=8192)one.abort();}});
  const second=f.cache.download(f.asset,{signal:two.signal});
  const results=await Promise.allSettled([first,second]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(f.calls.length,1);
});
test('digest mismatch refuses installation; a forged file inventory cannot be committed',async t=>{
  const f=await fixture(t);f.setCorrupt(true);
  const destination=join(f.directory,'installed',f.bundle.digest);
  await assert.rejects(()=>f.cache.ensure(f.bundle,{destination,verify:verifyPackage}),{code:'TEMPLATE_DOWNLOAD_DIGEST_MISMATCH'});
  await assert.rejects(()=>stat(destination),{code:'ENOENT'});
  f.setCorrupt(false);const forged={...f.bundle,files:f.bundle.files.map((row,i)=>i?row:{...row,sha256:'0'.repeat(64)})};
  await assert.rejects(()=>f.cache.ensure(forged,{destination,verify:verifyPackage}),{code:'TEMPLATE_ARCHIVE_CONTENT_MISMATCH'});
  await assert.rejects(()=>stat(destination),{code:'ENOENT'});
});
test('workflow cancellation and failures never continue into Agent creation; retries reconcile the same operation',async t=>{
  const f=await fixture(t);let creates=0;
  const workflows=createTemplateWorkflows({directory:join(f.directory,'workflows'),summon:async({signal,onProgress})=>{await f.cache.download(f.asset,{signal,onProgress});signal.throwIfAborted();onProgress({phase:'creating',cancellable:false});creates++;return{status:'created',agent:{metadata:{id:'ordinary-agent'}}};}});
  const payload={requestId:'operation-123456789',ref:{id:'expert'}};await workflows.start(payload);await workflows.cancel({requestId:payload.requestId});
  let status;do{await new Promise(r=>setTimeout(r,5));status=await workflows.status({requestId:payload.requestId});}while(status.status==='running');
  assert.equal(status.status,'cancelled');assert.equal(creates,0);
  await workflows.start(payload);do{await new Promise(r=>setTimeout(r,5));status=await workflows.status({requestId:payload.requestId});}while(status.status==='running');
  assert.equal(status.status,'succeeded');assert.equal(creates,1);await workflows.start(payload);assert.equal(creates,1);
});
