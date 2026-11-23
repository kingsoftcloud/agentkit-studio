import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const [executablePath,output]=process.argv.slice(2);
const root=resolve(output);
await mkdir(root,{recursive:true});
const workspace=join(root,'work');
await mkdir(workspace,{recursive:true});
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(KEY|SECRET|TOKEN|PASSWORD|CERTUM|PSMODULEPATH)/i.test(key)));
Object.assign(environment,{DSH_HOME:join(root,'dsh'),AGENTKIT_HOME:join(root,'agentkit'),DSH_TELEMETRY_DISABLED:'1',DSH_DESKTOP_OPEN_DEVTOOLS:'0'});
if(process.platform==='win32'){
 if(process.env.GITHUB_ACTIONS!=='true')throw new Error('Windows smoke uses disposable Actions runner defaults');
 delete environment.DSH_HOME; delete environment.AGENTKIT_HOME;
}
const proof={platform:process.platform,checkpoints:[],modelRequests:[]};
const checkpoint=async (fact)=>{proof.checkpoints.push(fact);console.log(fact);await writeFile(join(root,'evidence.json'),JSON.stringify(proof,null,2));};
const server=createServer(async(req,res)=>{
 if(req.url==='/v1/models')return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({object:'list',data:[{id:'restart-fixture',object:'model'}]}));
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 const messages=JSON.stringify(body.messages??[]);
 const mark=messages.includes('RESTART_STEP_TWO')?'RESTART_STEP_TWO':messages.includes('RESTART_STEP_ONE')?'RESTART_STEP_ONE':'other';
 const engine=(body.tools??[]).some(t=>t.function?.name==='read_workspace_file');
 const foundHistory=messages.includes('RESTART_STEP_ONE');
 const content=mark==='RESTART_STEP_TWO'?'RESTART_ACK_TWO':mark==='RESTART_STEP_ONE'?'RESTART_ACK_ONE':'FIXTURE_READY';
 proof.modelRequests.push({mark,engine,foundHistory,tools:body.tools?.length??0});console.log('fixture',JSON.stringify(proof.modelRequests.at(-1)));
 if(!body.stream)return res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'fixture',object:'chat.completion',model:'restart-fixture',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));
 res.writeHead(200,{'content-type':'text/event-stream'});
 const e=(delta,finish_reason)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'restart-fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n';
 res.end(e({role:'assistant',content},null)+e({},'stop')+'data: [DONE]\n\n');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let app,page;
const wait=120000;
async function boot(){
 app=await electron.launch({executablePath,args:['--user-data-dir='+join(root,'electron')],env:environment,timeout:wait});
 proof.app=await app.evaluate(({app})=>({isPackaged:app.isPackaged,version:app.getVersion(),pid:process.pid,electron:process.versions.electron}));
 page=await app.firstWindow({timeout:wait});
 await expect(page.locator('body')).toContainText('AgentKit Studio',{timeout:wait});
 console.log('startup window',page.url(),proof.app.version);
}
async function shutdown(){
 if(!app)return;
 const client=app, mainPid=proof.app.pid, child=client.process();
 let timer;
 await Promise.race([client.close().catch(()=>{}),new Promise(r=>{timer=setTimeout(r,8000);})]);
 clearTimeout(timer);
 for(const pid of new Set([mainPid,child?.pid])) if(pid){
   try {process.kill(pid,0);process.kill(pid,'SIGKILL');proof.forcedClose=true;}
   catch(e){if(e.code!=='ESRCH')throw e;}
 }
 app=null;
}
async function onboard(){
 const profile={id:'default',displayName:'Restart fixture',provider:'custom',modelName:'restart-fixture',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',credentialName:'studio-restart-fixture',enabled:true,default:true,protocol:'openai-chat'};
 const saved=await rpc('settings/update',{modelProvider:profile.provider,modelBaseUrl:profile.baseUrl,modelName:profile.modelName,modelProfiles:[profile],modelProfileKeys:{[profile.credentialName]:'qualification-local'}});
 assert.equal(saved?.result?.ok,true,JSON.stringify(saved?.result?.error??saved));
 await rpc('models/sync-credential');
 const status=await rpc('settings/get');
 assert.equal(status?.result?.value?.modelProfiles?.[0]?.modelName,'restart-fixture');
 await page.reload();
 await expect(page.getByRole('button',{name:/^(智能体|Agents)$/})).toBeVisible({timeout:wait});
}
async function plugin(){
 const visible=page.getByRole('region',{name:'Star Harness 管理'});
 if(await visible.isVisible())return visible;
 const open=page.getByRole('button',{name:/^(插件|Plugins)$/}).first();
 await open.click({timeout:30000});
 const item=page.getByText('Star Harness',{exact:true}).first();
 await item.click({timeout:30000});
 const panel=page.getByRole('region',{name:'Star Harness 管理'});
 await expect(panel).toBeVisible({timeout:30000});
 return panel;
}
async function install(panel,ver,action){
 await panel.getByRole('textbox',{name:'版本',exact:true}).fill(ver);
 await panel.getByRole('button',{name:action,exact:true}).click();
 await expect.poll(async()=> (await rpc('star-harness/status'))?.result?.value?.version,{timeout:215000}).toBe(ver);
 if(!await panel.isVisible()){
  await checkpoint('routing returned to the session after the upgrade; reopened the plugin page');
  panel=await plugin();
 }
 await expect(panel).toContainText('已安装 '+ver,{timeout:45000});
 await page.screenshot({path:join(root,'plugin-'+ver+'.png')});
 await checkpoint('插件页 '+action+' '+ver);
}
async function rpc(method,payload={}){
 return page.evaluate(async ({method,payload})=>{
   for(const path of ['/agentkit','/api/agentkit']){
    const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,payload,rpcId:method})});
    if(!r.ok)continue;
    try{return await r.json();}catch{}
   }
   return null;
 },{method,payload});
}
async function checked(method,payload){
 const reply=await rpc(method,payload);assert.equal(reply?.result?.ok,true,JSON.stringify(reply?.result?.error??reply));return reply.result.value;
}
async function createHarnessSession(){
 const address=await realpath(workspace);
 await checked('star-harness/bind',{workspace:address,profileId:'default'});
 const status=await checked('star-harness/enable',{enabled:true});
 assert.equal(status.enabled,true);assert.equal(status.canCreate,true);
 await page.getByRole('button',{name:/^(智能体|Agents)$/}).first().click();
 const local=page.getByRole('button',{name:'我的智能体',exact:true});
 if(await local.isVisible())await local.click();
 await page.getByRole('button',{name:'更多创建方式',exact:true}).click({timeout:30000});
 await page.getByRole('menuitem',{name:'手动配置',exact:true}).click({timeout:30000});
 await page.getByLabel('Agent ID',{exact:true}).fill('restart-fixture-agent');
 await page.getByLabel('名称',{exact:true}).fill('Restart fixture Agent');
 await page.locator('[role=radio][data-runtime=harness]').click({timeout:30000});
 await page.getByPlaceholder('描述 Agent 的身份、边界和回答方式',{exact:true}).fill('Reply directly to the test user.');
 await page.getByRole('button',{name:'下一步',exact:true}).click();
 const select=page.getByLabel('默认模型',{exact:true});
 if(await select.isVisible()){
  const option=select.locator('option[value]:not([value=""])').first();
  await option.waitFor({state:'attached',timeout:30000});
  await select.selectOption(await option.getAttribute('value'));
 }
 await page.getByRole('button',{name:'下一步',exact:true}).click();
 await page.getByRole('button',{name:'创建 Agent',exact:true}).click();
 const card=page.locator('[data-studio-agent-card]').filter({hasText:'Restart fixture Agent'});
 await card.waitFor({state:'visible',timeout:30000});
 await card.hover();
 await card.getByRole('button',{name:'对话',exact:true}).click();
 const choose=page.getByRole('button',{name:'开始对话',exact:true});
 if(await choose.isVisible({timeout:4000})){
  const choice=page.getByRole('combobox',{name:'Star Harness 工作区'});
  if(await choice.isVisible()){
   if(await choice.evaluate(e=>e.tagName)==='SELECT')await choice.selectOption(address);
   else {await choice.click();await page.getByRole('option').filter({hasText:'work'}).first().click();}
  }
  await choose.click();
 }
 await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({timeout:40000});
}
async function send(marker,ack){
 const composer=page.locator('[contenteditable="true"]').first();
 await composer.fill(marker);
 await composer.press('Enter');
 const success=page.getByText(ack,{exact:true}).last();
 const failed=page.getByText(/本轮未完成|Turn incomplete|View reason/).last();
 await expect(success.or(failed)).toBeVisible({timeout:90000});
 if(!await success.isVisible()){
  await failed.click({timeout:4000}).catch(()=>{});
  throw Error('continued message did not run: '+(await page.locator('body').innerText()).split('本轮未完成').at(-1).slice(0,340));
 }
 assert.ok(proof.modelRequests.some(r=>r.mark===marker&&r.engine),'signed engine did not submit the requested turn');
}
try{
 await boot();assert.equal(proof.app.isPackaged,true);await checkpoint('started signed Electron package');
 await onboard();await checkpoint('configured isolated fixture model');
 const panel=await plugin();
 await install(panel,'0.0.29','安装');
 await createHarnessSession();
 await send('RESTART_STEP_ONE','RESTART_ACK_ONE');
 await page.screenshot({path:join(root,'first-run.png')});
 await checkpoint('0.0.29 served the first turn through Star Harness');
 const upgrade=await plugin();
 await install(upgrade,'0.0.30','升级');
 const pid=proof.app.pid;
 await shutdown();await checkpoint('closed the original Electron process');
 await boot(); assert.notEqual(proof.app.pid,pid);
 const restored=await plugin();
 await expect(restored).toContainText('已安装 0.0.30',{timeout:wait});
 await page.screenshot({path:join(root,'plugin-after-restart.png')});
 await checkpoint('fresh packaged process shows installed 0.0.30');
 await page.getByRole('treeitem').filter({hasText:/RESTART_STEP_ONE/i}).last().click({timeout:30000});
 await expect(page.getByText('RESTART_ACK_ONE',{exact:true}).last()).toBeVisible({timeout:30000});
 await send('RESTART_STEP_TWO','RESTART_ACK_TWO');
 assert.ok(proof.modelRequests.some(r=>r.mark==='RESTART_STEP_TWO'&&r.engine&&r.foundHistory),'the resumed native session omitted previous turn');
 await page.screenshot({path:join(root,'session-resumed.png')});
 await checkpoint('0.0.30 continued the original session with retained history');
} catch(e){
 await checkpoint('失败 '+String(e.message).split('\n').slice(0,6).join(' '));
 if(page){console.log((await page.locator('body').innerText().catch(()=>'' )).slice(0,6000));await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});}
 process.exitCode=1;
} finally {
 await shutdown().catch(()=>{});
 server.closeAllConnections(); await new Promise(r=>server.close(r));
}
