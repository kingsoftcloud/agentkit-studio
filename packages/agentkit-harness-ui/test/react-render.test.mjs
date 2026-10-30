import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarnessComponents} from '../src/react-binding.mjs';
import {initialState,reduce} from '../src/reducer.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

function state(events){return events.reduce((s,e,i)=>reduce(s,{v:1,id:String(i),...e}),initialState())}

{
  const {HarnessTimeline}=createHarnessComponents(React);

  test('real React renders nested streaming thought and terminal viewports through the injected React instance',()=>{
    const value=state([
      {type:'task.started',taskId:'real-react'},
      {type:'thinking.delta',itemId:'thought',delta:'Actual streamed reasoning'},
      {type:'tool.scheduled',callId:'shell',name:'run_command',input:{command:'node check.mjs'}},
      {type:'tool.started',callId:'shell'},
      {type:'tool.progress',callId:'shell',message:'Receiving output',display:{kind:'command_output',stdout:'actual\n',stderr:'',exit:null}},
    ]);
    const html=renderToStaticMarkup(React.createElement(HarnessTimeline,{state:value,initiallyExpandedThoughts:['thought'],initiallyExpandedTools:['shell'],styleSheet:null}));
    assert.match(html,/Actual streamed reasoning/);assert.match(html,/actual/);assert.match(html,/node check.mjs/);
    assert.doesNotMatch(html,/undefined|NaN/);
  });

  test('real React renders applied diff positions and disclosure without executing host actions',()=>{
    let opens=0;
    const value=state([
      {type:'task.started',taskId:'diff'},
      {type:'tool.scheduled',callId:'edit',name:'edit_workspace_file',input:{path:'src/a.ts'}},
      {type:'tool.result',callId:'edit',result:'saved',display:{kind:'file_edit',files:[{path:'src/a.ts',patch:'@@ -42,1 +42,1 @@\n-old\n+new\n',operationKind:'edit',changeStat:{added:1,removed:1}}]}},
    ]);
    const html=renderToStaticMarkup(React.createElement(HarnessTimeline,{state:value,initiallyExpandedTools:['edit'],styleSheet:null,onOpenFile:()=>opens++}));
    assert.match(html,/src\/a.ts/);assert.match(html,/>42</);assert.match(html,/data-testid="edit-diff"/);assert.equal(opens,0);
  });
}
