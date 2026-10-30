import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, emptyUsage, artifactToolDefinitions } from '../../dist/index.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { fixture, tool, scope, digest } from '../fixtures.mjs';

const [mode, root, checkpoint] = process.argv.slice(2), store = new SqliteRunStore(join(root, 'runs.sqlite'));
const artifactStore = await createNativeArtifactStore({ directory: join(root, 'artifacts'), scope });
const definition = tool({ name: 'mutate', readOnly: false, concurrentSafe: false, timeoutMs: 10000 });
const data = fixture({ artifactPolicy: 'runtime-artifacts/v1', tools: [definition, ...artifactToolDefinitions()],
  profile: { ...fixture().config.profile, requestTimeoutMs: 9000 },
  limits: { leaseMs: 3000, effectTimeoutMs: 40000, maxToolResultBytes: 1400 } });
const response = calls => ({ kind: calls ? 'tool_calls' : 'final_candidate', text: calls ? '' : 'Done',
  toolCalls: calls ?? [], usage: emptyUsage() });
const hold = async stage => { process.send({ checkpoint: stage, pid: process.pid }); await new Promise(() => {}); };
const reads = [];
const kernel = new NativeKernel({ store, owner: `worker-${process.pid}`, digest,
  ...(mode === 'run' && checkpoint === 'receipt-committed' ? { onCheckpoint: async snapshot => {
    if (snapshot.artifactRefs.length) await hold('receipt-committed');
  } } : {}),
  ports: {
    artifacts: { ...artifactStore, write: async request => {
      const ref = await artifactStore.write(request);
      if (mode === 'run' && checkpoint === 'archive-published') await hold('archive-published');
      return ref;
    } },
    tools: { execute: async () => { appendFileSync(join(root, 'mutations'), `${process.pid}\n`);
      return { status: 'ok', content: { committed: true, content: '原始😀'.repeat(6000) } }; } },
    model: { generate: async request => {
      if (!request.messages.some(message => message.role === 'tool')) return response([{ callId: 'mutate', name: 'mutate', arguments: {} }]);
      const ref = store.load(scope, 'run').snapshot.artifactRefs[0];
      if (mode === 'recover' && checkpoint === 'receipt-committed'
        && !request.messages.some(message => message.name === 'ArtifactRead'))
        return response([{ callId: 'read', name: 'ArtifactRead', arguments: { uri: ref.uri, limit_chars: 32 } }]);
      reads.push(...request.messages.filter(message => message.name === 'ArtifactRead').map(message => JSON.parse(message.content)));
      return response();
    } },
  } });
if (mode === 'run') kernel.start(data.snapshot, data.config);
const result = await kernel.runUntilIdle(scope, 'run'), record = store.load(scope, 'run');
process.send({ done: true, pid: process.pid, phase: result.phase, outcome: result.outcome, reason: result.reason,
  artifactRefs: result.artifactRefs, receipts: record.receipts, reads, node: process.version });
store.close(); process.disconnect();
