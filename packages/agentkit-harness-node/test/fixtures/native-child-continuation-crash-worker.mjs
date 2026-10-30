import { join } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import { NativeKernel, configure, emptyUsage } from '../../../agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest, tool } from '../../../agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../src/native/sqlite-store.mjs';
import { createNativeChildOwner } from '../../src/native/child-owner.mjs';
import { nativeChildToolDefinitions } from '../../src/native/child-tools.mjs';

const dir = process.argv[2], store = new SqliteRunStore(join(dir, 'runs.sqlite'));
const childScope = { ...scope, agentId: 'child-agent' }, definition = nativeChildToolDefinitions(['worker'])[0];
const response = (text, toolCalls = []) => ({ kind: toolCalls.length ? 'tool_calls' : 'final_candidate', text, toolCalls, usage: emptyUsage() });
const childCalls = new Map();
const owner = createNativeChildOwner({ scope, childScopes: [childScope], store, resolveChild: async request => ({ scope: childScope,
  configuration: configure({ profile: fixture().config.profile, contract: { objective: request.task }, hostBindingDigest: 'continuation-crash',
    tools: [tool({ name: 'write_proof', readOnly: false, concurrentSafe: false })], limits: { maxModelCalls: 3, maxToolCalls: 2 } }),
  ports: { model: { generate: async child => {
    const count = (childCalls.get(child.runId) ?? 0) + 1; childCalls.set(child.runId, count);
    return count === 1 ? response('', [{ callId: 'write', name: 'write_proof', arguments: {} }]) : response('Sealed child evidence');
  } }, tools: { execute: async child => {
    appendFileSync(join(dir, 'writes.txt'), child.runId + '\n'); return { status: 'ok', content: 'Written' };
  } } },
}) });
const config = fixture({ tools: [definition], childLifecyclePolicy: 'owned-background/v2',
  limits: { maxModelCalls: 20, maxToolCalls: 20, leaseMs: 1000, effectTimeoutMs: 130000 } }).config;
let source, step = 0;
const kernel = new NativeKernel({ store, owner: 'dead-parent', digest, ports: { children: owner,
  tools: { execute: async request => {
    const result = await owner.start(request);
    if (request.runId === 'later') {
      if (!result.childBudgetSettlement) throw Error('follow-up did not seal');
      // Both child Runs exist and the new write happened; the current parent
      // has not committed the follow-up's tool receipt or reserved its budget.
      process.exit(0);
    }
    return result;
  } }, model: { generate: async request => step++ % 2 === 0
    ? response('', [{ callId: 'start', name: definition.name, arguments: { role: 'worker', task: 'Write evidence', background: false,
      ...(request.runId === 'later' ? { continuation_of: source } : {}) } }]) : response('Parent evidence') } } });
const base = { scope, sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain' };
kernel.start({ ...base, runId: 'parent' }, config);
const first = await kernel.runUntilIdle(scope, 'parent'); source = first.childRunIds[0];
writeFileSync(join(dir, 'sealed-source.json'), JSON.stringify({ parent: store.load(scope, 'parent'), child: store.load(childScope, source) }));
kernel.start({ ...base, runId: 'later', turnId: '2' }, config);
await kernel.runUntilIdle(scope, 'later');
throw Error('follow-up crash boundary was not reached');
