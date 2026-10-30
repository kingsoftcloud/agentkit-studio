import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { supportsLocalProcessPlatform } from '../src/native/local-process.mjs';

test('Node command composition only enables platforms with a packaged POSIX launcher', () => {
  for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64'])
    assert.equal(supportsLocalProcessPlatform({ platform, arch }), true);
  assert.equal(supportsLocalProcessPlatform({ platform: 'win32', arch: 'x64' }), false);
  assert.equal(supportsLocalProcessPlatform({ platform: 'linux', arch: 's390x' }), false);
});

const moduleUrl = new URL('../src/native/local-command-state.mjs', import.meta.url).href;
const probe = String.raw`
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fs=createRequire(import.meta.url)('node:fs'), mode=process.argv[1];
const root=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'local-read-race-')), path=join(root,mode==='record'?'record.json':'file');
const base={schemaVersion:'agentkit.local-background-command/v1',owner:'a'.repeat(64),commandId:'b'.repeat(64),
 requestDigest:'c'.repeat(64),createdAt:Date.now(),timeoutMs:1000};
const old=mode==='record'?JSON.stringify({...base,status:'running',exitCode:null}):'原始😀';
const next=mode==='record'?JSON.stringify({...base,status:'completed',exitCode:0}):'完整😀';
fs.writeFileSync(path,old,{mode:0o600});
const open=fs.openSync, close=fs.closeSync;let opens=0,closes=0;const fds=new Set();
fs.openSync=(file,...args)=>{
 const fd=open(file,...args);
 if(file===path){opens++;fds.add(fd);
  if(opens===1||mode==='churn'){
   const temporary=join(root,'next');
   if(mode==='symlink') fs.symlinkSync(join(root,'target'),temporary);
   else fs.writeFileSync(temporary,next,{mode:mode==='public'?0o644:0o600});
   fs.renameSync(temporary,path);
  }
 }return fd;
};
fs.closeSync=fd=>{if(fds.delete(fd))closes++;return close(fd);};
syncBuiltinESMExports();
try{
 const state=await import(process.argv[2]); let result,code;
 try{
  if(mode==='record') result=state.readRecord(root,'a'.repeat(64),'b'.repeat(64)).status;
  else if(mode==='all') result=state.readAll(path);
  else if(mode==='write'){const fd=state.openPrivate(path,fs.constants.O_WRONLY);fs.closeSync(fd);state.check(false,'unexpected_write_admission');}
  else result=state.readWindow(path,0,64).text;
 }catch(error){code=error.code;}
 console.log(JSON.stringify({result,code,opens,closes,leaked:fds.size}));
}finally{fs.openSync=open;fs.closeSync=close;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
`;
for (const mode of ['window', 'all', 'record', 'churn', 'symlink', 'public', 'write']) test(`private command ${mode} read handles atomic replacement without weakening file checks`, () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe, mode, moduleUrl], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.leaked, 0); assert.equal(result.opens, result.closes);
  if (['window', 'all', 'record'].includes(mode)) {
    assert.equal(result.code, undefined); assert.equal(result.opens, 2);
    assert.equal(result.result, mode === 'record' ? 'completed' : '完整😀');
  } else {
    assert.equal(result.code, ['symlink', 'public'].includes(mode) ? 'background_state_not_private' : 'background_state_changed');
    assert.equal(result.opens, mode === 'churn' ? 4 : 1);
  }
});
