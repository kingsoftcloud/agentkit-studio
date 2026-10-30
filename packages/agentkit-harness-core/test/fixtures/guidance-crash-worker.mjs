import { appendFileSync } from 'node:fs';
import { NativeKernel, emptyUsage } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { scope, digest } from '../fixtures.mjs';
const [filename, position, marker] = process.argv.slice(2);
const store = new SqliteRunStore(filename);
const kernel = new NativeKernel({ store, digest, owner: 'guidance-crash',
  onCheckpoint: async snapshot => {
    if (position === 'applied' && snapshot.pendingGuidanceIds?.includes('g1')) process.exit(77);
    if (position === 'receipted' && snapshot.usage.modelCalls === 1 && !snapshot.pendingGuidanceIds?.length) process.exit(78);
  }, ports: { model: { generate: async () => {
    appendFileSync(marker, 'original-model\n');
    return { kind: 'final_candidate', text: 'First committed guided draft', toolCalls: [], usage: emptyUsage() };
  } } } });
await kernel.runUntilIdle(scope, 'run');
throw Error('guidance crash checkpoint not reached');
