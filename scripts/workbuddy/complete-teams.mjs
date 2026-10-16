/** Private migration: team relationships point to ordinary, complete Agent templates. */
import { readFile, writeFile, readdir, cp, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { inventory } from './curate.mjs';
import { pathToFileURL } from 'node:url';
import { applySkillArtwork } from './skill-artwork.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path,'utf8'));
const localized = value => typeof value==='string'?value:value?.zh||value?.en||'';
const adapter = `\n\n## Studio Agent Teams 运行适配（优先于上文平台调用示例）\n原始角色、专业流程、交付要求完整保留。源平台 TeamCreate/TeamDelete 不需要调用：本会话已由 Studio 创建官方 Agent Teams。只使用实际列出的 spawn_teammate、send_message、list_agents、wait_agent 和 team_task_* 工具；成员标识由本次团队职责指定，不能启动未配置角色。不要使用普通 subagent 或模拟多角色发言代替真实成员。Read/Write/Edit/Bash、WebSearch/WebFetch、Skill 等名称映射为当前会话实际公布的工具。通过已绑定 Skill 索引读取完整技能，相对文件在技能目录内。未连接的账号或外部 API 需要用户自己的授权，不编造工具结果。知识库、记忆库使用本 Agent 绑定，长期记忆只在明确要求时写入。`;
export async function completeTeams({input,directory}) {
  const source=await json(join(directory,'catalog.json')),report={teams:[],excluded:[],artwork:0,skillArtwork:0};
  const downloaded=await json(join(input,'downloads.json'));
  for(const file of (await readdir(join(input,'converted'))).filter(x=>x.endsWith('.json'))) {
    const converted=await json(join(input,'converted',file));if(converted.kind!=='team')continue;
    const root=join(input,'packages',converted.plugin),manifest=await json(join(root,'.codebuddy-plugin/plugin.json'));
    const names=[converted.team.leadAgent,...converted.team.memberAgents||[]];
    const reasons=[];
    if(names.length<2||names.length>9)reasons.push('当前支持 1 位主理人与最多 8 位成员，完整保留更大团队待适配');
    if(names.some(name=>!converted.agents.some(agent=>agent.name===name)))reasons.push('角色定义缺失');
    if(converted.dependencies.connectors.length||converted.dependencies.mcpFiles.length||Object.keys(converted.dependencies.mcpServers).length)reasons.push('声明的连接器需要独立授权适配');
    if(/Proprietary|UNLICENSED|Evaluation/i.test(manifest.license||''))reasons.push('源包使用限制');
    const texts=converted.agents.map(a=>a.spec.instructions.system).join('\n');
    if(/auth-proxy\.local|\.it\.woa\.com|\.oa\.com|~\/\.workbuddy|~\/\.codebuddy/.test(texts))reasons.push('仍依赖源平台内部环境');
    if(reasons.length){report.excluded.push({plugin:converted.plugin,reasons});continue;}
    let files;try{files=await inventory(root);}catch(error){report.excluded.push({plugin:converted.plugin,reasons:[error.message]});continue;}const digest=hash(JSON.stringify(files));
    if(converted.agents.some(a=>files.find(f=>f.path===a.path)?.sha256!==a.sourceSha256))throw new Error('Agent source changed');
    const receipt=downloaded.bundles.find(x=>x.plugin===converted.plugin&&x.status==='downloaded');
    if(!receipt||hash(await readFile(join(input,'raw',converted.plugin+'.tar.gz')))!==receipt.sha256)throw new Error('Team archive changed');
    const bundle={path:`packages/${digest}`,digest,files};source.packages[digest]||=bundle;
    await mkdir(join(directory,'packages'),{recursive:true});await cp(root,join(directory,bundle.path),{recursive:true,force:false,mode:2});
    const skillRows=source.resources.filter(row=>row.kind==='skill'&&row.sourcePackage===`packages/${converted.plugin}`);
    const declared=(manifest.skills||[]).map(x=>String(x).replace(/^\.\//,'').replace(/\/SKILL\.md$/,''));
    const skills=skillRows.map(x=>x.dependencies.skills[0]);
    if(declared.some(path=>!skills.some(skill=>skill.path===path))) {report.excluded.push({plugin:converted.plugin,reasons:['声明的 Skill 未完整整理']});continue;}
    const dependencies={package:{path:bundle.path,digest},skills,mcp:[]};
    const image=String(manifest.avatar||files.find(f=>/(?:^|\/)avatars\/.*\.(png|jpe?g|webp)$/i.test(f.path))?.path||'').replace(/^\.\//,'');
    const artwork=files.find(f=>f.path===image&&f.size<=4*1024*1024&&/\.(png|jpe?g|webp)$/i.test(f.path));
    const teamId=`team-template-${converted.plugin}`,roles=[];
    for(let i=0;i<names.length;i++) {
      const agent=converted.agents.find(a=>a.name===names[i]),member=(manifest.members||[]).find(x=>x.id===agent.name)||{};
      const label=localized(member.profession)||localized(agent.sourceFrontmatter.profession)||localized(member.name)||agent.name;
      const roleName=i===0?'lead':`member-${i}`;
      const role={id:`${teamId}-role-${i}`,kind:'agent',teamRoleOnly:true,version:manifest.version||'1.0.0',name:`${localized(manifest.displayName)||manifest.name} · ${label}`,description:localized(agent.sourceFrontmatter.description)||label,
        categoryId:source.categories[0].id,tags:[],examples:[],deliverable:'按完整角色指令交付',author:localized(manifest.author?.name)||'源包作者',origin:{type:'imported',sourceId:converted.id,sourceSha256:receipt.sha256,license:manifest.license||'unconfirmed'},runtimes:['dsh-native','harness'],requirements:skills.length?[{kind:'skill',required:true,count:skills.length,label:'完整配套技能'}]:[],spec:structuredClone(agent.spec),dependencies,
        validation:{state:'compatibility-checked',verifiedRuntimes:[],notes:'私有目录结构与依赖完整性核对，业务能力未逐项验收。'},migration:{originalSystemSha256:hash(agent.spec.instructions.system),agentFile:agent.path}};
      role.spec.instructions.system+=adapter;
      if(skills.length)role.spec.instructions.system+=`\n配套 Skill 工具名称：${skills.map(x=>`${x.path} → ${x.runtimeName}`).join('；')}`;
      source.items.push(role);roles.push({name:roleName,label,instructions:`履行${label}职责，依据用户任务独立完成并通过 send_message 向主理人汇报。`,template:{id:role.id}});
    }
    const team={id:teamId,kind:'team',name:localized(manifest.displayName)||manifest.name,description:localized(manifest.displayDescription)||manifest.description||'',version:manifest.version||'1.0.0',roles,instructions:'按模板中各角色的完整专业流程协作。分解用户任务，分派给预配成员，收齐报告后审查、汇总并交付。',tags:(manifest.tags||[]).map(localized).filter(Boolean),examples:(manifest.quickPrompts||[]).map(localized).filter(Boolean),dependencies:{package:{path:bundle.path,digest},skills:[],mcp:[]},origin:{type:'imported',sourceSha256:receipt.sha256,license:manifest.license||'unconfirmed'},validation:{state:'compatibility-checked',verifiedRuntimes:[]}};
    if(artwork){team.artwork={path:image,sha256:artwork.sha256};report.artwork++;}
    source.resources.push(team);report.teams.push({id:team.id,name:team.name,roles:roles.length,skills:skills.length});
  }
  const skillArtwork=await applySkillArtwork({catalog:source,packageRoot:directory,output:join(directory,'artwork')});
  report.skillArtwork=skillArtwork.report.originalLogos;report.skillFunctionalIcons=skillArtwork.report.functionalIcons;
  await writeFile(join(directory,'catalog.json'),JSON.stringify(source),{mode:0o600});await writeFile(join(directory,'team-migration-report.json'),JSON.stringify(report,null,2),{mode:0o600});return {teams:report.teams.length,excluded:report.excluded.length,teamArtwork:report.artwork,skillArtwork:report.skillArtwork};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const [input,directory]=process.argv.slice(2);console.log(JSON.stringify(await completeTeams({input:resolve(input),directory:resolve(directory)})));}
