import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeKernel, configure, canonical } from '../../packages/agentkit-harness-core/dist/index.mjs';
import { SqliteRunStore } from '../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../../packages/agentkit-harness/src/native/model-port.mjs';
import { createNativeSessionDelivery, nativeDeliveryProjection } from '../../packages/agentkit-harness/src/native/session-delivery.mjs';

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
  ctx.on('agent/execute-turn', async ({ agent, input, turn, signal }, next) => {
    if (turn === 3) { delegate = true; return next(); }
    const scope = { tenantId: 'local', workspaceId: digest(options.directory), userId: 'fixture', agentId: String(agent.id) };
    const runId = `native-${agent.id}-${turn}`;
    const objective = input.messages.map(message => message.content.map(block => {
      if (block.type !== 'text') throw Error('This verification owns text input only');
      return block.text;
    }).join('')).join('\n\n');
    const configuration = configure({
      profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'openai', compatibilityDigest: 'fixture/v1', maxRetries: 0 },
      contract: { objective }, instructions: renderPrompt(input.assembly),
      hostBindingDigest: digest({ input: input.messages, model: 'native-fixture', turn }),
      limits: { maxModelCalls: 4, maxToolCalls: 2 },
      tools: [{ name: 'publish', description: 'Publish the verification marker',
        parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
        readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 1000,
        contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }],
    });
    const onCheckpoint = createNativeSessionDelivery({ store, scope, runId, session: agent.session, turn,
      projections: ctx.sessionProjections, flush: session => ctx.sessions.flush(session),
      systemText: configuration.instructions, inputMessages: input.messages, source: { provider: 'native-fixture', model: 'pinned' } });
    const kernel = new NativeKernel({ store, digest, owner: `sdk-${process.pid}`, onCheckpoint,
      ports: {
        model: createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat',
          baseUrl: options.modelUrl, apiKey: 'sk-keyless-native-test', model: 'pinned' }) }),
        tools: { execute: async request => {
          await writeFile(join(options.directory, 'published.txt'), request.call.arguments.value);
          await appendFile(join(options.directory, 'writes.jsonl'), JSON.stringify({ key: request.operationKey, value: request.call.arguments.value }) + '\n');
          return { status: 'ok', content: { published: request.call.arguments.value } };
        } },
      },
    });
    kernel.start({ scope, runId, sessionId: String(agent.session.id), turnId: String(turn), buildId: 'sdk-verification',
      parentRunId: null, taskChainId: String(agent.id) }, configuration);
    const result = await kernel.runUntilIdle(scope, runId, { signal });
    if (result.phase !== 'completed') throw Error(`Native verification stopped: ${result.phase}/${result.reason}`);
    // Re-deliver committed events in the same real Session. Both invocations
    // must be no-ops for append and must never dispatch another external call.
    await onCheckpoint(result);
    await kernel.runUntilIdle(scope, runId);
    return { reason: { kind: 'completed' } };
  });
}
