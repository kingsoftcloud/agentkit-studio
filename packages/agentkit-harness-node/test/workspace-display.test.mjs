import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceChangeDisplay} from '../src/native/workspace-display.mjs';
const file = text => ({kind: 'file', bytes: Buffer.from(text).toString('base64')});

test('actual preimages yield separated hunks, real positions and change counts without filesystem access', () => {
  const before = Array.from({length: 25}, (_,i)=>`line ${i+1}`);
  const after = before.slice();after[2]='changed three';after[21]='changed twenty-two';
  const result = workspaceChangeDisplay(new Map([['src/example.ts',{before:file(before.join('\n')+'\n'),after:file(after.join('\n')+'\n')}]]));
  const display = result.display.files[0];
  assert.equal(result.contract,'agentkit.workspace-display/v1');
  assert.equal(display.operationKind,'edit');
  assert.deepEqual(display.changeStat,{added:2,removed:2});
  assert.equal(display.patch.match(/^@@/gm).length,2);
  assert.equal(display.truncated,false);
  assert.match(display.patch,/-line 3\n\+changed three/);
});

test('creation, deletion, no-op, binary and oversized data remain honest bounded projections', () => {
  const changes = new Map([
    ['new.txt',{before:{kind:'absent'},after:file('new\n')}],
    ['old.txt',{before:file('old\n'),after:{kind:'absent'}}],
    ['same.txt',{before:file('same\n'),after:file('same\n')}],
    ['binary',{before:file('\0'),after:file('x')}],
    ['huge',{before:file('a'.repeat(140000)),after:file('x')}],
  ]);
  const {display}=workspaceChangeDisplay(changes);
  assert.equal(display.omittedFiles,2);
  assert.deepEqual(display.files.map(f=>f.operationKind),['create','delete','edit']);
  assert.deepEqual(display.files[2].changeStat,{added:0,removed:0});
  assert.equal(display.files[2].patch,'');
  assert.ok(JSON.stringify(display).length<25000);
});

test('executed workspace writes attach captured diffs, while denied writes cannot claim a change', async t => {
  const {mkdtempSync,mkdirSync,readFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {createNativeWorkspaceTools}=await import('../src/native/workspace-tools.mjs');
  const root=mkdtempSync(join(tmpdir(),'native-display-')),workspaceRoot=join(root,'work');mkdirSync(workspaceRoot);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let allowed=true,sequence=0;
  const tools=createNativeWorkspaceTools({workspaceRoot,stateDir:join(root,'state'),sessionId:'session',enableRewind:true,authorize:async()=>allowed?'allow':'deny'});
  const execute=arguments_=>tools.execute({scope:{tenantId:'t',workspaceId:'w',userId:'u',agentId:'a'},runId:'run',turnId:'turn',buildId:'build',parentRunId:null,taskChainId:'run',sessionId:'session',executionFence:1,operationKey:`operation-${++sequence}`,
    signal:new AbortController().signal,definition:tools.definitions.find(d=>d.name==='write_workspace_file'),call:{callId:`call-${sequence}`,name:'write_workspace_file',arguments:arguments_}}, {assertCurrent:()=>true});
  const created=await execute({path:'report.txt',content:'old\n'});
  assert.equal(created.status,'ok');assert.equal(created.metadata.nativeTaskDisplay.display.files[0].operationKind,'create');
  const changed=await execute({path:'report.txt',content:'new\n',overwrite:true});
  assert.equal(changed.status,'ok');assert.match(changed.metadata.nativeTaskDisplay.display.files[0].patch,/-old\n\+new/);
  assert.equal(readFileSync(join(workspaceRoot,'report.txt'),'utf8'),'new\n');
  allowed=false;const denied=await execute({path:'report.txt',content:'denied\n',overwrite:true});
  assert.equal(denied.status,'error');assert.equal(denied.metadata?.nativeTaskDisplay,undefined);
  assert.equal(readFileSync(join(workspaceRoot,'report.txt'),'utf8'),'new\n');
});
