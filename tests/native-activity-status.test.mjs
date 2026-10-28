import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeActivityStatus } from '../packages/agentkit-harness-node/src/native/activity-status.mjs';
const record = () => ({snapshot:{runId:'run',revision:1,todos:{items:[
  {content:'Read actual evidence',status:'completed'}, {content:'Publish findings',status:'in_progress'},
]},backgroundCommands:[{ref:{taskId:'task',operationKey:'op'}}]},intents:[{operationKey:'op',payload:{calls:[{arguments:{command:'node report.mjs'}}]}}],events:[]});
test('activity reports committed todos and keeps UI keys across status updates without implying a running driver', () => {
  const r=record(), first=nativeActivityStatus(r);
  assert.equal(first.plan.completedCount,1); assert.equal(first.plan.totalCount,2); assert.equal(first.isRunning,false);
  r.snapshot.todos.items[1].status='completed';
  const second=nativeActivityStatus(r,{driving:true});
  assert.equal(second.plan.completedCount,2); assert.equal(first.plan.items[1].id,second.plan.items[1].id);
  assert.equal(second.isRunning,true); assert.equal(first.plan.items[1].status,'in_progress');
});
test('a launched background reference does not claim process liveness or grant cancellation', () => {
  const r=record(); assert.equal(nativeActivityStatus(r).terminals[0].state,'unknown');
  r.events.push({kind:'background.commands_observed',payload:{commands:[{taskId:'task',status:'failed'}]}});
  const terminal=nativeActivityStatus(r).terminals[0];
  assert.equal(terminal.title,'node report.mjs');assert.equal(terminal.state,'failed');assert.equal(terminal.canCancel,false);
});
test('large checklists have bounded rows and truthful total counts and omission metadata', () => {
  const r=record();r.snapshot.todos.items=Array.from({length:520},()=>({content:'Repeated task',status:'completed'}));
  const {plan}=nativeActivityStatus(r);
  assert.equal(plan.totalCount,520);assert.equal(plan.completedCount,520);assert.equal(plan.items.length,512);assert.equal(plan.omittedItems,8);
  assert.equal(new Set(plan.items.map(row=>row.id)).size,512);
});
