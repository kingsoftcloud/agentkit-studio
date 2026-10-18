/** Current DSH Host acceptance for Studio teams; uses a controlled local model. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
assert.ok(process.env.AGENTKIT_DSH_ROOT && process.env.DSH_HOME && process.env.STUDIO_VERIFY_PROFILE, 'Set AGENTKIT_DSH_ROOT, DSH_HOME and STUDIO_VERIFY_PROFILE to an isolated installed profile');
const source=resolve(process.env.AGENTKIT_DSH_ROOT), home=await mkdtemp(join(tmpdir(),'studio-rc2-teams-'));
const profile=process.env.STUDIO_VERIFY_PROFILE;
const installed=join(process.env.DSH_HOME,'profiles',profile,'node_modules/@kingsoftcloud/agentkit-studio');
const {mountStudioHost}=await import(pathToFileURL(join(installed,'src/host/bootstrap.mjs')));
const {syncPortableModelProfiles}=await import(pathToFileURL(join(installed,'src/portable-model-bridge.mjs')));
const require=createRequire(join(source,'apps/cli/package.json'));
const {loadLayeredEnv}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const {runProfile}=await import(pathToFileURL(join(source,'apps/cli/lib/profile-boot.js')));
const report={evidence:'real-current-dsh-studio-team-creation-and-direct-inbox-controlled-model',passed:false,checks:[]};
let modelCalls=0,messageCalls=0,spawnCalls=0,running,fiber,origin,cookie,launchUrl;
const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);modelCalls++;const all=JSON.stringify(body.messages),system=JSON.stringify(body.messages.filter(x=>x.role==='system'||x.role==='developer'));
 let text='Team validation',tool;
 const tools=(body.tools||[]).map(x=>x.function?.name);
 const user=body.messages.filter(x=>x.role==='user').map(x=>JSON.stringify(x.content)).join('\n');
 if(tools.includes('send_message')&&system.includes('TEAM_RC2_MEMBER')){
  if(!body.messages.some(x=>x.role==='tool')){tool={name:'send_message',arguments:JSON.stringify({target:'lead',message:'TEAM_RESULT_42'})};messageCalls++;}
  else text='MEMBER_COMPLETE_42';
 } else if(tools.includes('spawn_teammate')&&user.includes('TEAM_TASK')){
  if(user.includes('TEAM_RESULT_42'))text='TEAM_FINAL_42';
  else if(!body.messages.some(x=>x.role==='tool')){tool={name:'spawn_teammate',arguments:JSON.stringify({name:'checker',prompt:'计算17+25，并向lead发送TEAM_RESULT_42。'})};spawnCalls++;}
  else tool={name:'wait_agent',arguments:'{"timeout_ms":10000}'};
 }
 if(modelCalls>35){res.writeHead(429);res.end('{}');return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const delta=tool?{tool_calls:[{index:0,id:'call_'+modelCalls,type:'function',function:tool}]}:{content:text};
 res.end('data: '+JSON.stringify({id:'team_'+modelCalls,choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const profiles=[{id:'rc2-team-model',modelName:'team-model',provider:'openai-compatible',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,credentialName:'TEAM_FIXTURE_KEY',enabled:true,default:true}];
await writeFile(join(home,'config.yaml'),JSON.stringify({modelProfiles:profiles,modelProfileKeys:{TEAM_FIXTURE_KEY:'synthetic-fixture'}}),{mode:0o600});
const overlay=join(home,'overlay.yml');await writeFile(overlay,'- id: agentkit-studio\n  disabled: true\n');
const stdout=process.stdout.write.bind(process.stdout);let launch='';
process.stdout.write=(chunk,...args)=>{launch=(launch+String(chunk)).slice(-8000);launchUrl=launch.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)?.[1]||launchUrl;args.find(x=>typeof x==='function')?.();return true;};
async function rpc(method,payload={}){
 const response=await fetch(origin+'/agentkit',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({method,payload,rpcId:method}),signal:AbortSignal.timeout(20000)});
 const {result}=await response.json();if(!result.ok)throw Object.assign(new Error(result.error.message),{code:result.error.code});return result.value;
}
try{
 running=await runProfile({profile,environment:loadLayeredEnv('dsh',source),patchFiles:[overlay],args:['--no-open','--host','127.0.0.1','--port','0']});
 assert.ok(launchUrl);origin=new URL(launchUrl).origin;const login=await fetch(launchUrl,{redirect:'manual'});cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 await syncPortableModelProfiles({settings:running.ctx.get('settings'),profiles});await running.ctx.root.loader.await();
 fiber=await running.ctx.plugin({name:'studio-team-upgrade-proof',inject:['connection','webServer','credentials'],apply:ctx=>mountStudioHost(ctx,{env:{AGENTKIT_HOME:home,CODEX_HOME:join(home,'codex')},configurationHome:home})});
 assert.equal(fiber.state,2);
 const agents=[];
 for(const role of ['LEAD','MEMBER'])agents.push(await rpc('agents/create-local',{name:'RC2 '+role,runtimeType:'dsh-native',spec:{instructions:{system:'TEAM_RC2_'+role},bindings:{modelProfileId:profiles[0].id}}}));
 const team=await rpc('teams/save',{name:'RC2 actual Inbox validation',leadAgentId:agents[0].metadata.id,members:[{name:'checker',label:'验算员',agentId:agents[1].metadata.id,instructions:'计算并向lead发送报告'}]});
 const run=await rpc('teams/start',{id:team.id,revision:team.revision,task:'TEAM_TASK: 使用指定成员计算17+25，收到成员报告后完成汇总。',requestId:randomUUID()});
 let last;const deadline=Date.now()+90000;
 while(Date.now()<deadline){last=await rpc('teams/status',{runId:run.id});if(last.output.includes('TEAM_FINAL_42')&&last.status!=='running')break;await new Promise(r=>setTimeout(r,250));}
 assert.ok(last.output.includes('TEAM_FINAL_42'),JSON.stringify({status:last.status,output:last.output,members:last.members}));
 assert.equal(spawnCalls,1);assert.equal(messageCalls,1);assert.equal(last.members.length,2);assert.ok(last.members.every(x=>!x.lastError));
 const child=last.members.find(x=>x.role==='teammate');assert.ok(child);
 const lead=running.ctx.get('agents').get(run.id),member=running.ctx.get('agents').get(child.id);
 const events=lead.session.snapshotEvents();assert.ok(events.some(event=>event.type==='agent/inbox/spliced'&&JSON.stringify(event.data).includes('TEAM_RESULT_42')));
 report.checks=['local-agent-create','team-definition-save','role-snapshot-admission','official-teammate-spawn','direct-lead-inbox-delivery','lead-summary'].map(name=>({name,passed:true}));report.passed=true;report.members=last.members.map(x=>({role:x.role,status:x.status}));report.modelCalls=modelCalls;report.messageCalls=messageCalls;report.spawnCalls=spawnCalls;
}catch(error){report.modelCalls=modelCalls;report.messageCalls=messageCalls;report.spawnCalls=spawnCalls;report.failure={code:error.code||error.name,message:String(error.message).slice(0,500)};process.exitCode=1;}
finally{await fiber?.dispose();await running?.shutdown.shutdown(process.exitCode||0);await new Promise(r=>server.close(r));process.stdout.write=stdout;await writeFile(resolve(process.argv[2] || '.artifacts/studio-team-host.json'),JSON.stringify(report,null,2)+'\n');stdout(JSON.stringify(report)+'\n');}
