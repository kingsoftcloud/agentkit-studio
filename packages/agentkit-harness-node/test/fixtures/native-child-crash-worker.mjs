import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { configure, emptyUsage, prepareEffect, transition, admittedToolBudget, reduceTools, settle, prepareChildLifecycle, childLifecycleRequest } from '../../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../../src/native/child-owner.mjs';

const dir = process.argv[2], store = new SqliteRunStore(join(dir, 'runs.sqlite'));
const childScope = { ...scope, agentId: 'child-agent' };
const definition = tool({ name: 'native_start_child', readOnly: false, concurrentSafe: false, childBudgetPolicy: 'start/v1' });
const childTool = tool({ name: 'write_proof', readOnly: false, concurrentSafe: false });
const call = { callId: 'start-1', name: definition.name, arguments: { role: 'worker', task: 'Write the child proof',
  ...(process.argv[3] === 'foreground' ? { background: false } : {}) } };
const { config, snapshot } = fixture({ tools: [definition], childLifecyclePolicy: 'owned-background/v2', limits: { maxModelCalls: 20, maxToolCalls: 20 } });
store.create(config, snapshot);
const lease = store.acquire(scope, 'run', 'dead-parent', 10, 100);
const executing = store.commit(scope, 'run', lease, 20, 0, transition(snapshot, {
  phase: 'executing_tools', pendingTools: [call], usage: { ...snapshot.usage, modelCalls: 1 },
  messages: [...snapshot.messages, { role: 'assistant', content: '', toolCalls: [call] }],
}));
const batch = prepareEffect(executing, 'tool', 'executing_tools', { calls: [call], interaction: null });
store.commit(scope, 'run', lease, 21, 1, batch); store.claim(scope, 'run', lease, 22, batch.snapshot.pendingIntent);
const parent = store.load(scope, 'run').snapshot;
const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, now: () => 22, resolveChild: async () => ({ scope: childScope,
  configuration: configure({ profile: config.profile, contract: { objective: call.arguments.task }, tools: [childTool], hostBindingDigest: 'child-process-fixture' }),
  ports: { model: { generate: async request => ({ kind: request.messages.some(message => message.role === 'tool') ? 'final_candidate' : 'tool_calls',
    text: request.messages.some(message => message.role === 'tool') ? 'Child evidence' : '', usage: emptyUsage(),
    toolCalls: request.messages.some(message => message.role === 'tool') ? [] : [{ callId: 'child-write', name: childTool.name, arguments: {} }] }) },
  tools: { execute: async () => { writeFileSync(join(dir, 'proof.txt'), 'one write'); return { status: 'ok', content: 'Written' }; } } },
}) });
const receipt = await owner.start({ ...Object.fromEntries(['scope', 'runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId'].map(key => [key, parent[key]])),
  operationKey: parent.pendingIntent, executionFence: lease.fence, signal: new AbortController().signal, call, definition, interaction: null, budget: admittedToolBudget(parent, config) });
const childId = receipt.childBudgetReservation.childRunId;
for (let tries = 0; tries < 500; tries++) {
  const child = store.load(childScope, childId).snapshot;
  if (child.phase === 'completed') {
    if (process.argv[3] === 'collection') {
      const committed = store.commit(scope, 'run', lease, 23, parent.revision, settle(parent, batch.intents[0], {
        operationKey: parent.pendingIntent, status: 'committed', result: { results: [receipt] },
      }, reduceTools(parent, [receipt], [call], batch.intents[0], config, digest), 0));
      const verifying = store.commit(scope, 'run', lease, 24, committed.revision, transition(committed, { phase: 'verifying',
        candidate: { candidateId: 'draft', text: 'Premature parent draft', goalRevision: 0, workspaceRevision: null },
        messages: [...committed.messages, { role: 'assistant', content: 'Premature parent draft', kind: 'final_candidate' }],
      }));
      const observing = prepareChildLifecycle(verifying, config);
      store.commit(scope, 'run', lease, 25, verifying.revision, observing);
      const claimed = store.claim(scope, 'run', lease, 26, observing.snapshot.pendingIntent);
      await owner.collect(childLifecycleRequest(store.load(scope, 'run').snapshot, claimed, new AbortController().signal));
      // Result exists, but the parent transaction is deliberately never written.
    }
    process.exit(0);
  }
  if (['failed', 'interrupted', 'canceled'].includes(child.phase)) throw new Error(`child failed: ${child.reason}`);
  await new Promise(resolve => setTimeout(resolve, 5));
}
throw new Error('child did not finish');
