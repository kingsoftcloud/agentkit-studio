import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, configure, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { scope, fixture, digest } from './native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeChildOwner } from '@kingsoftcloud/agentkit-harness-node/native/child-owner';
import { nativeChildToolDefinitions } from '@kingsoftcloud/agentkit-harness-node/native/child-tools';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { createStudioNativeChildWorkspaces } from '../../src/providers/native-child-workspace-host.mjs';
import { createStudioNativeChildMerge } from '../../src/providers/native-child-merge.mjs';
import { previousChildPublication } from '@kingsoftcloud/agentkit-harness-node/native/child-publication';

const root = process.argv[2], source = join(root, 'workspace'); mkdirSync(source, { recursive: true });
const store = new SqliteRunStore(join(root, 'runs.sqlite'));
const role = { name: 'writer', tools: ['write_workspace_file'], concurrentSafe: false };
const childScope = { ...scope, agentId: `${scope.agentId}:child:writer` };
const files = createStudioNativeChildWorkspaces({ workspaceRoot: source, stateDir: join(root, 'state') });
const merge = createStudioNativeChildMerge({ scope, sessionId: 'session', store, roles: [role], fileWorkspaces: files,
  previousPublication: previousChildPublication, authorize: async () => 'allow' });
const response = (text, calls = []) => ({ kind: calls.length ? 'tool_calls' : 'final_candidate', text,
  toolCalls: calls, usage: emptyUsage() });
let childId, childRounds = 0, parentRounds = 0;
const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async request => {
  childId = request.childRunId;
  const bound = files.bind({ scope: childScope, sessionId: request.childSessionId, role });
  const tools = createNativeWorkspaceTools({ workspaceRoot: bound.root, stateDir: join(root, 'child-state'),
    sessionId: request.childSessionId, authorize: async () => 'allow' });
  const write = tools.definitions.find(definition => definition.name === 'write_workspace_file');
  return { scope: childScope, configuration: configure({ profile: fixture().config.profile, tools: [write],
    contract: { objective: request.task }, hostBindingDigest: digest(bound.binding),
    hostRecoveryBinding: { childWorkspace: bound.binding }, limits: { maxModelCalls: 3, maxToolCalls: 2 } }),
  ports: { workspace: bound.observer, tools,
    model: { generate: async () => ++childRounds === 1 ? response('', [{ callId: 'write', name: write.name,
      arguments: { path: 'child.txt', content: 'published once before crash' } }]) : response('child delivery') } } };
} });
const kernel = new NativeKernel({ store, digest, owner: 'original-parent', ports: { children: owner,
  model: { generate: async () => {
    parentRounds++;
    return parentRounds === 1 ? response('', [{ callId: 'start', name: 'native_delegate',
      arguments: { role: 'writer', task: 'Write a child file' } }])
      : response('', [{ callId: 'merge', name: merge.definition.name, arguments: { child_run_id: childId } }]);
  } }, tools: { execute: async request => {
    if (request.call.name === 'native_delegate') return owner.start(request);
    const result = await merge.execute(request);
    if (result.status !== 'ok') throw Error(JSON.stringify(result));
    appendFileSync(join(root, 'publications.log'), request.operationKey + '\n');
    process.exit(87); // Files published; no ToolResult/receipt reaches the Kernel.
  } } } });
kernel.start({ scope, runId: 'run', sessionId: 'session', turnId: 'turn', buildId: 'build', parentRunId: null,
  taskChainId: 'chain' }, fixture({ tools: [...nativeChildToolDefinitions(['writer']), merge.definition],
  childLifecyclePolicy: 'owned-background/v2', limits: { effectTimeoutMs: 130000, leaseMs: 1000,
    maxModelCalls: 8, maxToolCalls: 8 } }).config);
await kernel.runUntilIdle(scope, 'run');
throw Error('expected process exit inside merge dispatch');
