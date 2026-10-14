/** Drive an installed baseline through the public feed, native download, installer and automatic restart. */
import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';

if (process.platform !== 'win32') throw new Error('Native Windows updater qualification requires Windows');
const { values } = parseArgs({ options: Object.fromEntries(['baseline', 'version', 'output'].map(key=>[key,{type:'string'}])) });
const executablePath = resolve(values.baseline), targetVersion=values.version;
// Keep profiles outside the source checkout: ancestor node_modules must not
// shadow the signed application's runtime during profile bundle resolution.
const evidence = resolve(values.output), root=join(tmpdir(),'studio-update-'+Date.now()), home=join(root,'shared-dsh'), journals=join(evidence,'journals');
await mkdir(home,{recursive:true}); await mkdir(journals,{recursive:true});
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/(KEY|SECRET|TOKEN|PASSWORD|CERTUM|PSMODULEPATH)/i.test(name)));
Object.assign(environment,{DSH_HOME:home,AGENTKIT_HOME:join(root,'agentkit'),DSH_TELEMETRY_DISABLED:'1',DSH_DESKTOP_UPDATE_JOURNAL_DIR:journals});
const server=createServer((request,response)=>{
 request.resume();
 if(request.url==='/v1/models') {response.setHeader('Content-Type','application/json');response.end(JSON.stringify({object:'list',data:[{id:'upgrade-proof',object:'model'}]}));return;}
 response.setHeader('Content-Type','text/event-stream');
 for(const payload of [{id:'upgrade-proof',object:'chat.completion.chunk',model:'upgrade-proof',created:1,choices:[{index:0,delta:{role:'assistant',content:'Windows upgrade marker saved.'},finish_reason:null}]},{id:'upgrade-proof',object:'chat.completion.chunk',model:'upgrade-proof',created:1,choices:[{index:0,delta:{},finish_reason:'stop'}]}]) response.write('data: '+JSON.stringify(payload)+'\n\n');
 response.end('data: [DONE]\n\n');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
await writeFile(join(home,'upgrade-retention-marker.txt'),'retained across native Windows update\n');
const app=await electron.launch({executablePath,cwd:dirname(executablePath),args:['--user-data-dir='+join(root,'baseline-electron')],env:environment,timeout:120000});
const baselinePid=app.process().pid;
let updaterLog='';
for(const stream of [app.process().stdout,app.process().stderr]) stream?.on('data',bytes=>{updaterLog=(updaterLog+bytes.toString()).slice(-1024*1024);});
let confirming=false, successor=false, page;
try {
 page=await app.firstWindow({timeout:120000});
 page.on('pageerror',error=>console.log('Isolated baseline renderer error: '+error.message));
 await expect(page.locator('body')).toContainText('AgentKit Studio',{timeout:120000});
 await expect(page.getByRole('button',{name:'Agents',exact:true})).toBeVisible({timeout:30000});
 const before=await app.evaluate(({app})=>app.getVersion());
 if(before===targetVersion) throw new Error('Updater baseline is already the target version');
 const guide=page.locator('.agentkit-credential-onboarding-content');
 await expect(guide).toBeVisible({timeout:120000});
 await page.getByRole('button',{name:'去配置模型凭证',exact:true}).click();
 await expect(guide).toBeHidden({timeout:30000});
 // Configure through the installed product's settings. A Studio config file
 // alone does not register the native DSH provider/model preference namespace.
 const models=page.locator('[data-studio-model-settings]');
 await expect(models.getByRole('button',{name:'保存配置',exact:true})).toBeEnabled({timeout:90000});
 await models.getByRole('combobox',{name:/^提供商/}).first().selectOption('custom');
 await models.getByLabel('模型名称',{exact:true}).first().fill('upgrade-proof');
 await models.getByLabel('API 地址',{exact:true}).first().fill(`http://127.0.0.1:${server.address().port}/v1`);
 await models.getByLabel(/^API Key/).first().fill('qualification-local-only');
 await models.getByRole('button',{name:'保存配置',exact:true}).click();
 await expect(models).toContainText('已保存多个模型配置',{timeout:90000});
 await page.keyboard.press('Escape');
 await expect(models).toBeHidden({timeout:30000});
 // The global New session action opens an inert workspace picker. Create a
 // retained Session using the default workspace's own new-session action.
 await page.getByRole('treeitem').filter({hasText:/Default workspace|默认工作区/}).first().hover();
 await page.getByRole('button',{name:/New session in|中新建会话/}).first().click();
 const composer=page.locator('[contenteditable="true"]').first();
 await expect(composer).toBeVisible({timeout:30000});
 await composer.fill('Windows upgrade marker: retain this conversation after restarting.');
 await composer.press('Enter');
 await expect(page.locator('body')).toContainText('Windows upgrade marker saved.',{timeout:120000});
 await page.screenshot({path:join(evidence,'windows-before-update.png'),fullPage:true});
 await page.evaluate(()=>{void window.dshDesktop.updates.open();});
 const deadline=Date.now()+900000;
 while(Date.now()<deadline) {
  for(const dialog of app.windows()) {
   if(dialog.url()!=='dsh-app://shell/update-dialog.html') continue;
   const view=await dialog.evaluate(()=>window.dshUpdateDialog.status()).catch(()=>null);
   if(!view) continue;
   const download=view.buttons.findIndex(name=>/Download update|下载更新/.test(name));
   if(download>=0) {await dialog.screenshot({path:join(evidence,'windows-update-available.png')});await dialog.evaluate(index=>window.dshUpdateDialog.status().then(view=>window.dshUpdateDialog.respond(view.revision,index)),download);continue;}
   if(view.message.includes(targetVersion) && /ready to install|准备就绪/.test(view.message)) {
    confirming=true; await dialog.screenshot({path:join(evidence,'windows-update-ready.png')});
    await dialog.evaluate(()=>window.dshUpdateDialog.status().then(view=>window.dshUpdateDialog.respond(view.revision,0))).catch(()=>{});
    break;
   }
   if(/Could not|失败|Cannot find channel|404/.test(view.message)) throw new Error('Native updater displayed a failure');
  }
  if(confirming) break;
  await new Promise(done=>setTimeout(done,500));
 }
 if(!confirming) throw new Error('Native signed update was not downloaded and confirmed');
 const restartDeadline=Date.now()+240000;
 let events=[];
 while(Date.now()<restartDeadline) {
  events=(await Promise.all((await readdir(journals)).filter(n=>n.endsWith('.jsonl')).map(async n=>(await readFile(join(journals,n),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)))).flat();
  if(events.some(e=>e.version===targetVersion && e.pid!==baselinePid && e.event==='workspace-ready')) {successor=true;break;}
  await new Promise(done=>setTimeout(done,1000));
 }
 if(!successor) throw new Error('Updated app did not automatically restart and reach workspace-ready');
 const installed=JSON.parse(asar.extractFile(join(dirname(executablePath),'resources','app.asar'),'package.json'));
 if(installed.version!==targetVersion) throw new Error('Installed bytes are not the feed target');
 if(await readFile(join(home,'upgrade-retention-marker.txt'),'utf8')!=='retained across native Windows update\n') throw new Error('Shared DSH data was not retained');
 await promisify(execFile)('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('./verify-windows-updated-app.ps1',import.meta.url)),'-AppPath',executablePath,'-Evidence',evidence,'-RetainedText','Windows upgrade'],{env:environment,timeout:240000});
 const differential=updaterLog.match(/Full:\s*([0-9,.]+)\s*KB,\s*To download:\s*([0-9,.]+)\s*KB\s*\(([0-9.]+)%\)/);
 const downloadEvidence=differential ? {kind:'native-differential',fullKilobytes:Number(differential[1].replaceAll(',','')),downloadKilobytes:Number(differential[2].replaceAll(',','')),ratioPercent:Number(differential[3])} : {kind:'not-established'};
 await writeFile(join(evidence,'windows-online-update.json'),JSON.stringify({downloadEvidence,baselineVersion:before,targetVersion,baselinePid,realPublicFeed:true,nativeDownload:true,nativeInstallConfirmed:true,automaticRestart:true,sharedDataRetained:true,conversationVisibleAfterRestart:true,updatedIdentity:installed.name},null,2));
} catch(error) {
 await page?.screenshot({path:join(evidence,'windows-update-failure.png'),fullPage:true}).catch(()=>{});
 // This clean Runner uses only the local fixture credential. Preserve startup
 // diagnostics without retaining its configuration file or request headers.
 const diagnostics=updaterLog.split('\n').filter(line=>/error|warn|plugin|agentkit|profile/i.test(line)).slice(-60).map(line=>line.replaceAll('qualification-local-only','[fixture credential]'));
 await writeFile(join(evidence,'windows-update-failure.json'),JSON.stringify({message:error.message,diagnostics},null,2));
 throw error;
} finally {
 if(!confirming) await app.close().catch(()=>{});
 await new Promise(done=>server.close(done));
}
