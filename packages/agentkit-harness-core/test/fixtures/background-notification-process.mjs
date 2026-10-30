import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, admitBackgroundNotification, emptyUsage, BACKGROUND_COMMAND_CONTRACT,
  backgroundCommandObservation } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, tool, scope, digest } from '../fixtures.mjs';

const [mode, directory] = process.argv.slice(2), store = new SqliteRunStore(join(directory, 'runs.sqlite'));
const final = () => ({ kind: 'final_candidate', text: 'Done', toolCalls: [], usage: emptyUsage() });
if (mode === 'admit') {
  const launcher = tool({ name: 'run_command', readOnly: false, concurrentSafe: false, backgroundCommandPolicy: 'owned-command-launch/v1' });
  const { snapshot, config } = fixture({ tools: [launcher], limits: { maxModelCalls: 4, finalizationReserveModelCalls: 0 },
    backgroundNotificationPolicy: 'completed-before-model/v1' });
  let calls = 0;
  const kernel = new NativeKernel({ store, digest, owner: 'source-process', ports: {
    model: { generate: async () => ++calls === 1 ? { ...final(), kind: 'tool_calls',
      toolCalls: [{ callId: 'launch', name: 'run_command', arguments: {} }] } : final() },
    tools: { execute: async request => ({ status: 'ok', content: { backend: 'sandbox/local_process' },
      backgroundCommandRef: { taskId: 'a'.repeat(64), sourceRunId: request.runId, operationKey: request.operationKey } }) },
    background: { contract: BACKGROUND_COMMAND_CONTRACT, observe: async () => [] },
  } });
  kernel.start(snapshot, config);
  await kernel.runUntilIdle(scope, 'run');
  const notification = await admitBackgroundNotification({ store, scope, sourceRunId: 'run', taskId: 'a'.repeat(64), digest,
    signal: new AbortController().signal, observe: async request => backgroundCommandObservation({ ref: request.ref, status: 'completed', stdout: 'original completion' }) });
  writeFileSync(join(directory, 'admitted.json'), JSON.stringify({ runId: notification.snapshot.runId,
    sourceDigest: digest(store.load(scope, 'run')), created: notification.created }));
  // Actual Host-process death after the SQLite admission commits but before any
  // notification Kernel or model intent is created. No store.close runs here.
  process.exit(37);
}
const original = JSON.parse(readFileSync(join(directory, 'admitted.json'), 'utf8'));
const notification = await admitBackgroundNotification({ store, scope, sourceRunId: 'run', taskId: 'a'.repeat(64), digest,
  signal: new AbortController().signal, observe: async () => { throw Error('must not poll admitted completion again'); } });
if (notification.created || notification.snapshot.runId !== original.runId) throw Error('duplicate admission');
const kernel = new NativeKernel({ store, digest, owner: 'cold-driver', ports: {
  model: { generate: async request => {
    const notices = request.messages.filter(message => message.kind === 'background_command_observation');
    if (notices.length !== 1 || JSON.parse(notices[0].content).commands[0].stdout !== 'original completion') throw Error('notice missing');
    appendFileSync(join(directory, 'model-calls.jsonl'), JSON.stringify({ runId: request.runId, operationKey: request.operationKey }) + '\n');
    return final();
  } }, tools: { execute: async () => { throw Error('command relaunched'); } },
} });
const result = await kernel.runUntilIdle(scope, original.runId);
if (result.phase !== 'completed' || digest(store.load(scope, 'run')) !== original.sourceDigest) throw Error('source changed');
store.close();
