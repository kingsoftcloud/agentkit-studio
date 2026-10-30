import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeStatusPanelModel} from '../src/host/state/native-status-panel.mjs';
test('a status panel uses the exact run checklist and preserves original child navigation identity',()=>{
  const activity={contract:'agentkit.native-activity-status/v1',runId:'r',isRunning:true,
    plan:{items:[{id:'a',content:'Actual work',status:'completed'}],completedCount:1,totalCount:1},terminals:[]};
  const child={childRunId:'child',sessionId:'child-session',parentRunId:'original-parent',role:'reader',goalPreview:'Actual assigned task',phase:'completed',canCancel:true};
  const model=nativeStatusPanelModel({runId:'r',activity},[child]);
  assert.equal(model.plan,activity.plan);assert.equal(model.agents[0].parentRunId,'original-parent');
  assert.equal(model.agents[0].sessionId,'child-session');assert.equal(model.agents[0].canCancel,false);
  assert.equal(nativeStatusPanelModel({runId:'another',activity}).plan,null);
});
test('unknown or malformed Git facts cannot become a zero-change branch summary',()=>{
  assert.equal(nativeStatusPanelModel({workspaceStatus:{state:'unavailable'}}).git,null);
  assert.equal(nativeStatusPanelModel({workspaceStatus:{state:'available',git:{branchName:'main',added:0,removed:0,dirtyFileCount:0}}}).git,null);
  const git={branchName:'feature',added:959,removed:0,dirtyFileCount:3};
  assert.deepEqual(nativeStatusPanelModel({workspaceStatus:{state:'available',git}}).git,git);
  assert.equal(nativeStatusPanelModel({workspaceStatus:{state:'available',git:{...git,added:-1}}}).git,null);
});
test('terminal observations update only the same Agent, session, run and owned task without mutating committed activity', () => {
  const status = { agentId: 'a', sessionId: 's', runId: 'r', activity: { contract: 'agentkit.native-activity-status/v1', runId: 'r',
    isRunning: false, terminals: [{ id: 'task', state: 'unknown', canCancel: false }] } };
  const fact = { contract: 'agentkit.command-output-status/v1', agentId: 'a', sessionId: 's', runId: 'r', taskId: 'task', status: 'running' };
  const original = structuredClone(status), actual = nativeStatusPanelModel(status, [], [fact]);
  assert.equal(actual.terminals[0].state, 'running'); assert.equal(actual.isRunning, true); assert.deepEqual(status, original);
  for (const key of ['contract', 'agentId', 'sessionId', 'runId', 'taskId', 'status']) {
    const model = nativeStatusPanelModel(status, [], [{ ...fact, [key]: 'foreign' }]);
    assert.equal(model.terminals[0].state, 'unknown'); assert.equal(model.isRunning, false);
  }
  assert.equal(nativeStatusPanelModel(status, [], [{ ...fact, status: 'completed' }]).terminals[0].state, 'completed');
  assert.equal(nativeStatusPanelModel(status, [], [{ ...fact, command: 'actual original command' }]).terminals[0].title, 'actual original command');
});
