/** Drive an installed baseline through the public feed, native download, installer and automatic restart. */
import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { windowsDownloadEvidence } from '../src/windows-update-evidence.mjs';

if (process.platform !== 'win32') throw new Error('Native Windows updater qualification requires Windows');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows') throw new Error('Native default-profile update qualification requires a disposable Windows Actions Runner');
const { values } = parseArgs({ options: { ...Object.fromEntries(['baseline', 'version', 'output'].map(key=>[key,{type:'string'}])), 'allow-full-fallback':{type:'boolean',default:false} } });
const executablePath = resolve(values.baseline), targetVersion=values.version;
const harnessVersion = '0.0.29';
const publicInstaller=await fetch(`https://agentkit.ks3-cn-beijing.ksyuncs.com/studio/${encodeURIComponent(targetVersion)}/AgentKit-Studio-win-x64.exe`,{method:'HEAD',signal:AbortSignal.timeout(60000)});
const fullBytes=Number(publicInstaller.headers.get('content-length'));
if (!publicInstaller.ok || !Number.isSafeInteger(fullBytes) || fullBytes<=0) throw new Error('Public target installer size is unavailable');
// NSIS can relaunch through Explorer, which does not inherit test overrides.
// Exercise the real user directories in this disposable Runner.
const evidence = resolve(values.output), home=join(homedir(),'.dsh'), journals=join(evidence,'journals');
await mkdir(home,{recursive:true}); await mkdir(journals,{recursive:true});
const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/(KEY|SECRET|TOKEN|PASSWORD|CERTUM|PSMODULEPATH)/i.test(name)));
delete environment.DSH_HOME; delete environment.AGENTKIT_HOME;
Object.assign(environment,{DSH_TELEMETRY_DISABLED:'1',DSH_DESKTOP_UPDATE_JOURNAL_DIR:journals});
const server=createServer((request,response)=>{
 request.resume();
 if(request.url==='/v1/models') {response.setHeader('Content-Type','application/json');response.end(JSON.stringify({object:'list',data:[{id:'upgrade-proof',object:'model'}]}));return;}
 response.setHeader('Content-Type','text/event-stream');
 for(const payload of [{id:'upgrade-proof',object:'chat.completion.chunk',model:'upgrade-proof',created:1,choices:[{index:0,delta:{role:'assistant',content:'Windows upgrade marker saved.'},finish_reason:null}]},{id:'upgrade-proof',object:'chat.completion.chunk',model:'upgrade-proof',created:1,choices:[{index:0,delta:{},finish_reason:'stop'}]}]) response.write('data: '+JSON.stringify(payload)+'\n\n');
 response.end('data: [DONE]\n\n');
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
await writeFile(join(home,'upgrade-retention-marker.txt'),'retained across native Windows update\n');
const app=await electron.launch({executablePath,cwd:dirname(executablePath),env:environment,timeout:120000});
// Windows may relaunch from the packaging/runtime bootstrap. Journal receipts
// belong to the actual Electron main process, rather than the launcher handle.
const launcherPid=app.process().pid;
const baselinePid=await app.evaluate(()=>process.pid);
environment.STUDIO_UPDATE_BASELINE_PID=String(baselinePid);
let updaterLog='';
for(const stream of [app.process().stdout,app.process().stderr]) stream?.on('data',bytes=>{updaterLog=(updaterLog+bytes.toString()).slice(-1024*1024);});
let confirming=false, successor=false, page;
try {
 page=await app.firstWindow({timeout:120000});
 page.on('pageerror',error=>console.log('Isolated baseline renderer error: '+error.message));
 await expect(page.locator('body')).toContainText('AgentKit Studio',{timeout:120000});
 await expect(page.getByRole('button',{name:/^(智能体|Agents)$/})).toBeVisible({timeout:30000});
 const before=await app.evaluate(({app})=>app.getVersion());
 if(before===targetVersion) throw new Error('Updater baseline is already the target version');
 const guide=page.locator('.agentkit-credential-onboarding-content');
 await expect(guide).toBeVisible({timeout:120000});
 await expect(page.locator('[data-desktop-onboarding]')).toHaveCount(0);
 await guide.getByRole('button',{name:/^(开始设置|去配置模型凭证)$/}).click();
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
 await page.getByRole('button',{name:/^(设置|Settings)$/}).click();
 await page.getByRole('button',{name:'AgentKit Studio',exact:true}).click();
 const settings=page.locator('[data-studio-settings]');
 const checkUpdate=settings.getByRole('button',{name:'检查更新',exact:true});
 await expect(checkUpdate).toBeEnabled({timeout:30000});
 await page.screenshot({path:join(evidence,'windows-check-for-updates.png'),fullPage:true});
 await checkUpdate.click();
 console.log('Clicked 检查更新 in installed Studio '+before);
 let readyOpened=false;
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
  // Download completion updates the button to Ready; the native UI requires
  // another open action to display installation confirmation.
  const native=await page.evaluate(()=>window.dshDesktop.updates.status());
  const install=settings.getByRole('button',{name:'安装 '+targetVersion,exact:true});
  if(native.phase==='ready' && !readyOpened && await install.isVisible()) {
   await install.click({timeout:10000});
   readyOpened=true;
  }
  await new Promise(done=>setTimeout(done,500));
 }
 if(!confirming) throw new Error('Native signed update was not downloaded and confirmed');
 // Observe a new native window without launching it or requiring an inherited
 // diagnostic environment variable. The helper also verifies rendered data.
 await promisify(execFile)('powershell.exe',['-NoProfile','-File',fileURLToPath(new URL('./verify-windows-updated-app.ps1',import.meta.url)),'-AppPath',executablePath,'-Evidence',evidence,'-RetainedText','Windows upgrade'],{env:environment,timeout:240000});
 successor=true;
 const installed=JSON.parse(asar.extractFile(join(dirname(executablePath),'resources','app.asar'),'package.json'));
 if(installed.version!==targetVersion) throw new Error('Installed bytes are not the feed target');
 if(await readFile(join(home,'upgrade-retention-marker.txt'),'utf8')!=='retained across native Windows update\n') throw new Error('Shared DSH data was not retained');
 const states=(await Promise.all((await readdir(journals)).filter(name=>name.endsWith('.jsonl')).map(async name=>(await readFile(join(journals,name),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))))).flat().filter(state=>state.pid===baselinePid);
 const downloadEvidence=windowsDownloadEvidence({log:updaterLog,states,fullBytes});
 const updateReceipt={downloadEvidence,baselineVersion:before,targetVersion,baselinePid,launcherPid,realPublicFeed:true,clickedCheckForUpdates:true,nativeDownload:true,nativeInstallConfirmed:true,automaticRestart:true,sharedDataRetained:true,conversationVisibleAfterRestart:true,updatedIdentity:installed.name};
 const receiptPath=join(evidence,'windows-online-update.json');
 await writeFile(receiptPath,JSON.stringify(updateReceipt,null,2));
 console.log('Automatic restart confirmed at '+targetVersion);
 const harnessVerifier=fileURLToPath(new URL('./verify-desktop-harness-release.mjs',import.meta.url));
 const {stdout:harnessLog}=await promisify(execFile)(process.execPath,[harnessVerifier,executablePath,harnessVersion],{env:environment,timeout:270000});
 if(!harnessLog.includes('validated the signed Star Harness '+harnessVersion+' release')) throw new Error('Upgraded Windows App did not verify and start the expected Harness');
 console.log(harnessLog.trim());
 await writeFile(receiptPath,JSON.stringify({...updateReceipt,harness:{version:harnessVersion,signedReleaseVerified:true,engineStarted:true}},null,2));
 if(!values['allow-full-fallback'] && downloadEvidence.kind!=='native-differential') throw new Error('Real differential qualification failed: '+downloadEvidence.kind);
} catch(error) {
 await page?.screenshot({path:join(evidence,'windows-update-failure.png'),fullPage:true}).catch(()=>{});
 // This clean Runner uses only the local fixture credential. Preserve startup
 // diagnostics without retaining its configuration file or request headers.
 const diagnostics=updaterLog.split('\n').filter(line=>/error|warn|plugin|agentkit|profile/i.test(line)).slice(-60).map(line=>line.replaceAll('qualification-local-only','[fixture credential]'));
 await writeFile(join(evidence,'windows-update-failure.json'),JSON.stringify({message:error.message,diagnostics},null,2));
 throw error;
} finally {
 if(!confirming) await app.close().catch(()=>{});
 server.closeAllConnections(); await new Promise(done=>server.close(done));
}
