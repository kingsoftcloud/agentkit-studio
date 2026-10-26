/** Fault injection around real SQLite commits; never rewrites stored records. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeKernel, configure, emptyUsage } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, scope, digest } from '../../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../../packages/agentkit-harness/src/native/model-port.mjs';
import { createNativeContextPort } from '../../packages/agentkit-harness/src/native/context-counter.mjs';
import { memoryDigest } from '../../packages/agentkit-harness/src/native/memory-candidate.mjs';
import { SqliteNativeMemoryProvider } from '../../packages/agentkit-harness/src/native/memory-store.mjs';
import { nativeRecoveryBinding } from '../../src/providers/native-recovery-binding.mjs';
import { createStudioNativeMemoryExtraction } from '../../src/host/services/native-memory-extraction.mjs';
import { StudioNativeMemoryExtractionStore } from '../../src/host/services/native-memory-extraction-store.mjs';

const [root, phase, modelUrl] = process.argv.slice(2);
const ledger = new SqliteRunStore(join(root, 'runs.sqlite'));
const record = { metadata: { id: scope.agentId, local: true, revision: 1 }, spec: {
  runtime: { type: 'harness' }, memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
    write: { mode: 'candidate' }, extraction: { enabled: true, minUserCharacters: 8 } },
  context: { rollout: { memoryWrite: 'enabled' } } } };
const jobs = new StudioNativeMemoryExtractionStore(join(root, 'native-harness', 'memory-extraction.sqlite'));
const binding = { protocol: 'openai-chat', model: 'fixture', baseUrl: modelUrl,
  apiKey: 'local-process-fixture', parameters: { stream: false } };
const counter = createNativeContextPort(binding), errors = [];
const kill = checkpoint => {
  writeFileSync(join(root, 'checkpoint.json'), JSON.stringify({ pid: process.pid, checkpoint }));
  process.kill(process.pid, 'SIGKILL');
};
if (phase === 'effect-committed') {
  const commit = ledger.commit.bind(ledger);
  ledger.commit = (...args) => {
    const batch = args[5];
    if (batch.receipts?.some(receipt => receipt.result?.results?.some(result => result.content?.committed === true)))
      kill('owner-committed-ledger-unsettled');
    return commit(...args);
  };
}
const service = createStudioNativeMemoryExtraction({ store: ledger, storeDir: root, jobs,
  principal: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: scope.userId },
  resolveRecord: async () => record, onError: error => errors.push(error.code ?? error.name),
  resolveModel: async ({ prepared, signal }) => ({ model: createNativeModelPort({ resolveProfile: async () => binding }),
    countRequest: request => counter.tokens.countRequest(request), planner: {
      countMessage: message => counter.tokens.countMessage({ message, profile: prepared.configuration.profile, signal }) } }) });

try {
  if (phase !== 'recover') {
    const text = '公司的发票和财务报表使用协调世界时，金额必须注明币种。';
    const config = configure({ ...fixture().config, profile: { ...fixture().config.profile,
      providerFamily: 'openai-chat', contextWindow: 32000, maxOutputTokens: 1024, streaming: false,
      maxRetries: 0, maxProviderRetries: 0 }, inputMessages: [{ role: 'user', kind: 'user_input', content: text }],
      hostRecoveryBinding: nativeRecoveryBinding({ binding: { agentId: scope.agentId, agentRevision: 1 },
        input: { messages: [{ id: 'original-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] },
        source: { provider: 'fixture', model: 'fixture' }, selection: {}, systemPrompt: '' }) });
    const kernel = new NativeKernel({ store: ledger, owner: 'original-parent', digest,
      ports: { model: { generate: async () => ({ kind: 'final_candidate', text: 'Understood.', toolCalls: [], usage: emptyUsage() }) } } });
    kernel.start({ scope, runId: 'parent', sessionId: 'session', turnId: 'parent', buildId: 'revision-frozen',
      parentRunId: null, taskChainId: 'chain' }, config);
    await kernel.runUntilIdle(scope, 'parent');
    if (phase === 'before-enqueue') kill('parent-terminal-before-enqueue');
    const queued = service.schedule({ scope, sessionId: 'session', runId: 'parent', record });
    if (phase === 'queued') kill('job-persisted-before-dispatch');
    if (phase === 'effect-committed') await service.drain();
    throw Error(`Fault checkpoint not reached: ${phase}/${queued.status}`);
  }
  await service.recover(); await service.drain();
  const state = service.status({ scope, sessionId: 'session' });
  const memory = new SqliteNativeMemoryProvider(join(root, 'native-harness', 'memory-v1',
    memoryDigest(scope.tenantId).slice(7), 'memory.sqlite'), { principal: scope, scopes: ['user'] });
  const facts = memory.list(); memory.close();
  const rows = jobs.list({ scope, sessionId: 'session' });
  const report = { pid: process.pid, state, facts, errors,
    parent: ledger.load(scope, 'parent').snapshot,
    auxiliary: rows.map(job => ledger.load(scope, job.jobId)) };
  writeFileSync(join(root, 'recovered.json'), JSON.stringify(report));
} finally { await service.close(); ledger.close(); }
