/** Opt-in local tool-task comparison using one configured model and one fixed read-only tool. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { NativeKernel } from '../packages/agentkit-harness-core/dist/index.mjs';
import { digest, fixture, scope, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';
import { SqliteRunStore } from '../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../packages/agentkit-harness/src/native/model-port.mjs';

const modelName = process.argv[2], streaming = process.argv.includes('--stream');
if (!modelName) { console.log('Usage: node scripts/compare-native-tool-real-model.mjs MODEL_NAME [--stream]'); process.exit(0); }
const selected = await createModelService({ configuration: createGlobalConfiguration(),
  credentials: { resolve: async () => null } }).profile(modelName);
const model = createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat', model: selected.modelName,
  baseUrl: selected.baseUrl, apiKey: selected.apiKey }) });
const prompt = '你是企业差旅助手。必须先调用 lookup_policy 读取当前差旅费用；根据工具返回的三项费用计算总额，再用中文说明总额是否不超过 900 元。不要猜测工具数据。';
const policy = { train: 360, hotel: 420, localTransport: 80, currency: 'CNY' };
const lookup = tool({ name: 'lookup_policy', description: '读取当前差旅费用：火车、酒店和市内交通。回答前必须调用一次。',
  parameters: { type: 'object', additionalProperties: false, properties: {} }, readOnly: true });
const profile = { ...fixture().config.profile, profileId: selected.id, providerFamily: 'openai-chat',
  compatibilityDigest: 'real-tool-comparison/v1', modelName: selected.modelName,
  requestTimeoutMs: 60_000, maxOutputTokens: 384, streaming, maxRetries: 0, maxProviderRetries: 0 };
const directory = await mkdtemp(join(tmpdir(), 'agentkit-native-tool-comparison-'));
const samples = [];
const context = (runId, operationKey) => ({ scope, runId, sessionId: 'session', turnId: 'turn', buildId: 'build',
  parentRunId: null, taskChainId: 'chain', operationKey, signal: new AbortController().signal, profile });
try {
  for (let round = 1; round <= 2; round++) for (const variant of (round === 1 ? ['direct', 'native'] : ['native', 'direct'])) {
    const began = performance.now();
    let output = '', status, modelCalls = 0, toolCalls = 0, inputTokens = 0, outputTokens = 0;
    if (variant === 'direct') {
      const runId = `direct-${round}`;
      const first = await model.generate({ ...context(runId, 'first'), messages: [{ role: 'user', content: prompt }], tools: [lookup] });
      modelCalls++; inputTokens += first.usage.inputTokens; outputTokens += first.usage.outputTokens;
      status = first.kind;
      if (first.kind === 'tool_calls' && first.toolCalls.length === 1 && first.toolCalls[0].name === lookup.name) {
        toolCalls++;
        const call = first.toolCalls[0];
        const second = await model.generate({ ...context(runId, 'second'), messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: first.text || '', toolCalls: first.toolCalls },
          { role: 'tool', callId: call.callId, name: call.name, content: JSON.stringify(policy) },
        ], tools: [lookup] });
        modelCalls++; inputTokens += second.usage.inputTokens; outputTokens += second.usage.outputTokens;
        status = second.kind; output = String(second.text || '');
      } else output = String(first.text || '');
    } else {
      const store = new SqliteRunStore(join(directory, `native-${round}.sqlite`));
      try {
        const { config, snapshot } = fixture({ contract: { objective: prompt }, profile, tools: [lookup],
          limits: { maxModelCalls: 3, maxToolCalls: 2, maxWallMs: 90_000, finalizationReserveModelCalls: 0 } });
        const kernel = new NativeKernel({ store, digest, owner: `native-${round}`, ports: { model,
          tools: { execute: async request => {
            if (request.call.name !== lookup.name) return { status: 'error', content: { code: 'unexpected_tool' } };
            return { status: 'ok', content: policy };
          } } } });
        kernel.start(snapshot, config);
        const result = await kernel.runUntilIdle(scope, 'run');
        output = String(result.finalText || ''); status = result.phase;
        ({ modelCalls, toolCalls, inputTokens, outputTokens } = result.usage);
      } finally { store.close(); }
    }
    samples.push({ round, variant, status, checked: /860/.test(output) && /900/.test(output) && toolCalls === 1,
      outputCharacters: output.length, modelCalls, toolCalls, inputTokens, outputTokens,
      latencyMs: Math.round(performance.now() - began) });
  }
} finally { await rm(directory, { recursive: true, force: true }); }
console.log(JSON.stringify({ model: selected.modelName, streaming, task: 'read-only travel policy and arithmetic',
  baseline: 'direct inference with a minimal two-call tool loop', candidate: 'NativeKernel with SQLite', samples }, null, 2));
if (samples.some(row => !row.checked || !Number.isSafeInteger(row.inputTokens) || !Number.isSafeInteger(row.outputTokens))) process.exitCode = 1;
