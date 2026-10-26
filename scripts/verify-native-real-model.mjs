/** Opt-in, bounded local NativeKernel check against a configured real model. */
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
  console.log('Usage: node scripts/verify-native-real-model.mjs MODEL_NAME');
  process.exit(0);
}

const models = createModelService({ configuration: createGlobalConfiguration(), credentials: { resolve: async () => null } });
const selected = await models.profile(modelName);
const model = createNativeModelPort({ resolveProfile: async () => ({
  protocol: 'openai-chat', model: selected.modelName, baseUrl: selected.baseUrl, apiKey: selected.apiKey,
}) });
const directory = await mkdtemp(join(tmpdir(), 'agentkit-native-real-model-'));
const tasks = [
  { id: 'business', objective: '你是企业差旅助手。用户周五去南京，预算900元，住一晚。请用中文给出两项行程建议，并明确说明总预算不超过900元。回答限120字。',
    check: text => /南京/.test(text) && /900/.test(text) },
  { id: 'coding', objective: '请修复这段 TypeScript 的逻辑错误：function first<T>(xs: T[]): T { return xs[1]; }。只输出修复后的函数代码，要求空数组时抛出 Error。',
    check: text => /xs\[0\]/.test(text) && /throw\s+new\s+Error/.test(text) },
];
const report = { model: selected.modelName, tasks: [] };
try {
  for (const task of tasks) {
    const store = new SqliteRunStore(join(directory, `${task.id}.sqlite`));
    try {
      const { config, snapshot } = fixture({
        contract: { objective: task.objective },
        profile: { ...fixture().config.profile, profileId: selected.id, providerFamily: 'openai-chat',
          compatibilityDigest: 'real-model-local/v1', modelName: selected.modelName,
          requestTimeoutMs: 60_000, maxOutputTokens: 384, maxRetries: 0, maxProviderRetries: 0 },
        limits: { maxModelCalls: 1, maxWallMs: 90_000, finalizationReserveModelCalls: 0 },
      });
      const kernel = new NativeKernel({ store, digest, owner: `real-${task.id}`, ports: { model } });
      kernel.start(snapshot, config);
      const began = performance.now();
      const result = await kernel.runUntilIdle(scope, 'run');
      const text = String(result.finalText || '');
      report.tasks.push({ id: task.id, phase: result.phase, outcome: result.outcome,
        reason: result.reason, checked: task.check(text), outputCharacters: text.length,
        usage: result.usage, latencyMs: Math.round(performance.now() - began) });
    } finally { store.close(); }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
report.passed = report.tasks.every(task => task.phase === 'completed' && task.checked && task.usage.modelCalls === 1);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
