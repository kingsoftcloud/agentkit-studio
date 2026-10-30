import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createWorkspaceGitStatus} from '../src/host/services/workspace-status.mjs';
const execute=promisify(execFile);
test('Git observations count real tracked and untracked lines without executing filters or changing the index',async t=>{
  const root=await mkdtemp(join(tmpdir(),'studio-status-git-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execute('git',['-C',root,...args]);
  await git('init','-q');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  await writeFile(join(root,'a.txt'),'before\n');await writeFile(join(root,'.gitattributes'),'*.txt filter=danger\n');
  await git('add','.');await git('-c','commit.gpgsign=false','commit','-qm','Fixture baseline');
  const before=await readFile(join(root,'.git/index')), marker=join(root,'filter-executed');
  await git('config','filter.danger.clean',`printf dangerous > ${marker}`);
  await git('config','filter.danger.required','true');
  await writeFile(join(root,'a.txt'),'before\nafter\n');await writeFile(join(root,'new.txt'),'new line\n');
  let failure;
  const observer=createWorkspaceGitStatus({workspaceRoot:root,onError:error=>{failure=error;}});
  const value=await observer.read();
  assert.equal(value.state,'available',failure?.message ?? JSON.stringify(value));
  assert.equal(value.git.added,2);assert.equal(value.git.removed,0);assert.equal(value.git.dirtyFileCount,2);
  await assert.rejects(access(marker));assert.deepEqual(await readFile(join(root,'.git/index')),before);
  value.git.added=999;assert.equal((await observer.read()).git.added,2);
});
test('a non-repository has no invented branch or zero-change summary',async t=>{
  const root=await mkdtemp(join(tmpdir(),'studio-status-plain-'));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.deepEqual(await createWorkspaceGitStatus({workspaceRoot:root}).read(),{state:'not_repository',git:null});
});

test('a nested workspace never inherits sibling or parent repository changes', async t => {
  const repo=await mkdtemp(join(tmpdir(),'studio-status-scoped-'));t.after(()=>rm(repo,{recursive:true,force:true}));
  const git=(...args)=>execute('git',['-C',repo,...args]);
  await git('init','-q');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
  const workspace=join(repo,'task');await mkdir(workspace);
  await writeFile(join(repo,'outside.txt'),'outside\n');await writeFile(join(workspace,'tracked.txt'),'baseline\n');
  await git('add','.');await git('-c','commit.gpgsign=false','commit','-qm','Fixture baseline');
  // Both staged and unstaged parent changes must stay outside the observation.
  await writeFile(join(repo,'outside.txt'),'many\nunrelated\nchanges\n');await git('add','outside.txt');
  await writeFile(join(repo,'unrelated-new.txt'),'unrelated\n');
  await writeFile(join(workspace,'tracked.txt'),'baseline\nactual task change\n');
  await writeFile(join(workspace,'new.txt'),'task new\n');
  const value=await createWorkspaceGitStatus({workspaceRoot:workspace}).read();
  assert.equal(value.state,'available');
  assert.deepEqual({added:value.git.added,removed:value.git.removed,files:value.git.dirtyFileCount},{added:2,removed:0,files:2});
  const empty=join(repo,'empty');await mkdir(empty);
  const emptyValue=await createWorkspaceGitStatus({workspaceRoot:empty}).read();
  assert.equal(emptyValue.state,'available');
  assert.deepEqual({added:emptyValue.git.added,removed:emptyValue.git.removed,files:emptyValue.git.dirtyFileCount},{added:0,removed:0,files:0});
});
