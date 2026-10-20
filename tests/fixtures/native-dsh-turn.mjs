import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configure, canonical } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../../packages/agentkit-harness/src/native/model-port.mjs';
import { nativeDeliveryProjection } from '../../packages/agentkit-harness/src/native/session-delivery.mjs';
import { createNativeDshTurnExecutor } from '../../packages/agentkit-harness/src/native/dsh-turn-runtime.mjs';

export const name = 'studio-native-turn-verification';
export const inject = ['llm', 'sessions', 'sessionProjections'];
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Actual Native model/tool loop inside the shipped SDK profile. */
export async function apply(ctx, options) {
  const { renderPrompt } = await import(pathToFileURL(options.promptModule).href);
  const store = new SqliteRunStore(join(options.directory, 'native.sqlite'));
  let delegate = false;
  ctx.effect(() => () => store.close(), 'Native verification ledger');
  ctx.effect(() => ctx.sessionProjections.register(nativeDeliveryProjection()), 'Native delivery fold');
  // Model lookup is needed for SDK agent admission. Any default-loop request
  // would fail here, independently of the Native protocol server assertions.
  ctx.llm.registerAdapter(['native-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Native verification' }),
    providerRetryPolicy: () => undefined,
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => {
      if (!delegate) throw Error('The default DSH model loop must not run during a Native turn');
      return { model: { provider: 'native-fixture', id: 'pinned', name: 'pinned' }, stream: async function* () {
        await appendFile(join(options.directory, 'default-invocations.jsonl'), '{}\n');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Default engine completed.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Default engine completed.' } };
        yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 17 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  });
  const executeTurn = createNativeDshTurnExecutor({ store, projections: ctx.sessionProjections,
    flush: session => ctx.sessions.flush(session), owner: `sdk-${process.pid}`,
    onCheckpoint: async ({ turn }, snapshot) => {
      if (!['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)) return;
      await writeFile(join(options.directory, `native-turn-${turn}-diagnostics.json`), JSON.stringify({
        phase: snapshot.phase, outcome: snapshot.outcome, reason: snapshot.reason,
        modelCalls: snapshot.usage.modelCalls, providerErrors: snapshot.providerErrors,
        responses: store.events(snapshot.scope, snapshot.runId).filter(event => event.kind === 'model.completed').map(event => ({
          kind: event.payload.kind, usageReported: event.payload.usageReported,
        })),
        failures: store.load(snapshot.scope, snapshot.runId).receipts.filter(receipt => receipt.result.failureKind).map(receipt => ({
          status: receipt.status, kind: receipt.result.kind, failureKind: receipt.result.failureKind,
        })),
      }));
    },
    resolveTurn: async ({ agent, input, turn }) => {
    if (turn === 3) { delegate = true; return null; }
    const scope = { tenantId: 'local', workspaceId: digest(options.directory), userId: 'fixture', agentId: String(agent.id) };
    const inputMessages = input.messages.map(message => ({ role: 'user', content: message.content.map(block => {
      if (block.type !== 'text') throw Error('This verification owns text input only');
      return block.text;
    }).join('') }));
    const objective = inputMessages.at(-1).content;
    const instructions = renderPrompt(input.assembly);
    const configuration = configure({
      profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'openai', compatibilityDigest: 'fixture/v1', maxRetries: 0,
        ...(options.contextPlanning ? { contextWindow: Math.max(16384, Math.ceil(instructions.length / 4) + 4096), maxOutputTokens: 128 } : {}) },
      contract: { objective }, instructions, inputMessages,
      ...(options.contextPlanning ? { contextPolicy: { tokenizerId: 'sdk-fixture', tokenizerDigest: 'sdk-fixture-counter/v1', enabled: true,
        triggerRatio: .72, targetRatio: .45, summaryMaxTokens: 80, maxCompactions: null, maxCompactionsWithoutProgress: 4,
        minModelTurnsBetween: 2, maxSummaryRetries: 1 } } : {}),
      hostBindingDigest: digest({ input: input.messages, model: 'native-fixture', turn }),
      limits: { maxModelCalls: options.contextPlanning ? 100 : 4, maxToolCalls: 2,
        ...(options.contextPlanning ? { maxToolResultBytes: 256000 } : {}) },
      tools: [{ name: 'publish', description: 'Publish the verification marker',
        parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
        readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 1000,
        contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }],
    });
    return { scope, buildId: 'sdk-verification', configuration, taskChainId: String(agent.id),
      source: { provider: 'native-fixture', model: 'pinned' },
      ports: {
        ...(options.contextPlanning ? { context: { tokens: { tokenizerId: 'sdk-fixture', tokenizerDigest: 'sdk-fixture-counter/v1',
          countRequest: async request => Math.ceil(canonical({ messages: request.messages, tools: request.tools }).length / 4),
          countText: async request => Math.ceil(request.text.length / 4),
        } } } : {}),
        model: createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat',
          baseUrl: options.modelUrl, apiKey: 'sk-keyless-native-test', model: 'pinned' }) }),
        tools: { execute: async request => {
          await writeFile(join(options.directory, 'published.txt'), request.call.arguments.value);
          await appendFile(join(options.directory, 'writes.jsonl'), JSON.stringify({ key: request.operationKey, value: request.call.arguments.value }) + '\n');
          return { status: 'ok', content: { published: request.call.arguments.value,
            ...(options.contextPlanning ? { historicalEvidence: 'Observed evidence '.repeat(7000) } : {}) } };
        } },
      },
    };
  } });
  ctx.on('agent/execute-turn', async (payload, next) => {
    const result = await executeTurn(payload);
    if (result === undefined) return next();
    // Replay through the production executor as well as the real Session.
    // It must append nothing and must dispatch no external call a second time.
    await executeTurn(payload);
    return result;
  });
}
