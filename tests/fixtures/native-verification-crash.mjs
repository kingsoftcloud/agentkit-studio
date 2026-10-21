import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NativeKernel, canonical, configure, emptyUsage } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeVerification, nativeGoalContract } from '../../src/providers/native-verification.mjs';

const directory = process.argv[2];
const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'a' };
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const store = new SqliteRunStore(join(directory, 'runs.sqlite'));
const contract = nativeGoalContract({ sessionId: 'session', goal: '在工作区创建 note.txt，内容恰好是 ready。' });
const configuration = configure({ contract, hostBindingDigest: 'host',
  profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'test', compatibilityDigest: 'test' } });
const verifier = await createNativeVerification({ scope, sessionId: 'session', workspaceRoot: join(directory, 'workspace'),
  evidenceDirectory: join(directory, 'evidence') });
const kernel = new NativeKernel({ store, digest, owner: 'crashed-worker', ports: {
  model: { generate: async () => ({ kind: 'final_candidate', text: 'The file is ready.', toolCalls: [], usage: emptyUsage() }) },
  verification: { verify: async request => {
    await verifier.verify(request);
    // Abrupt death after the evidence store fsync, before the effect receipt.
    process.exit(83);
  } },
} });
kernel.start({ scope, runId: 'crash', sessionId: 'session', turnId: '1', buildId: 'build', parentRunId: null, taskChainId: 'chain' }, configuration);
await kernel.runUntilIdle(scope, 'crash');
throw new Error('The crash checkpoint was not reached');
