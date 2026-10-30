import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, emptyUsage } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { acceptance, digest, fixture, scope, tool } from '../fixtures.mjs';

const directory = process.argv[2], store = new SqliteRunStore(join(directory, 'runs.sqlite'));
const { config, snapshot } = fixture({ contract: { objective: 'Task', acceptance: [acceptance()] },
  tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false }), tool()],
  limits: { verificationIdleToolCalls: 1, finalizationReserveModelCalls: 0, leaseMs: 30 } });
let models = 0, revision = 'v1';
const kernel = new NativeKernel({ store, digest, owner: 'lost', now: () => 1, ports: {
  model: { generate: async () => { const name = ++models === 1 ? 'write' : 'read';
    return { kind: 'tool_calls', text: '', toolCalls: [{ name, callId: name, arguments: {} }], usage: emptyUsage() };
  } }, tools: { execute: async ({ call }) => {
    if (call.name === 'write') revision = 'v2';
    return { status: 'ok', content: 'Observed', workspaceChangedPaths: call.name === 'write' ? ['app.html'] : [] };
  } }, workspace: { observe: async () => ({ status: 'ok', revision, changedPaths: [] }) },
  verification: { verify: async () => {
  appendFileSync(join(directory, 'observations.txt'), 'once'); process.exit(77);
} } } });
kernel.start(snapshot, config);
await kernel.runUntilIdle(scope, 'run');
throw new Error('The verifier must terminate this process');
