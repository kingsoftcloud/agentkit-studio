/** Opt-in comparison of NativeKernel and direct inference using one model port. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { NativeKernel } from '../packages/agentkit-harness-core/dist/index.mjs';
import { digest, fixture, scope } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../packages/agentkit-harness/src/native/model-port.mjs';

const modelName = process.argv[2];
if (!modelName) {
  console.log('Usage: node scripts/compare-native-real-model.mjs MODEL_NAME');
  process.exit(0);
}
const models = createModelService({ configuration: createGlobalConfiguration(), credentials: { resolve: async () => null } });
const selected = await models.profile(modelName);
const model = createNativeModelPort({ resolveProfile: async () => ({
  protocol: 'openai-chat', model: selected.modelName, baseUrl: selected.baseUrl, apiKey: selected.apiKey,
}) });
const tasks = [
  { id: 'business', prompt: '你是企业差旅助手。用户周五去南京，预算900元，住一晚。请用中文给出两项行程建议，并明确说明总预算不超过900元。回答限120字。',
    check: text => /南京/.test(text) && /900/.test(text) },
  { id: 'coding', prompt: '请修复这段 TypeScript 的逻辑错误：function first<T>(xs: T[]): T { return xs[1]; }。只输出修复后的函数代码，要求空数组时抛出 Error。',
    check: text => /xs\[0\]/.test(text) && /throw\s+new\s+Error/.test(text) },
];
const directory = await mkdtemp(join(tmpdir(), 'agentkit-native-comparison-'));
const samples = [];
try {
  for (const task of tasks) for (let round = 1; round <= 3; round++) {
    const { config, snapshot } = fixture({ contract: { objective: task.prompt }, tools: [],
      profile: { ...fixture().config.profile, profileId: selected.id, providerFamily: 'openai-chat',
        compatibilityDigest: 'real-model-comparison/v1', modelName: selected.modelName,
        requestTimeoutMs: 60_000, maxOutputTokens: 384, maxRetries: 0, maxProviderRetries: 0 },
      limits: { maxModelCalls: 1, maxWallMs: 90_000, finalizationReserveModelCalls: 0 } });
    for (const variant of (round % 2 ? ['direct', 'native'] : ['native', 'direct'])) {
      const began = performance.now();
      let result;
      if (variant === 'direct') {
        result = await model.generate({ scope, runId: `direct-${task.id}-${round}`, sessionId: 'session',
          turnId: 'turn', buildId: 'build', parentRunId: null, taskChainId: 'chain', operationKey: 'direct',
          signal: new AbortController().signal, profile: config.profile,
          messages: [{ role: 'user', content: task.prompt }], tools: [] });
      } else {
        const store = new SqliteRunStore(join(directory, `${task.id}-${round}.sqlite`));
        try {
          const kernel = new NativeKernel({ store, digest, owner: `comparison-${task.id}-${round}`, ports: { model } });
          kernel.start(snapshot, config);
          result = await kernel.runUntilIdle(scope, 'run');
        } finally { store.close(); }
      }
      const output = String(variant === 'direct' ? result.text || '' : result.finalText || '');
      samples.push({ task: task.id, round, variant,
        status: variant === 'direct' ? result.kind : result.phase,
        checked: task.check(output), outputCharacters: output.length,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        modelCalls: variant === 'direct' ? 1 : result.usage?.modelCalls ?? null,
        latencyMs: Math.round(performance.now() - began) });
    }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries(['direct', 'native'].map(variant => {
  const rows = samples.filter(row => row.variant === variant);
  return [variant, { passed: rows.filter(row => row.checked && (variant === 'direct' ? row.status === 'final_candidate' : row.status === 'completed')).length,
    total: rows.length, medianInputTokens: median(rows.map(row => row.inputTokens)),
    medianOutputTokens: median(rows.map(row => row.outputTokens)),
    medianLatencyMs: median(rows.map(row => row.latencyMs)) }];
}));
const report = { model: selected.modelName, baseline: 'direct inference through the same production model port',
  candidate: 'NativeKernel with temporary SQLite run store', samples, summary };
console.log(JSON.stringify(report, null, 2));
if (samples.some(row => row.inputTokens === null || row.outputTokens === null || row.modelCalls !== 1)) process.exitCode = 1;
