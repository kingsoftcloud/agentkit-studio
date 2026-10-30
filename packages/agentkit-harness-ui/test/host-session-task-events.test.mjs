import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTaskProjector, nativeTaskState, nativeHistoricalToolState } from '../src/host/session-task-events.mjs';

const entry = (seq, type, data) => ({ type: 'event', event: { seq, type, time: 1000 + seq, data: { turn: 1, step: 1, ...data } } });
const window = (revision, entries, change = { kind: 'replace', entries }) => ({ revision, entries, change });

test('actual Session response boundaries own stream, committed content and tools across append and replay', () => {
  const projector = createSessionTaskProjector({ sessionId: 'session' });
  const start = entry(0, 'turn/start', {});
  const chunks = [entry(1, 'assistant/live-chunk', { attemptId: 'attempt', chunk: { type: 'reasoning-delta', index: 0, text: 'Reason' } }),
    entry(2, 'assistant/live-chunk', { attemptId: 'attempt', chunk: { type: 'text-delta', index: 1, text: 'Inspect' } }),
    entry(3, 'assistant/live-chunk', { attemptId: 'attempt', chunk: { type: 'tool-call-delta', index: 2,
      name: 'browser_inspect_workspace', argumentsDelta: '{"entry":"index.html"}' } })];
  const streamed = projector.project(window(1, [start, ...chunks]))[0].state;
  assert.equal(streamed.items.length, 3);
  assert.deepEqual(new Set(streamed.items.map(item => item.responseId)), new Set(['["session",1,1]']));
  const message = entry(4, 'assistant/message', { message: { id: 'durable-message', content: [
    { type: 'reasoning', text: 'Reason' }, { type: 'text', text: 'Inspect' },
    { type: 'tool-call', id: 'browser', name: 'browser_inspect_workspace', arguments: '{}' }] } });
  const call = entry(5, 'tool/call', { callId: 'browser', name: 'browser_inspect_workspace', arguments: '{}' });
  const settled = [start, ...chunks, message, call];
  const committed = projector.project(window(2, settled, { kind: 'append', entries: [message, call] }))[0].state;
  assert.equal(committed.items.some(item => item.kind === 'tool-preview'), false);
  assert.deepEqual(committed.items.map(item => item.responseId), ['["session",1,1]', '["session",1,1]', '["session",1,1]']);
  assert.equal(committed.items[0].sourceMessageId, 'durable-message');
  const later = entry(6, 'assistant/live-chunk', { step: 2, chunk: { type: 'text-delta', index: 0, text: 'Next' } });
  const appended = projector.project(window(3, [...settled, later], { kind: 'append', entries: [later] }));
  assert.equal(appended[0].state.items.at(-1).responseId, '["session",1,2]');
  assert.deepEqual(createSessionTaskProjector({ sessionId: 'session' }).project(window(4, [...settled, later])), appended);
  const missing = structuredClone(call); delete missing.event.data.step;
  assert.equal(createSessionTaskProjector({ sessionId: 'session' }).project(window(1, [missing]))[0].state.items[0].responseId, undefined);
  assert.equal(createSessionTaskProjector().project(window(1, [call]))[0].state.items[0].responseId, undefined);
});

test('command previews enrich only an unsettled matching call and cannot replace final command output', () => {
  const state = createSessionTaskProjector().project(window(1, [entry(1, 'tool/call', {
    callId: 'command', name: 'run_command', arguments: '{"command":"controlled"}' })]))[0].state;
  const status = { runId: 'run', sessionId: 's', phase: 'executing_tools', commandPreviews: {
    contract: 'agentkit.native-command-previews/v1', runId: 'run', sessionId: 's', calls: [
      { callId: 'command', sequence: 1, display: { kind: 'command_preview', stdout: 'first line\n', stderr: '' } }] } };
  const view = nativeTaskState(state, status, true);
  assert.equal(view.items[0].status, 'running'); assert.equal(view.items[0].display.stdout, 'first line\n');
  assert.equal(state.items[0].display, undefined);
  const bounded = { ...status, commandPreviews: { ...status.commandPreviews,
    calls: [{ ...status.commandPreviews.calls[0], truncated: true,
      display: { ...status.commandPreviews.calls[0].display, exitCode: 0 } }] } };
  const boundedView = nativeTaskState(state, bounded, true).items[0];
  assert.equal(boundedView.progress, '运行中的输出预览已截断');
  assert.equal(boundedView.display.exitCode, undefined);
  for (const changed of [{ ...status, phase: 'completed' },
    { ...status, commandPreviews: { ...status.commandPreviews, runId: 'foreign' } },
    { ...status, commandPreviews: { ...status.commandPreviews, sessionId: 'foreign' } },
    { ...status, commandPreviews: { ...status.commandPreviews, calls: [{ ...status.commandPreviews.calls[0],
      display: { ...status.commandPreviews.calls[0].display, exit: 0 } }] } }])
    assert.equal(nativeTaskState(state, changed, true).items[0].display, undefined);
  const done = { ...state, items: [{ ...state.items[0], status: 'completed',
    display: { kind: 'command_output', stdout: 'final', stderr: '', exit: 0 } }] };
  assert.equal(nativeTaskState(done, status, true).items[0].display.stdout, 'final');
});

test('typed Native uncertainty survives an error ending and scoped facts repair old presentation only', () => {
  const fact = { contract: 'agentkit.native-tool-outcome/v1', sessionId: 'session', runId: 'run', turn: 1,
    callId: 'read', status: 'uncertain' };
  const rows = [entry(1, 'tool/call', { callId: 'read', name: 'read_workspace_file', arguments: '{}' }),
    entry(2, 'tool/result', { message: { toolCallId: 'read', isError: true,
      content: [{ type: 'text', text: '{"code":"tool_outcome_unknown"}' }] }, meta: { nativeOutcome: fact } }),
    entry(3, 'turn/end', { reason: { kind: 'error', error: { code: 'NATIVE_READ_INTERRUPTED' } } })];
  const projector = createSessionTaskProjector({ sessionId: 'session' });
  const state = projector.project(window(1, rows))[0].state;
  assert.equal(state.items.find(item => item.kind === 'tool').status, 'uncertain');
  assert.equal(state.taskState, 'interrupted');
  const legacy = structuredClone(rows); delete legacy[1].event.data.meta;
  const old = createSessionTaskProjector({ sessionId: 'session' }).project(window(1, legacy))[0].state;
  assert.equal(old.items.find(item => item.kind === 'tool').status, 'failed');
  const status = { uncertainTools: { contract: 'agentkit.native-session-tool-outcomes/v1', sessionId: 'session', facts: [fact] } };
  const repaired = nativeHistoricalToolState(old, status, 1, 'session');
  assert.equal(repaired.items.find(item => item.kind === 'tool').status, 'uncertain');
  assert.equal(repaired.taskState, 'interrupted');
  assert.equal(old.items.find(item => item.kind === 'tool').status, 'failed', 'No historical event or input state was rewritten');
  assert.equal(nativeHistoricalToolState(old, status, 2, 'session'), old);
  assert.equal(nativeHistoricalToolState(old, status, 1, 'another-session'), old);
  const foreign = structuredClone(rows); foreign[1].event.data.meta.nativeOutcome.sessionId = 'another-session';
  assert.equal(createSessionTaskProjector({ sessionId: 'session' }).project(window(1, foreign))[0].state.items
    .find(item => item.kind === 'tool').status, 'failed');
});

test('stream settlement replaces transient text, and replay preserves one keyed tool including uncertainty', () => {
  const projector = createSessionTaskProjector();
  const start = entry(0, 'turn/start', {});
  const user = entry(1, 'user/message', { id: 'input', source: { kind: 'user' }, content: [{ type: 'text', text: 'Research the repository' }] });
  delete user.event.data.turn; // Real DSH user/message inherits the enclosing turn.
  const live = { ...entry(2.1, 'assistant/live-chunk', { chunk: { type: 'text-delta', index: 0, text: 'partial' } }), type: 'transient' };
  const initial = projector.project(window(1, [start, user, live]));
  assert.equal(initial[0].state.items.at(-1).text, 'partial');
  const settled = entry(3, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'Actual provider reasoning' }, { type: 'text', text: 'Read the source' }] } });
  const call = entry(4, 'tool/call', { callId: 'read-1', name: 'read_workspace_file', arguments: '{"path":"README.md"}' });
  const outcome = entry(5, 'tool/result', { message: { toolCallId: 'read-1', isError: true,
    content: [{ type: 'text', text: '{"status":"uncertain","reason":"effect_outcome_unknown"}' }] } });
  const state = projector.project(window(2, [start, user, settled, call, outcome], { kind: 'settle-assistant' }))[0].state;
  assert.equal(state.items.filter(item => item.kind === 'tool').length, 1);
  assert.equal(state.items.find(item => item.kind === 'tool').status, 'uncertain');
  assert.equal(state.items.filter(item => item.kind === 'text' && item.role !== 'user').map(item => item.text).join(''), 'Read the source');
  assert.equal(state.items.find(item => item.kind === 'thought').text, 'Actual provider reasoning');
  assert.equal(state.items[0].role, 'user');
  assert.deepEqual(projector.project(window(2, []))[0].state, state);
});

test('Native outcomes and inactive drivers cannot leave running tools or invent verified completion', () => {
  const state = { taskState: 'running', items: [{ kind: 'tool', status: 'running' }] };
  const stopped = nativeTaskState(state, { phase: 'executing_tools', runId: 'r' }, false);
  assert.equal(stopped.taskState, 'interrupted');
  assert.equal(stopped.items[0].status, 'interrupted');
  assert.equal(nativeTaskState(state, { phase: 'completed', outcome: 'unverified' }, false).taskState, 'unverified');
  assert.equal(nativeTaskState(state, { phase: 'completed', outcome: 'verified' }, false).taskState, 'completed');
  assert.equal(nativeTaskState(state, { phase: 'awaiting_reconciliation' }, false).taskState, 'waiting');
});

test('retained Native preview frames yield to compact committed content even when block positions differ', () => {
  const projector = createSessionTaskProjector();
  const live = { ...entry(1.5, 'assistant/live-chunk', {
    attemptId: 'native-attempt', chunk: { type: 'text-delta', index: 1, text: 'Read requirements' },
  }), type: 'transient' };
  const first = projector.project(window(1, [live]));
  assert.equal(first[0].state.items[0].streaming, true);
  const settled = entry(2, 'assistant/message', { message: { content: [
    { type: 'text', text: 'Read requirements' },
    { type: 'tool-call', id: 'read', name: 'read_workspace_file', arguments: '{}' },
  ] } });
  const second = projector.project(window(2, [live, settled], { kind: 'append', entries: [settled] }));
  const texts = second[0].state.items.filter(item => item.kind === 'text');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].streaming, false);
  assert.equal(texts[0].text, 'Read requirements');
  const replay = createSessionTaskProjector().project(window(3, [settled]));
  assert.deepEqual(second, replay);
});

test('tool presentations use settled metadata and real command output, never infer an edit from its arguments', () => {
  const projector=createSessionTaskProjector();
  const call=entry(1,'tool/call',{callId:'edit',name:'write_workspace_file',arguments:'{"path":"report.txt","content":"new"}'});
  const pending=projector.project(window(1,[call]))[0].state.items.find(item=>item.kind==='tool');
  assert.equal(pending.display==null,true);
  assert.equal(pending.status,'scheduled');
  const display={kind:'file_edit',files:[{path:'report.txt',patch:'@@ -1,1 +1,1 @@\n-old\n+new\n'}]};
  const edited=entry(2,'tool/result',{message:{toolCallId:'edit',content:[{type:'text',text:'{"ok":true}'}]},meta:{contract:'agentkit.workspace-display/v1',display}});
  const command=entry(3,'tool/call',{callId:'command',name:'run_command',arguments:'{"command":"node check.mjs"}'});
  const output=entry(4,'tool/result',{message:{toolCallId:'command',content:[{type:'text',text:'{"stdout":"checked\\n","stderr":"bad input\\n","exit_code":2}'}]}});
  const tools=projector.project(window(2,[call,edited,command,output]))[0].state.items.filter(item=>item.kind==='tool');
  assert.equal(tools[0].display.kind,display.kind);
  assert.equal(tools[0].display.files[0].patch,display.files[0].patch);
  assert.equal(tools[0].display.files[0].path,display.files[0].path);
  assert.equal(tools[1].display.kind,'command_output');
  assert.equal(tools[1].display.stdout,'checked\n');
  assert.equal(tools[1].display.stderr,'bad input\n');
  assert.equal(tools[1].display.exit,2);
});

test('provider argument drafts stay provisional and disappear when a committed call takes ownership', () => {
  const projector = createSessionTaskProjector();
  const first = { ...entry(1.2, 'assistant/live-chunk', { attemptId: 'attempt', chunk: {
    type: 'tool-call-delta', index: 0, name: 'write_workspace_file', argumentsDelta: '{"path":"sample.mjs","content":"part',
  } }), type: 'transient' };
  const draft = projector.project(window(1, [first]))[0].state.items;
  assert.equal(draft.length, 1); assert.equal(draft[0].kind, 'tool-preview');
  assert.equal(draft[0].input.content, 'part'); assert.equal(draft[0].status, undefined);
  const settled = entry(2, 'assistant/message', { message: { content: [{ type: 'tool-call', id: 'write', name: 'write_workspace_file', arguments: '{}' }] } });
  const call = entry(3, 'tool/call', { callId: 'write', name: 'write_workspace_file', arguments: '{"path":"sample.mjs","content":"part"}' });
  const accepted = projector.project(window(2, [first, settled, call], { kind: 'append', entries: [settled, call] }))[0].state.items;
  assert.equal(accepted.length, 1); assert.equal(accepted[0].kind, 'tool'); assert.equal(accepted[0].callId, 'write');
  assert.equal(accepted[0].display, undefined);
});

test('committed tool identities anchor early dispatch rows after their actual assistant content', () => {
  const earlyCall=entry(1,'tool/call',{callId:'child-call',name:'native_delegate',arguments:'{"role":"reader"}'});
  const message=entry(2,'assistant/message',{message:{id:'actual-message',content:[
    {type:'reasoning',text:'Actual reasoning before delegation'},
    {type:'text',text:'Delegating the read'},
    {type:'tool-call',id:'child-call',name:'native_delegate',arguments:'{"role":"reader"}'},
  ]}});
  const receipt=entry(3,'tool/result',{message:{toolCallId:'child-call',content:[{type:'text',text:'Actual child result'}]}});
  const projector=createSessionTaskProjector();
  projector.project(window(1,[earlyCall]));
  const rows=projector.project(window(2,[earlyCall,message,receipt]))[0].state.items;
  assert.deepEqual(rows.map(row=>row.kind),['thought','text','tool']);
  assert.equal(rows.at(-1).callId,'child-call');
  assert.equal(rows.at(-1).status,'completed');
});

test('a previous run status cannot finish or interrupt a newly submitted turn', async () => {
  const {nativeStatusForTurn}=await import('../src/host/session-task-events.mjs');
  const status={runId:'previous',presentationTurn:1,phase:'completed',outcome:'unverified'};
  assert.equal(nativeStatusForTurn(status,2),null);
  assert.equal(nativeStatusForTurn(status,1),status);
  assert.equal(nativeStatusForTurn({phase:'completed'},1),null);
});


test('committed compaction survives a later turn, event-window replacement and cold projector restore', () => {
  const marker = { id: `ak-native-${'a'.repeat(64)}`, status: 'completed', origin: 'auto', after: { kind: 'start' } };
  const compact = { ...entry(2, 'agentkit-native/context-marker', { contract: 'agentkit.native-context-presentation/v1',
    sessionId: 'session', runId: 'original-run', marker }), event: undefined };
  compact.event = { ...entry(2, 'agentkit-native/context-marker', { contract: 'agentkit.native-context-presentation/v1',
    sessionId: 'session', runId: 'original-run', marker }).event, ignorable: true };
  const first = entry(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Original task' }] });
  const later = entry(3, 'user/message', { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: 'Next task' }] });
  const projector = createSessionTaskProjector({ sessionId: 'session' });
  projector.project(window(1, [first, compact]));
  const rows = projector.project(window(2, [first, compact, later], { kind: 'append', entries: [later] }));
  assert.deepEqual(rows[0].state.contextMarkers, [marker]);
  assert.equal(rows[0].state.runId, 'original-run');
  const head = nativeTaskState(rows[1].state, { phase: 'completed', runId: 'new-run', presentationTurn: 2, outcome: 'unverified' }, false);
  assert.equal(head.contextMarkers?.length ?? 0, 0);
  assert.deepEqual(createSessionTaskProjector({ sessionId: 'session' }).project(window(3, [first, compact, later])), rows);
});

test('context transport rejects foreign sessions and malformed claims without changing implicit turn ownership', () => {
  const make = (seq, change = {}, envelope = {}) => ({ type: 'event', event: { seq, time: seq, type: 'agentkit-native/context-marker', ignorable: true,
    ...envelope, data: { contract: 'agentkit.native-context-presentation/v1', turn: 1, sessionId: 'session', runId: 'run',
      marker: { id: `ak-native-${'b'.repeat(64)}`, status: 'completed', origin: 'auto', after: { kind: 'start' } }, ...change } } });
  const first = entry(1, 'turn/start', {}), current = entry(2, 'turn/start', { turn: 2 });
  const user = entry(9, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Still belongs to turn 2' }] }); delete user.event.data.turn;
  const entries = [first, current, make(3, { sessionId: 'foreign' }), make(4, {}, { ignorable: false }),
    make(5, { marker: { id: 'not-a-native-identity', status: 'completed', origin: 'auto', after: { kind: 'start' } } }),
    make(6, {}, { surfaceOp: { op: 'append' } }), make(7), make(8, { runId: 'different-owner' }), user];
  const rows = createSessionTaskProjector({ sessionId: 'session' }).project(window(1, entries));
  assert.equal(rows.length, 2); assert.equal(rows[0].state.contextMarkers.length, 1); assert.equal(rows[0].state.runId, 'run');
  assert.equal(rows[1].state.contextMarkers?.length ?? 0, 0);
  assert.equal(rows[1].state.items.at(-1).text, 'Still belongs to turn 2');
});


test('closed Native background interruption replays as interrupted and unverified, rather than command failure', () => {
  const rows = [entry(0, 'turn/start', {}), entry(1, 'turn/end', { reason: { kind: 'error',
    error: { code: 'NATIVE_BACKGROUND_RESULT_UNKNOWN', message: 'transport diagnostic' } } })];
  const projector = createSessionTaskProjector();
  const state = projector.project(window(1, rows))[0].state;
  assert.equal(state.taskState, 'interrupted'); assert.equal(state.taskOutcome, 'unverified');
  assert.equal(state.taskSummary, '已结束等待，原命令结果仍未知；不会重跑。'); assert.equal(state.taskError, null);
  assert.deepEqual(createSessionTaskProjector().project(window(2, rows))[0].state, state);
  const unrelated = structuredClone(rows); unrelated[1].event.data.reason.error.code = 'constructor';
  assert.equal(createSessionTaskProjector().project(window(1, unrelated))[0].state.taskState, 'failed');
});

test('retired browser closure stays interrupted and unknown on both live projection and cold replay',()=>{
 const rows=[entry(0,'turn/start',{}),entry(1,'turn/end',{reason:{kind:'error',
  error:{code:'NATIVE_RESOURCE_RESULT_UNKNOWN',message:'operator disposition'}}})];
 const state=createSessionTaskProjector().project(window(1,rows))[0].state;
 assert.equal(state.taskState,'interrupted');assert.equal(state.taskOutcome,'unverified');assert.equal(state.taskError,null);
 assert.match(state.taskSummary,/原操作结果仍未知/);
 assert.deepEqual(createSessionTaskProjector().project(window(2,rows))[0].state,state);
});
