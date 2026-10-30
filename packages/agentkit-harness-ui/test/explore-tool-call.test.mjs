import test from 'node:test';
import assert from 'node:assert/strict';
import { isExploreToolCall, isExecuteToolCall, isShellToolCallAwaitingCommand } from '../src/explore-tool-call.mjs';

test('the pinned presentation classifier supports Native identities and reference command shapes', () => {
  for(const input of [{command:'rg TODO src'}, {command:"sed -n '1,20p' README.md"},
    {cmd:'git status'}, {parsed_cmd:[{cmd:'ls -la src'}]}, ['bash','-lc','cat README.md'],
    {command:'powershell -Command "Get-Content README.md"'}]) {
    assert.equal(isExploreToolCall({kind:'run_command',input}),true,JSON.stringify(input));
    assert.equal(isExecuteToolCall({kind:'run_command',input}),false);
  }
  for(const command of ['npm test','cat README.md > copy.md','git checkout main','sed -i s/a/b/ source.mjs']) {
    assert.equal(isExploreToolCall({kind:'run_command',input:{command}}),false,command);
    assert.equal(isExecuteToolCall({kind:'run_command',input:{command}}),true);
  }
  assert.equal(isShellToolCallAwaitingCommand({kind:'run_command',input:{}}),true);
  assert.equal(isExploreToolCall({kind:'web_search',input:{query:'source'}}),true);
  assert.equal(isExploreToolCall({kind:'write_workspace_file',input:{path:'cat.md'}}),false);
  assert.equal(isExploreToolCall({kind:'enterprise_custom_action',input:{command:'cat README.md'}}),false);
});
