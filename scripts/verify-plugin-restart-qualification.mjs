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
 app=await electron.launch({executablePath,cwd:dirname(executablePath),args:['--user-data-dir='+join(root,'electron')],env:environment,timeout:wait});
 proof.app=await app.evaluate(({app})=>({isPackaged:app.isPackaged,version:app.getVersion(),pid:process.pid,electron:process.versions.electron}));
 page=await app.firstWindow({timeout:wait});
 await expect(page.locator('body')).toContainText('AgentKit Studio',{timeout:wait});
 await expect(page.getByRole('button',{name:/^(智能体|Agents)$/})).toBeVisible({timeout:wait});
}
async function onboard(){
 const guide=page.locator('.agentkit-credential-onboarding-content');
 await expect(guide).toBeVisible({timeout:wait});
 await guide.getByRole('button',{name:/^(开始设置|去配置模型凭证)$/}).click();
 const setup=page.locator('[data-studio-onboarding-stage=model]');
 await setup.getByRole('combobox',{name:'提供商',exact:true}).selectOption('custom');
 await setup.getByLabel('API 地址',{exact:true}).fill('http://127.0.0.1:'+server.address().port+'/v1');
 await setup.getByLabel('API Key',{exact:true}).fill('qualification-local');
 await setup.getByLabel('模型名称',{exact:true}).fill('restart-fixture');
 await setup.getByRole('button',{name:'保存并继续',exact:true}).click();
 await guide.getByRole('button',{name:'跳过，开始对话',exact:true}).click({timeout:wait});
 await expect(guide).toBeHidden({timeout:wait});
}
async function plugin(){
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
 await expect(panel).toContainText('已安装 '+ver,{timeout:215000});
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
try{
 await boot();assert.equal(proof.app.isPackaged,true);await checkpoint('已启动正式 Electron 安装包');
 await onboard();await checkpoint('隔离工作区模型配置完成');
 const panel=await plugin();
 await install(panel,'0.0.29','安装');
 const pressed=page.getByRole('switch',{name:'启用 Star Harness'});
 if(await pressed.isVisible()) await pressed.click();
 await page.screenshot({path:join(root,'plugin-setup.png')});
 const preview=await page.locator('body').innerText();
 console.log('PLUGIN_TEXT',preview.slice(0,5200));
 await install(panel,'0.0.30','升级');
 const pid=proof.app.pid;
 await app.close();app=null;await checkpoint('退出升级后的第一次进程');
 await boot();
 assert.notEqual(proof.app.pid,pid);
 const restored=await plugin();
 await expect(restored).toContainText('已安装 0.0.30',{timeout:wait});
 await page.screenshot({path:join(root,'plugin-after-restart.png')});
 await checkpoint('新进程的插件页显示 0.0.30');
 console.log('ROUTES',JSON.stringify(await rpc('star-harness/status')));
 console.log('NAV', (await page.getByRole('button').allTextContents()).filter(Boolean).slice(0,65).join('|'));
} catch(e){
 await checkpoint('失败 '+String(e.message).split('\n').slice(0,6).join(' '));
 if(page){console.log((await page.locator('body').innerText().catch(()=>'' )).slice(0,6000));await page.screenshot({path:join(root,'failure.png')}).catch(()=>{});}
 process.exitCode=1;
} finally {
 await app?.close().catch(()=>{});
 server.closeAllConnections(); await new Promise(r=>server.close(r));
}
