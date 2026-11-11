import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentStore} from '../src/agent-store.mjs';
import {createStudioTeams,validateTeam} from '../src/studio-teams.mjs';
const definition=id=>({name:'研究团队',leadAgentId:id,instructions:'协作验证',members:[{name:'reviewer',label:'审查',agentId:id,instructions:'独立审查并汇报'}]});
test('team composition rejects ambiguous names and unsupported member counts',()=>{
 assert.throws(()=>validateTeam({...definition('a'),members:[]}),{code:'TEAM_INVALID'});
 assert.throws(()=>validateTeam({...definition('a'),members:[{name:'lead',agentId:'a',instructions:'x'}]}),{code:'TEAM_INVALID'});
 assert.throws(()=>validateTeam({...definition('a'),members:[...definition('a').members,...definition('a').members]}),{code:'TEAM_INVALID'});
});
test('team roles preserve an explicit DSH agent preset for native spawn',()=>{
 const value=validateTeam({...definition('lead'),lead:{agentId:'lead',label:'主理人',instructions:'组织',agentPreset:'preset:lead'},members:[{name:'reviewer',label:'审查',agentId:'reviewer',instructions:'审查',agentPresetId:'preset:reviewer'}]});
 assert.equal(value.lead.agentPreset,'preset:lead');
 assert.equal(value.members[0].agentPreset,'preset:reviewer');
});
test('team editing uses optimistic revision and existing runtime Agents; snapshots stay outside ordinary list',async()=>{
 const root=await mkdtemp(join(tmpdir(),'studio-team-'));
 try{
  const agents=createAgentStore({storeDir:join(root,'agents')});const local=await agents.create({name:'专家',spec:{instructions:{system:'原始指令'},bindings:{knowledgeBases:['kb'],memoryInstances:['memory']}}});
  const codex=await agents.create({name:'Codex',runtimeType:'codex'});
  const ctx={get:()=>undefined,on:()=>{},effect:()=>{}};const api=createStudioTeams({ctx,directory:join(root,'teams'),agents,getAdmission:()=>({})});
  await assert.rejects(api.save(definition(codex.metadata.id)),{code:'TEAM_AGENT_UNSUPPORTED'});
  const team=await api.save(definition(local.metadata.id));assert.equal(team.revision,1);
  const updates=await Promise.allSettled([api.save({...team,name:'更新一'}),api.save({...team,name:'更新二'})]);assert.equal(updates.filter(x=>x.status==='fulfilled').length,1);assert.equal(updates.find(x=>x.status==='rejected').reason.code,'TEAM_REVISION_CONFLICT');
  const snapshot=await agents.create({name:'运行快照',spec:local.spec,teamRole:{runId:'test',sourceAgentId:local.metadata.id}});
  await agents.update(local.metadata.id,{spec:{instructions:{system:'新指令'}}});assert.equal((await agents.get(snapshot.metadata.id)).spec.instructions.system,'原始指令');assert.deepEqual((await agents.get(snapshot.metadata.id)).spec.bindings,local.spec.bindings);
  assert.equal((await agents.list()).length,2);assert.equal((await agents.list({includeTeamRoles:true})).length,3);
  const catalog=await api.list();assert.equal(catalog.agents.find(x=>x.metadata.id===codex.metadata.id).selectable,false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('team-only composition removes nested ordinary delegation without mutating the source',async()=>{
 const {teamBasePlugins}=await import('../src/studio-team-composition.mjs');
 const source=[{name:'group',group:true,config:[{name:'@deepseek-ai/dsh-tool-subagent'},{id:'tool-subagent-fork',name:'fork'},{name:'@deepseek-ai/dsh-tool-subagent-control/list-agents'},{name:'@deepseek-ai/dsh-persona'}]},{name:'@deepseek-ai/dsh-tool-bash'}];
 assert.deepEqual(teamBasePlugins(source)[0].config,[{name:'@deepseek-ai/dsh-persona'}]);assert.equal(source[0].config.length,4);
});

test('team tool adapters constrain member selection and reuse an existing official roster member',async()=>{
 const {installStudioTeamTools}=await import('../src/studio-team-tools.mjs');const definitions=new Map();let spawned=0;
 const agent={ctx:{tools:{register:tool=>definitions.set(tool.name,tool)},systemPrompt:{section:()=>{}}}};
 const teams={listMembers:()=>[{name:'reviewer',status:'inactive'}],spawnTeammate:()=>{spawned++;}};
 installStudioTeamTools(agent,{teams,run:{roles:[{name:'reviewer',label:'审查',instructions:'审查'}]}});
 const spawn=definitions.get('spawn_teammate');
 await assert.rejects(spawn.execute({name:'unknown',prompt:'x'},{agent,signal:new AbortController().signal}),/成员未在团队配置/);
 assert.equal(JSON.parse((await spawn.execute({name:'reviewer',prompt:'x'},{agent})).result).reused,true);assert.equal(spawned,0);
 assert.deepEqual(spawn.parameters.required,['name','prompt']);
});

test('team runtime waits for Loader and reuses an official profile service',async()=>{
 const {ensureStudioTeamRuntime}=await import('../src/studio-team-runtime.mjs');let loaded=0,plugins=0;const services=new Map();let settle;const loader=new Promise(resolve=>{settle=resolve;});
 const ctx={root:{loader:{await:()=>loader}},effect:()=>{},get:name=>services.get(name),plugin:()=>{plugins++;}};
 const ready=ensureStudioTeamRuntime(ctx,{load:async()=>{loaded++;return {default:{}};}});services.set('agentTeams',{});settle();await ready;
 assert.equal(loaded,0);assert.equal(plugins,0);
});
test('fresh profiles mount one official service and official tools are not registered twice',async()=>{
 const {ensureStudioTeamRuntime}=await import('../src/studio-team-runtime.mjs');const {installStudioTeamTools}=await import('../src/studio-team-tools.mjs');let service,plugins=0,tools=0;
 const ctx={root:{loader:{await:async()=>{}}},effect:()=>{},get:()=>service,plugin:async()=>{plugins++;service={};}};
 await ensureStudioTeamRuntime(ctx,{load:async()=>({default:{}})});assert.equal(plugins,1);
 installStudioTeamTools({ctx:{tools:{register:()=>tools++},systemPrompt:{section:()=>{}}}},{teams:{},run:{},useOfficialTools:true});assert.equal(tools,0);
});

test('a declared official Teams entry owns the service while it activates',async()=>{
 const {ensureStudioTeamRuntime}=await import('../src/studio-team-runtime.mjs');
 let loaded=0,mounted=0;const services=new Map();
 const entries=()=>[{options:{id:'agent-team',name:'@deepseek-ai/dsh-experimental-agent-team'}}];
 const ctx={root:{loader:{await:async()=>{},entries}},effect:()=>{},get:name=>services.get(name),plugin:async()=>{mounted++;}};
 const ready=ensureStudioTeamRuntime(ctx,{load:async()=>{loaded++;return {default:{}};},waitMs:2000});
 setTimeout(()=>services.set('agentTeams',{}),50);
 await ready;
 assert.equal(loaded,0);assert.equal(mounted,0);
});
test('a declared entry that never activates still gets a Studio fallback',async()=>{
 const {ensureStudioTeamRuntime}=await import('../src/studio-team-runtime.mjs');
 let loaded=0,mounted=0;const services=new Map();
 const entries=()=>[{options:{id:'agent-team',name:'@deepseek-ai/dsh-experimental-agent-team'}}];
 const ctx={root:{loader:{await:async()=>{},entries}},effect:()=>{},get:name=>services.get(name),plugin:async()=>{mounted++;services.set('agentTeams',{});}};
 await ensureStudioTeamRuntime(ctx,{load:async()=>{loaded++;return {default:{}};},waitMs:30});
 assert.equal(loaded,1);assert.equal(mounted,1);
});

test('starts one DSH native TeamRun without creating ordinary role snapshots', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'studio-native-team-'));
  try {
    const sourceAgents = createAgentStore({ storeDir: join(rootDir, 'agents') });
    const lead = await sourceAgents.create({ name: '主理专家', spec: { runtime: { type: 'dsh-native' }, instructions: { system: 'lead' }, bindings: {} } });
    const member = await sourceAgents.create({ name: '审查专家', spec: { runtime: { type: 'dsh-native' }, instructions: { system: 'reviewer' }, bindings: {} } });
    const roots = new Map();
    const rosters = new Map();
    const spawned = [];
    const prompted = [];
    const admitted = [];
    const createdListeners = [];
    const preSteps = new Map();
    const readinessDecisions = [];
    const renamed = [];
    function fakeAgent(id, parentSession) {
      return {
        id, status: 'inactive', session: { header: { id, parentSession } }, cancel: () => {},
        ctx: {
          on: (event, listener) => { if (event === 'agent/pre-step') preSteps.set(id, listener); },
          systemPrompt: { section: () => () => {} },
          tools: { register: () => () => {} },
        },
      };
    }
    const presets = { composedPreset: () => null, recompose: async () => {} };
    const controller = {
      async create({ sessionId }) {
        const agent = fakeAgent(sessionId);
        roots.set(sessionId, agent);
        rosters.set(sessionId, []);
        for (const listener of createdListeners) await listener({ agent });
      },
      async rename(request) { renamed.push(request); },
      async resolveAgent(sessionId) { return { agent: roots.get(sessionId) }; },
      async selectModel() {},
      async prompt(payload) { prompted.push(payload); },
      async projections() { return { asOfSeq: 1, values: { agentTeam: { members: [{ id: 'native-reviewer', name: 'reviewer', role: 'teammate', phase: 'active' }], tasks: [{ id: 'task-1', status: 'in_progress' }] } } }; },
    };
    const nativeTeams = {
      listMembers(root) {
        return [
          { id: root.id, name: 'lead', role: 'lead', status: root.status, diagnostics: [] },
          ...(rosters.get(root.id) || []),
        ];
      },
      async spawnTeammate(root, request) {
        const memberRow = { id: `native-${request.name}`, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [], description: request.description };
        rosters.get(root.id).push(memberRow);
        spawned.push({ root: root.id, request });
        for (const listener of createdListeners) await listener({ agent: fakeAgent(memberRow.id, root.id) });
        const source = { kind: 'subagent-settled', senderSessionId: memberRow.id };
        const readiness = { id: 'ready', source };
        const later = { id: 'real-result', source };
        const prepare = preSteps.get(root.id);
        for (const message of [readiness, later]) {
          readinessDecisions.push(await prepare({ messages: [message], step: 1 }, async () => ({ kind: 'enter', messages: [message] })));
        }
        return { member: memberRow };
      },
      listTasks() { return []; },
      interrupt() {},
    };
    const ctx = {
      get(name) {
        if (name === 'agentTeams') return nativeTeams;
        if (name === 'sessionController') return controller;
        if (name === 'agentPresets') return presets;
        if (name === 'commands') return { execute: async () => {} };
        if (name === 'agents') return { get: id => roots.get(id) };
        return undefined;
      },
      on(event, listener) { if (event === 'agent/created') createdListeners.push(listener); },
    };
    const api = createStudioTeams({
      ctx,
      directory: join(rootDir, 'teams'),
      agents: {
        get: id => sourceAgents.get(id),
        list: options => sourceAgents.list(options),
        create: () => { throw new Error('ordinary Agent snapshot creation is forbidden'); },
      },
      getAdmission: () => ({ ensure: async (id, options) => {
        admitted.push({ id, agent: options.agent });
        return { presetId: `preset:${id}` };
      } }),
    });
    const team = await api.save({
      name: '原生审查团',
      instructions: '完成任务后汇总',
      leadAgentId: lead.metadata.id,
      members: [{ name: 'reviewer', label: '审查', agentId: member.metadata.id, instructions: '审查并回报' }],
    });
    const result = await api.start({
      id: team.id,
      revision: team.revision,
      task: '检查当前变更',
      requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].request.name, 'reviewer');
    assert.match(spawned[0].request.agentPreset, /^preset:team-role-/);
    assert.deepEqual(spawned[0].request.allowedMemberNames, ['reviewer']);
    assert.equal(prompted.length, 1);
    assert.equal(prompted[0].content[0].text, '检查当前变更');
    assert.deepEqual(renamed, [{ sessionId: result.id, title: team.name }]);
    assert.deepEqual(readinessDecisions[0], { kind: 'enter', messages: [] });
    assert.equal(readinessDecisions[1].messages[0].id, 'real-result');
    assert.equal(result.dshRootSessionId, result.sessionId);
    assert.equal(result.members.some(row => row.name === 'reviewer'), true);
    assert.equal(result.tasks[0].id, 'task-1');
    assert.equal(result.roles[1].nativeMemberId, 'native-reviewer');
    assert.equal(result.roles[1].childSessionId, 'native-reviewer');
    const restarted = createStudioTeams({
      ctx,
      directory: join(rootDir, 'teams'),
      agents: {
        get: id => sourceAgents.get(id),
        list: options => sourceAgents.list(options),
        create: () => { throw new Error('ordinary Agent snapshot creation is forbidden'); },
      },
      getAdmission: () => ({ ensure: async () => ({ presetId: 'preset:restarted' }) }),
    });
    const replay = await restarted.start({ id: team.id, revision: team.revision, task: '检查当前变更', requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    assert.equal(replay.id, result.id);
    assert.equal((await sourceAgents.list()).length, 2);
    assert.equal((await api.history({ id: team.id })).items.length, 1);
    const admittedBeforeEdit = admitted.findLast(row => row.agent.metadata.name.endsWith('审查')).agent.spec.instructions.system;
    await sourceAgents.update(member.metadata.id, { spec: { runtime: { type: 'dsh-native' }, instructions: { system: '已更新来源' }, bindings: {} } });
    await api.resume({ runId: result.id });
    assert.equal(admitted.findLast(row => row.agent.metadata.name.endsWith('审查')).agent.spec.instructions.system, admittedBeforeEdit);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('starts a catalog Team template as one DSH Team without AgentStore rows', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'studio-native-team-template-'));
  try {
    const sourceAgents = createAgentStore({ storeDir: join(rootDir, 'agents') });
    const roots = new Map();
    const rosters = new Map();
    const spawned = [];
    const presets = { composedPreset: () => null, recompose: async () => {} };
    const controller = {
      async create({ sessionId }) {
        const agent = { id: sessionId, status: 'inactive', session: { header: { id: sessionId } }, ctx: { on: () => {} }, cancel: () => {} };
        roots.set(sessionId, agent);
        rosters.set(sessionId, []);
      },
      async resolveAgent(sessionId) { return { agent: roots.get(sessionId) }; },
      async selectModel() {},
      async prompt() {},
    };
    const nativeTeams = {
      listMembers(root) {
        return [{ id: root.id, name: 'lead', role: 'lead', status: root.status, diagnostics: [] }, ...(rosters.get(root.id) || [])];
      },
      async spawnTeammate(root, request) {
        const member = { id: `native-${request.name}`, name: request.name, role: 'teammate', status: 'inactive', diagnostics: [], description: request.description };
        rosters.get(root.id).push(member);
        spawned.push({ root: root.id, request });
        return { member };
      },
      listTasks() { return []; },
      interrupt() {},
    };
    const ctx = {
      get(name) {
        if (name === 'agentTeams') return nativeTeams;
        if (name === 'sessionController') return controller;
        if (name === 'agentPresets') return presets;
        if (name === 'commands') return { execute: async () => {} };
        if (name === 'agents') return { get: id => roots.get(id) };
        return undefined;
      },
      on() {},
    };
    const api = createStudioTeams({
      ctx,
      directory: join(rootDir, 'teams'),
      agents: {
        get: id => sourceAgents.get(id),
        list: options => sourceAgents.list(options),
        create: () => { throw new Error('catalog Team must never create an ordinary Agent'); },
      },
      getAdmission: () => ({ ensure: async id => ({ presetId: `preset:${id}` }) }),
    });
    const roleSpec = label => ({
      runtime: { type: 'dsh-native' },
      instructions: { system: `${label} blueprint` },
      bindings: {},
    });
    const team = await api.save({
      name: '模板原生团队',
      description: '一个 DSH Team 定义',
      instructions: '由 Lead 组织并汇总',
      lead: {
        name: 'lead',
        label: '主理人',
        instructions: '组织与汇总',
        source: { kind: 'template', id: 'lead-template', version: '1.0.0', digest: 'sha256:lead' },
        spec: roleSpec('lead'),
      },
      members: [{
        name: 'reviewer',
        label: '审查员',
        instructions: '审查并向 Lead 汇报',
        source: { kind: 'template', id: 'reviewer-template', version: '1.0.0', digest: 'sha256:reviewer' },
        spec: roleSpec('reviewer'),
      }],
    });
    assert.equal(team.runtime, 'dsh-native-team');
    assert.equal(team.lead.source.kind, 'template');
    assert.equal(Object.hasOwn(team.lead, 'agentId'), false);
    assert.equal((await api.list()).agents.length, 0);

    const result = await api.start({
      id: team.id,
      revision: team.revision,
      task: '用模板角色完成一次协作任务',
      requestId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].request.name, 'reviewer');
    assert.match(spawned[0].request.agentPreset, /^preset:team-role-/);
    assert.deepEqual(spawned[0].request.allowedMemberNames, ['reviewer']);
    assert.equal(result.members.filter(member => member.role === 'teammate').length, 1);
    assert.equal(result.roles.some(role => Object.hasOwn(role, 'agentId')), false);
    const persistedRun = JSON.parse(await readFile(join(rootDir, 'teams', 'runs', `${result.id}.json`), 'utf8'));
    assert.equal(persistedRun.roles.some(role => Object.hasOwn(role, 'agentId')), false);
    assert.equal((await sourceAgents.list()).length, 0);
    assert.equal((await api.list()).agents.length, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
