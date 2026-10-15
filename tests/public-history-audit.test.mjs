import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rename,rm,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditPublicHistory} from '../scripts/public-history-audit.mjs';

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
