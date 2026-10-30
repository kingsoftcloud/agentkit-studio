import test from 'node:test';import assert from 'node:assert/strict';import{taskWorkspaceFileTarget as target}from'../src/host/state/task-links.mjs';
import { nativeTaskWorkspaceRoot } from '../src/host/state/task-links.mjs';
test('Native files resolve against the admitted execution workspace rather than a different shell cwd', () => {
  const status = { contract: 'agentkit.studio-native-recovery/v1', agentId: 'a', sessionId: 's', runId: 'r',
    workspace: { contract: 'agentkit.native-execution-workspace/v1', workspaceId: 'w', root: '/actual/native' } };
  const binding = { agentId: 'a', sessionId: 's', fallback: '/shell/session' };
  assert.deepEqual(target('out/report.md', nativeTaskWorkspaceRoot(status, binding)), { path: '/actual/native/out/report.md' });
  for (const changed of [{ ...status, agentId: 'other' }, { ...status, sessionId: 'other' }, { ...status, managed: {} },
    { ...status, workspace: { ...status.workspace, root: 'relative/path' } },
    { ...status, workspace: { ...status.workspace, contract: 'unknown' } }, { ...status, workspace: null }])
    assert.equal(nativeTaskWorkspaceRoot(changed, binding), '/shell/session');
  assert.equal(target('../secret', nativeTaskWorkspaceRoot(status, binding)), null);
});
test('task file links stay in the selected workspace and preserve explicit locations',()=>{
  assert.deepEqual(target('./src/a%20b.ts:42:3','/work/agent'),{path:'/work/agent/src/a b.ts',line:42,column:3});
  assert.deepEqual(target('README.md','/work/agent/'),{path:'/work/agent/README.md'});
  assert.deepEqual(target('/work/agent/src/a.ts','/work/agent'),{path:'/work/agent/src/a.ts'});
  assert.deepEqual(target('src\\a.ts','C:\\work\\agent'),{path:'C:/work/agent/src/a.ts'});
  for(const href of ['../secret','src/../../secret','src/%2e%2e/%2e%2e/secret','/work/agent-other/key','/etc/passwd','https://evil.test','javascript:alert(1)','//evil.test','file:///etc/passwd','a%00.ts','a.ts:0','a.ts?token=1'])assert.equal(target(href,'/work/agent'),null,href);
  assert.equal(target('src/a.ts',null),null);
});
