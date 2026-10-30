/** Opt-in local tool-task comparison using one configured model and one fixed read-only tool. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalConfiguration } from '../src/global-config.mjs';
import { createModelService } from '../src/model-service.mjs';
import { NativeKernel } from '@kingsoftcloud/agentkit-harness-core';
import { digest, fixture, scope, tool } from '../tests/fixtures/native-core.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node/native/model-port';

const modelName = process.argv[2], streaming = process.argv.includes('--stream'), coding = process.argv.includes('--coding'), writing = process.argv.includes('--write');
if (!modelName) { console.log('Usage: node scripts/compare-native-tool-real-model.mjs MODEL_NAME [--stream] [--coding|--write]'); process.exit(0); }
const selected = await createModelService({ configuration: createGlobalConfiguration(),
  credentials: { resolve: async () => null } }).profile(modelName);
const model = createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat', model: selected.modelName,
  baseUrl: selected.baseUrl, apiKey: selected.apiKey }) });
const prompt = writing
  ? '你是代码修复助手。下面函数在 requested 与 stock 相等时错误地拒绝结账。必须调用 set_checkout_operator 工具把 return 行的比较运算符修为正确值，再用中文简短说明修复。\nexport function canCheckout(stock: number, requested: number): boolean {\n  if (requested <= 0) return false;\n  return requested < stock;\n}'
  : coding
  ? '你是代码审查助手。必须先调用 read_source 读取待审查函数，然后指出库存刚好等于请求数量时的逻辑错误，并写出修正后的完整 return 表达式。不要猜测源代码。'
  : '你是企业差旅助手。必须先调用 lookup_policy 读取当前差旅费用；根据工具返回的三项费用计算总额，再用中文说明总额是否不超过 900 元。不要猜测工具数据。';
const policy = coding
  ? { path: 'src/inventory.ts', source: 'export function canCheckout(stock: number, requested: number): boolean {\n  if (requested <= 0) return false;\n  return requested < stock;\n}' }
  : { train: 360, hotel: 420, localTransport: 80, currency: 'CNY' };
const lookup = tool({ name: writing ? 'set_checkout_operator' : coding ? 'read_source' : 'lookup_policy',
  description: writing ? '将 src/inventory.ts 中 return requested < stock 的比较运算符改为 operator 参数。'
    : coding ? '读取 src/inventory.ts 的待审查函数；回答前必须调用一次。' : '读取当前差旅费用：火车、酒店和市内交通。回答前必须调用一次。',
  parameters: writing ? { type: 'object', additionalProperties: false, required: ['operator'],
    properties: { operator: { type: 'string', enum: ['<='] } } }
    : { type: 'object', additionalProperties: false, properties: {} }, readOnly: !writing, concurrentSafe: !writing });
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
    const effectPath = join(directory, `${variant}-${round}.ts`);
    const performTool = async arguments_ => {
      if (!writing) return policy;
      if (arguments_?.operator !== '<=') return { ok: false, error: 'invalid_operator' };
      const updatedSource = 'export function canCheckout(stock: number, requested: number): boolean {\n  if (requested <= 0) return false;\n  return requested <= stock;\n}';
      await writeFile(effectPath, updatedSource);
      return { ok: true, path: 'src/inventory.ts', updatedSource };
    };
    if (variant === 'direct') {
      const runId = `direct-${round}`;
      const first = await model.generate({ ...context(runId, 'first'), messages: [{ role: 'user', content: prompt }], tools: [lookup] });
      modelCalls++; inputTokens += first.usage.inputTokens; outputTokens += first.usage.outputTokens;
      status = first.kind;
      if (first.kind === 'tool_calls' && first.toolCalls.length === 1 && first.toolCalls[0].name === lookup.name) {
        toolCalls++;
        const call = first.toolCalls[0];
        const toolResult = await performTool(call.arguments);
        const second = await model.generate({ ...context(runId, 'second'), messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: first.text || '', toolCalls: first.toolCalls },
          { role: 'tool', callId: call.callId, name: call.name, content: JSON.stringify(toolResult) },
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
            const content = await performTool(request.call.arguments);
            return { status: content.ok === false ? 'error' : 'ok', content };
          } } } });
        kernel.start(snapshot, config);
        const result = await kernel.runUntilIdle(scope, 'run');
        output = String(result.finalText || ''); status = result.phase;
        ({ modelCalls, toolCalls, inputTokens, outputTokens } = result.usage);
      } finally { store.close(); }
    }
    const effectChecked = writing ? await readFile(effectPath, 'utf8').then(source => source.includes('return requested <= stock;'), () => false) : undefined;
    samples.push({ round, variant, status, checked: (writing ? effectChecked && /修|<=|等于/.test(output)
      : coding ? /requested\s*<=\s*stock/.test(output) : /860/.test(output) && /900/.test(output)) && toolCalls === 1,
      ...(writing ? { effectChecked } : {}),
      outputCharacters: output.length, modelCalls, toolCalls, inputTokens, outputTokens,
      latencyMs: Math.round(performance.now() - began) });
  }
} finally { await rm(directory, { recursive: true, force: true }); }
console.log(JSON.stringify({ model: selected.modelName, streaming, task: writing ? 'code fix with local filesystem effect'
  : coding ? 'read-only code review and exact correction' : 'read-only travel policy and arithmetic',
  baseline: 'direct inference with a minimal two-call tool loop', candidate: 'NativeKernel with SQLite', samples }, null, 2));
if (samples.some(row => !row.checked || !Number.isSafeInteger(row.inputTokens) || !Number.isSafeInteger(row.outputTokens))) process.exitCode = 1;
