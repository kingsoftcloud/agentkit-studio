import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NativeKernel, emptyUsage } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { fixture, scope, digest, tool } from '../fixtures.mjs';
const [filename, boundary] = process.argv.slice(2), root = dirname(filename), path = 'report.md';
let now = 0, models = 0;
const write = tool({ name: 'write', readOnly: false, concurrentSafe: false, deliveryWrite: true, deliveryArtifactRole: 'write' });
const { config, snapshot } = fixture({ tools: [write], limits: { maxWallMs: 600000, finalizationReserveWallMs: 60000, leaseMs: 1000000 } });
const store = new SqliteRunStore(filename);
const hold = async () => { process.send({ pid: process.pid, models, boundary }); await new Promise(() => {}); };
const worker = new NativeKernel({ store, digest, owner: 'killed-delivery', now: () => now, ports: {
  model: { generate: async () => { models++; return { kind: 'tool_calls', text: '', usage: emptyUsage(),
    toolCalls: [{ callId: 'write-original', name: 'write', arguments: { path, content: 'Original delivery' } }] }; } },
  tools: { execute: async () => { appendFileSync(join(root, 'effects.txt'), 'write\n'); writeFileSync(join(root, path), 'Original delivery');
    if (boundary === 'applied') await hold();
    return { status: 'ok', content: { ok: true, path }, workspaceChangedPaths: [path] }; } },
}, onCheckpoint: async state => {
  if (now === 0) now = 541000;
  if (['prepared', 'cancel'].includes(boundary) && state.pendingIntent && store.load(scope, 'run').intents
    .some(intent => intent.operationKey === state.pendingIntent && intent.kind === 'model' && intent.status === 'prepared')) await hold();
  if (boundary === 'written' && state.deliveryArtifacts?.paths.includes(path) && !state.pendingIntent) await hold();
} });
worker.start(snapshot, config); await worker.runUntilIdle(scope, 'run'); throw Error('Expected SIGKILL boundary');
