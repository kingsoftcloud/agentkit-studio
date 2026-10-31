import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configure, canonical, NATIVE_JSON_CODEC } from '@kingsoftcloud/agentkit-harness-core';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeModelPort } from '@kingsoftcloud/agentkit-harness-node/native/model-port';
import { nativeDeliveryProjection } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import { createNativeDshTurnExecutor } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';
import { createLocalResourceAdapters } from '../../src/local-resource-adapters.mjs';
import { snapshotNativeMcpSchema } from '../../src/providers/native-mcp-schema.mjs';
import { mountRuntimeBridge } from '../../src/host/runtime-bridge.mjs';
import * as studioRuntime from '../../src/providers/dsh-runtime-plugin.mjs';

export const name = 'studio-native-numeric-verification';
export const inject = ['tools', 'llm', 'sessions', 'sessionProjections'];
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Real SDK profile fixture; production Native model, ledger, delivery, and DSH tool bindings. */
export async function apply(ctx, options) {
  const { renderPrompt } = await import(pathToFileURL(options.promptModule).href);
  const store = new SqliteRunStore(join(options.directory, 'native.sqlite'));
  ctx.effect(() => () => store.close(), 'Native numeric verification ledger');
  ctx.effect(() => ctx.sessionProjections.register(nativeDeliveryProjection()), 'Native delivery fold');
  const toolName = options.studioMcpUrl ? 'echo' : 'mcp__exact__echo';
  let contract = { name: toolName, executor: 'mcp' };
  const resources = options.studioMcpUrl ? createLocalResourceAdapters({
    resourceStore: { get: async id => id === 'exact' ? { endpointUrl: options.studioMcpUrl } : null },
  }) : null;
  if (resources) ctx.effect(() => () => resources.close(), 'Studio MCP production resources');
  if (resources) {
    const [tool] = await resources.listMcpTools('exact', { jsonCodec: NATIVE_JSON_CODEC, snapshot: true });
    // Match production admission's serializable, revision-bound schema carrier.
    contract = JSON.parse(JSON.stringify({ ...contract, resourceId: 'exact', description: tool.description,
      nativeMcpSchema: snapshotNativeMcpSchema(tool) }));
  }
  const bridge = resources ? mountRuntimeBridge(ctx) : null;
  if (bridge) ctx.effect(() => bridge.setResourceToolExecutor(({ resourceId, name, arguments: args, signal, resultFormat }) =>
    resources.callMcpTool(resourceId, name, args, { signal, resultFormat })), 'Studio MCP resource execution');
  const gateway = createNativeDshTools({ ctx, workspaceRoot: join(options.directory, 'workspace'), stateDir: join(options.directory, 'tools'),
    config: { toolBindings: [toolName], toolContracts: [contract] }, ...(resources ? {
      executeMcpTool: request => bridge.executeResourceTool(request),
    } : {}) });
  if (gateway.argumentEncoding !== 'dsh.raw-json-number/v1') throw Error('SDK exact-number capability missing');
  ctx.tools.guard(exec => {
    if (exec.name !== toolName) return undefined;
    if (exec.argumentEncoding !== gateway.argumentEncoding) return 'Missing exact numeric argument encoding';
    if (exec.arguments.ordinary !== 7) return 'Ordinary numbers must retain their primitive representation';
    return undefined;
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    await appendFile(join(options.directory, 'policy.jsonl'), JSON.stringify({
      name: exec.name, encoding: exec.argumentEncoding, arguments: JSON.stringify(exec.arguments),
    }) + '\n');
    return next();
  });
  ctx.llm.registerAdapter(['native-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Native numeric verification' }),
    providerRetryPolicy: () => undefined,
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('The default DSH model loop must not run during this Native turn'); },
  });
  const executeTurn = createNativeDshTurnExecutor({ store, projections: ctx.sessionProjections,
    flush: session => ctx.sessions.flush(session), owner: `numeric-sdk-${process.pid}`,
    onCheckpoint: async (_payload, snapshot) => {
      if (['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)) {
        await writeFile(join(options.directory, 'native-status.json'), canonical({ phase: snapshot.phase, reason: snapshot.reason,
          receipts: store.load(snapshot.scope, snapshot.runId).receipts }));
      }
      if (snapshot.phase !== 'completed') return;
      await writeFile(join(options.directory, 'native-receipts.json'), canonical(store.load(snapshot.scope, snapshot.runId).receipts));
    },
    resolveTurn: async ({ agent, input }) => {
      const scope = { tenantId: 'local', workspaceId: hash(options.directory), userId: 'fixture', agentId: String(agent.id) };
      const inputMessages = input.messages.map(message => ({ role: 'user', content: message.content.map(block => block.text ?? '').join('') }));
      return { scope, buildId: 'numeric-sdk-verification', taskChainId: String(agent.id),
        source: { provider: 'native-fixture', model: 'pinned' },
        configuration: configure({
          profile: { profileId: 'fixture', profileVersion: '1', providerFamily: 'openai', compatibilityDigest: 'numeric-fixture/v1', maxRetries: 0 },
          contract: { objective: inputMessages.at(-1).content }, instructions: renderPrompt(input.assembly), inputMessages,
          hostBindingDigest: hash({ argumentEncoding: gateway.argumentEncoding }),
          tools: gateway.definitions(agent, input.assembly.tools), limits: { maxModelCalls: 3, maxToolCalls: 2 },
        }),
        ports: { ...gateway.forAgent(agent), model: createNativeModelPort({ resolveProfile: async () => ({
          protocol: 'openai-chat', baseUrl: options.modelUrl, apiKey: 'sk-keyless-native-test', model: 'pinned',
        }) }) },
      };
    },
  });
  const drive = async (payload, next = () => { throw Error('Native turn was not claimed'); }) => {
    const result = await executeTurn(payload);
    if (result === undefined) return next();
    await executeTurn(payload);
    return result;
  };
  if (resources) {
    ctx.effect(() => bridge.setNativeToolsFactory(() => gateway), 'Studio MCP Native tool composition');
    ctx.effect(() => bridge.setNativeTurnExecutor(drive), 'Studio MCP Native turn composition');
    await ctx.plugin(studioRuntime, { agentId: 'numeric-studio', agentRevision: 1, runtime: 'harness', local: true,
      nativeEngineContract: 'agentkit.native-dsh-turn/v1', toolBindings: [toolName], toolContracts: [contract] });
  } else ctx.on('agent/execute-turn', drive);
}
