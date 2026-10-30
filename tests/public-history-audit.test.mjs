import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rename,rm,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditPublicHistory, auditHistoricalBlob} from '../scripts/public-history-audit.mjs';
import {PUBLIC_HISTORY_BASELINE} from '../scripts/public-history-baseline.mjs';
import {auditText} from '../scripts/public-surface-audit.mjs';

test('a reviewed historical fixture cannot exempt current, changed or foreign-path content',()=>{
  const entry=PUBLIC_HISTORY_BASELINE.find(item=>item.file==='packages/agentkit-harness/test/native-browser-workspace-server.test.mjs');
  const bytes=execFileSync('git',['cat-file','blob',entry.blob]);
  assert.deepEqual(auditHistoricalBlob(entry.file,bytes),[]);
  assert.ok(auditText(entry.file,bytes).length>0,'the snapshot gate still rejects this literal');
  assert.ok(auditHistoricalBlob(entry.file,Buffer.concat([bytes,Buffer.from('\n// changed\n')])).length>0);
  assert.ok(auditHistoricalBlob('src/unreviewed.mjs',bytes).length>0);
});

test('public history gate catches a forbidden historical filename after a clean rename',async t=>{
  const root=await mkdtemp(join(tmpdir(),'studio-public-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git(['init','-q']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
  await writeFile(join(root,'.env'),'Historical credential configuration');git(['add','.']);git(['commit','-qm','old']);
  await rename(join(root,'.env'),join(root,'README.md'));git(['add','.']);git(['commit','-qm','rename']);
  const result=auditPublicHistory(root);
  assert.ok(result.hits.some(hit=>hit.file==='.env'&&hit.kind==='forbidden public path'));
});

test('public history gate rejects private documentation even after its deletion',async t=>{
  const root=await mkdtemp(join(tmpdir(),'studio-private-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
  git(['init','-q']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
  await mkdir(join(root,'docs'));
  await writeFile(join(root,'docs','acceptance.md'),[['INTERNAL','-ONLY'].join(''),['/Users','/','fixture-owner/workspace'].join('')].join('\n'));
  git(['add','.']);git(['commit','-qm','old documentation']);
  git(['rm','-q','docs/acceptance.md']);git(['commit','-qm','remove documentation']);
  const result=auditPublicHistory(root);
  for(const kind of ['private-classification-marker','personal-absolute-path']) {
    assert.ok(result.hits.some(hit=>hit.file==='docs/acceptance.md'&&hit.kind===kind));
  }
});
