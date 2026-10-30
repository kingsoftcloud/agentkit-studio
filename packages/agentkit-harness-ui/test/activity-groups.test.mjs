import test from 'node:test';
import assert from 'node:assert/strict';
import { activityGroups, activityGroupSummary } from '../src/activity-groups.mjs';
import { initialState, reduce } from '../src/reducer.mjs';
import { buildViewModel } from '../src/view.mjs';
import { findByTestId, findAllByTestId, textOf } from './helpers.mjs';

const tool = (callId, name, status='completed') => ({kind:'tool',id:callId,callId,name,status,
  input:name==='run_command'?{command:'npm test'}:{}});

test('contiguous exploration and terminal stages have exact separate counts and stable growth identities', () => {
  const calls=[tool('a','web_fetch'),tool('b','web_search'),tool('c','web_fetch')];
  const two=activityGroups(calls.slice(0,2))[0], three=activityGroups(calls)[0];
  assert.equal(two.id,three.id);
  assert.equal(activityGroupSummary(three,'zh-CN').detail,'2 次网页抓取, 1 搜索');
  assert.deepEqual(three.children.map(item=>item.callId),['a','b','c']);
  const terminal=activityGroups([tool('one','run_command'),tool('two','run_command'),tool('three','run_command')])[0];
  assert.deepEqual(activityGroupSummary(terminal,'zh-CN'),{title:'终端',detail:'3 个命令'});
});

test('narrative, reasoning, context compaction and child tasks remain stage boundaries', () => {
  for(const boundary of [{kind:'text',text:'Actual narrative'},{kind:'thought',text:'Actual thought'},
    {kind:'context-marker'}, {...tool('child','native_start_child'),child:{runId:'child'}}]) {
    const items=[tool('a','web_fetch'),boundary,tool('b','web_search')];
    assert.deepEqual(activityGroups(items),items);
  }
  assert.equal(activityGroups([tool('a','web_fetch')])[0].kind,'tool');
});

test('running, failed and uncertain calls are counted truthfully without changing their evidence', () => {
  const calls=[tool('a','run_command','failed'),tool('b','run_command','uncertain'),tool('c','run_command','running')];
  calls[0].error='original failure';const before=structuredClone(calls);
  const group=activityGroups(calls,{stageTailIsRunning:true})[0];
  assert.equal(group.active,true);assert.equal(group.failed,1);assert.equal(group.uncertain,1);
  assert.match(activityGroupSummary(group,'zh-CN').detail,/1 失败, 1 待核对/);
  assert.deepEqual(calls,before);
});

test('stage status follows visible segment boundaries, independently of child execution status', () => {
  const completed = [tool('a','web_fetch'),tool('b','web_search')];
  assert.equal(activityGroups(completed,{stageTailIsRunning:true})[0].active,true,'model request gap keeps the exploration stage active');
  for (const boundary of [{kind:'text',text:'Next stage'},{kind:'thought',text:'Visible reasoning'},
    {kind:'context-marker'},tool('c','run_command')]) {
    const group=activityGroups([...completed,boundary],{stageTailIsRunning:true})[0];
    assert.equal(group.active,false,'later visible work closes the previous stage');
  }
  const running = [tool('a','run_command','running'),tool('b','run_command')];
  assert.equal(activityGroups(running)[0].active,false,'a terminal segment cannot be reopened by a stale child status');
  assert.equal(activityGroups([...running,{kind:'text',text:'Next stage'}],{stageTailIsRunning:true})[0].active,false);
  assert.equal(running[0].status,'running','presentation does not rewrite execution evidence');
});

test('the view gives only its true running tail the stage indicator, and replayed terminal history stays inactive', () => {
  let state=initialState();
  state=reduce(state,{v:1,id:'running',type:'task.started'});
  for (let i=0;i<2;i++) {
    state=reduce(state,{v:1,id:`s${i}`,type:'tool.scheduled',callId:String(i),name:'run_command',input:{command:'pwd'}});
    state=reduce(state,{v:1,id:`r${i}`,type:'tool.result',callId:String(i),result:'observed'});
  }
  assert.equal(findByTestId(buildViewModel(state),'activity-group').props['data-streaming'],'true');
  state=reduce(state,{v:1,id:'body',type:'text.delta',text:'Actual answer',itemId:'answer'});
  assert.equal(findByTestId(buildViewModel(state),'activity-group').props['data-streaming'],'false');
  state=reduce(state,{v:1,id:'body-done',type:'text.done',text:'Actual answer',itemId:'answer'});
  const terminal=reduce(state,{v:1,id:'finished',type:'task.finished',outcome:'completed',finalAnswerId:'answer'});
  const history=findByTestId(buildViewModel(terminal),'work-history');
  assert.ok(history);
  const replayed=findByTestId(buildViewModel(terminal,{historyOpen:new Map([[history.props['data-item-id'],true]])}),'activity-group');
  assert.ok(replayed);assert.equal(replayed.props['data-streaming'],'false');
});

test('grouped UI is compact by default and inspection preserves every original child call', () => {
  let state=initialState();
  for (let i=0;i<2;i++) {
    state=reduce(state,{v:1,id:`s${i}`,type:'tool.scheduled',callId:String(i),name:'run_command',input:{command:`echo ${i}`}});
    state=reduce(state,{v:1,id:`r${i}`,type:'tool.result',callId:String(i),result:'observed'});
  }
  const group=findByTestId(buildViewModel(state,{locale:'zh-CN'}),'activity-group');
  assert.equal(findByTestId(group,'activity-details').props.open,false);
  assert.match(textOf(group),/终端·2 个命令/);
  const id=group.props['data-item-id'];
  const expanded=buildViewModel(state,{locale:'zh-CN',toolOpen:new Map([[id,true]])});
  assert.equal(findByTestId(expanded,'activity-details').props.open,true);
  assert.equal(state.items.length,2);
});

test('an input boundary leaves the earlier stage inactive while the new stage runs, including cold replay', () => {
  const events=[{type:'task.started'},
    ...['a','b'].flatMap(callId=>[{type:'tool.scheduled',callId,name:'web_fetch',input:{}},
      {type:'tool.result',callId,result:'observed'}]),
    {type:'text.done',itemId:'steer',role:'user',text:'Continue with the next source'},
    ...['c','d'].flatMap(callId=>[{type:'tool.scheduled',callId,name:'run_command',input:{command:'pwd'}},
      {type:'tool.result',callId,result:'observed'}])];
  const replay=()=>events.reduce((state,event,index)=>reduce(state,{v:1,id:`stage-${index}`,...event}),initialState());
  const tree=buildViewModel(replay());
  assert.deepEqual(findAllByTestId(tree,'activity-group').map(group=>group.props['data-streaming']),['false','true']);
  assert.deepEqual(buildViewModel(replay()),tree);
});

test('readonly Shell shares Explore with file and web calls, while execution remains a separate stage', () => {
  const command=(id,command)=>({...tool(id,'run_command'),input:{command}});
  const calls=[tool('file','read_workspace_file'),command('grep','rg TODO src'),
    command('list','ls -la src'),tool('web','web_fetch'),command('test','npm test'),command('build','npm run build')];
  const before=structuredClone(calls),groups=activityGroups(calls);
  assert.equal(groups.length,2);assert.equal(groups[0].family,'explore');assert.equal(groups[1].family,'terminal');
  assert.equal(activityGroupSummary(groups[0],'zh-CN').detail,'1 次网页抓取, 1 搜索, 1 列表, 1 文件');
  assert.equal(activityGroupSummary(groups[0],'en-US').detail,'1 fetch, 1 search, 1 list, 1 file');
  assert.deepEqual(calls,before,'display classification cannot change execution facts');
  const tree=buildViewModel({ ...initialState(),items:calls },{locale:'zh-CN',toolOpen:new Map([[groups[0].id,true]])});
  const exploreGroup=findAllByTestId(tree,'activity-group')[0];
  assert.equal(findAllByTestId(exploreGroup,'tool-block').length,4,'expanded Explore retains the original terminal and read renderers');
});

test('unclassified live Shell inputs are transparent until the command supplies a visible stage', () => {
  const prefix=[tool('a','read_workspace_file'),tool('b','web_search')];
  for(const draft of [{...tool('c','run_command','scheduled'),input:{}},
    {kind:'tool-preview',id:'preview',name:'run_command',input:{},streaming:true}]) {
    const group=activityGroups([...prefix,draft],{stageTailIsRunning:true})[0];
    assert.equal(group.id,activityGroups(prefix)[0].id);assert.equal(group.active,true);
    const read={...tool('c','run_command','running'),input:{command:'cat README.md'}};
    const extended=activityGroups([...prefix,read],{stageTailIsRunning:true})[0];
    assert.equal(extended.id,group.id);assert.equal(extended.children.length,3);
    const execute={...read,input:{command:'npm test'}};
    assert.equal(activityGroups([...prefix,execute],{stageTailIsRunning:true})[0].active,false);
  }
  const failed={...tool('c','run_command','failed'),input:{},error:'original failure'};
  assert.equal(activityGroups([failed])[0],failed,'a failed malformed call must remain inspectable');
});

test('file changes remain individual rows by default, matching the pinned desktop setting', () => {
  const calls=[tool('a','write_workspace_file'),tool('b','edit_workspace_file')];
  assert.deepEqual(activityGroups(calls),calls);
  assert.equal(activityGroups(calls,{enableChangesGrouping:true})[0].family,'changes');
});

test('recognized argument streams join the same work stage without acquiring call authority or a result', () => {
  for (const [name,input,family] of [['run_command',{command:'cat README.md'},'explore'],
    ['web_fetch',{url:'https://example.invalid'},'explore'],['run_command',{command:'npm test'},'terminal']]) {
    const first={...tool('first',name,'completed'),input};
    const draft={kind:'tool-preview',id:'draft',name,input,streaming:true,receivedChars:20};
    const before=structuredClone(draft);
    const live=activityGroups([first,draft],{stageTailIsRunning:true});
    assert.equal(live.length,1);assert.equal(live[0].family,family);assert.equal(live[0].active,true);
    assert.equal(live[0].children.length,2);assert.equal(live[0].children[1],draft);
    assert.equal(live[0].failed,0);assert.equal(live[0].uncertain,0);
    assert.deepEqual(draft,before);assert.equal(draft.status,undefined);assert.equal(draft.callId,undefined);
    const settled=activityGroups([first,{...tool('second',name,'scheduled'),input}],{stageTailIsRunning:true});
    assert.equal(live[0].id,settled[0].id);
    assert.deepEqual(live[0].counts,settled[0].counts);
    const value={...initialState(),taskState:'running',items:[first,draft]};
    const rendered=buildViewModel(value,{locale:'zh-CN',toolOpen:new Map([[live[0].id,true]])});
    const rows=findAllByTestId(rendered,'tool-block');
    assert.equal(rows.length,2);assert.equal(rows[1].props['data-uncommitted'],'true');
    assert.equal(rows[1].props['data-status'],undefined);assert.equal(rows[1].props['data-call-id'],undefined);
  }
  const drafts=['one','two'].map(id=>({kind:'tool-preview',id,name:'web_fetch',input:{},streaming:true}));
  assert.equal(activityGroups(drafts)[0].id,'activity:explore:one');
  assert.equal(activityGroups(drafts.map(item=>({...item,id:'other:'+item.id})))[0].id,'activity:explore:other:one');
});
