import { join } from 'node:path';
import { NativeKernel, configure, emptyUsage } from '../../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../../src/native/child-tools.mjs';

const store = new SqliteRunStore(join(process.argv[2], 'runs.sqlite'));
const childScope = { ...scope, agentId: 'child-agent' }, definition = nativeChildToolDefinitions(['worker'])[2];
let entered;
const active = new Promise(resolve => { entered = resolve; });
const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async () => ({ scope: childScope,
  configuration: configure({ profile: fixture().config.profile, contract: { objective: 'Write the child proof' },
    hostBindingDigest: 'promotion-crash', modelRecoveryPolicy: 'pure-inference/v1',
    tools: [tool({ name: 'write_proof', readOnly: false, concurrentSafe: false })], limits: { maxModelCalls: 3, maxToolCalls: 2, leaseMs: 1000 } }),
  ports: { model: { generate: async () => { entered(); return await new Promise(() => {}); } },
    tools: { execute: async () => { throw Error('child must stay before its write'); } } },
}) });
const { config, snapshot } = fixture({ tools: [definition], childLifecyclePolicy: 'owned-background/v2',
  childPromotionPolicy: 'owned-child-promotion/v1', limits: { maxModelCalls: 20, maxToolCalls: 20, leaseMs: 1000, effectTimeoutMs: 130000 } });
const kernel = new NativeKernel({ store, owner: 'dead-parent', digest, ports: { children: owner,
  tools: { execute: request => owner.start(request) }, model: { generate: async () => ({ kind: 'tool_calls', text: '', usage: emptyUsage(),
    toolCalls: [{ callId: 'start-1', name: definition.name, arguments: { role: 'worker', task: 'Write the child proof' } }] }) } },
  onCheckpoint: async current => {
    if (current.promotedChildRunIds?.length) process.exit(0);
  } });
kernel.start(snapshot, config);
const running = kernel.runUntilIdle(scope, 'run');
await active;
const child = kernel.childTasks(scope, 'run')[0];
kernel.promoteChild(scope, 'run', child.childRunId, 'durable-promote');
await running;
throw Error('promotion checkpoint was not reached');
