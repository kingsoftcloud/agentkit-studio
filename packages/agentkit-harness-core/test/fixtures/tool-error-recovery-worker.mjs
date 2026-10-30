import { writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { NativeKernel, emptyUsage } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, digest, scope, tool } from '../fixtures.mjs';

const [filename, boundary] = process.argv.slice(2), root = dirname(filename);
const { config, snapshot } = fixture({ toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1', toolErrorRecoveryModelCalls: 3,
  tools: [tool({ name: 'write', readOnly: false, concurrentSafe: false }), tool({ name: 'read', contextRole: 'workspace_read' })],
  limits: { maxModelCalls: 20, maxToolCalls: 20, finalizationReserveModelCalls: 0 } });
const store = new SqliteRunStore(filename); let models = 0;
const hold = async (kind, state) => {
  process.send({ kind, pid: process.pid, models, toolCalls: state.usage.toolCalls, recovery: state.toolErrorRecovery });
  await new Promise(() => {});
};
const worker = new NativeKernel({ store, digest, owner: 'killed-diagnostic-owner', ports: {
  model: { generate: async () => {
    const count = ++models;
    return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [{ callId: `call-${count}`,
      name: count === 7 ? 'read' : 'write', arguments: { text: count === 8 ? 'corrected' : 'wrong' } }] };
  } }, tools: { execute: async request => {
    appendFileSync(join(root, 'original-effects.jsonl'), JSON.stringify({ name: request.call.name, arguments: request.call.arguments }) + '\n');
    if (request.call.name === 'read') return { status: 'ok', content: { actual: 'corrected content required' } };
    if (request.call.arguments.text !== 'corrected') return { status: 'error', content: { code: 'mismatch' } };
    writeFileSync(join(root, 'result.txt'), 'correct');
    await hold('applied', store.load(scope, 'run').snapshot);
    return { status: 'ok', content: 'written', workspaceChangedPaths: ['result.txt'] };
  } },
}, onCheckpoint: async state => {
  if (boundary === 'window' && state.phase === 'preparing_context' && state.toolErrorRecovery && !state.toolErrorRecovery.diagnosticObservationSeen)
    await hold('window', state);
  if (['prepared', 'cancel'].includes(boundary) && state.pendingIntent && state.toolErrorRecovery?.trialConsumed) {
    const intent = store.load(scope, 'run').intents.find(row => row.operationKey === state.pendingIntent);
    if (intent?.kind === 'tool' && intent.status === 'prepared') await hold('prepared', state);
  }
} });
worker.start(snapshot, config); await worker.runUntilIdle(scope, 'run');
throw Error('Expected parent SIGKILL at diagnostic boundary');
