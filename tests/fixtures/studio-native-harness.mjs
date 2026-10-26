import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentStore } from '../../src/agent-store.mjs';
import { createModelService } from '../../src/model-service.mjs';
import { createStudioNativeHarness } from '../../src/host/services/native-harness.mjs';
import { mountRuntimeBridge } from '../../src/host/runtime-bridge.mjs';
import { createNativeDshTools } from '../../src/providers/native-dsh-tools.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { createLocalResourceAdapters } from '../../src/local-resource-adapters.mjs';
import { installWorkspaceRepairFault } from './studio-native-workspace-repair.mjs';
import { installConversationForkControls } from './studio-native-conversation-fork.mjs';

export const name = 'studio-native-host-verification';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets'];

function proofNativeHookRegistrations(options, record) {
  return [{ sourceRef: 'plugin://studio-proof-governance@1', sourceDigest: 'sha256:' + 'f'.repeat(64),
    agentIds: [record.metadata.id], authorizationVersion: 'studio-proof-policy/v1',
    configuration: { contract: 'agentkit.studio-native-hooks/v1', cleanupTimeoutMs: 1000, stopContinuationLimit: 0,
      hooks: [{ hookId: 'studio-proof-governance', events: ['PreToolUse', 'PostToolUse', 'Stop'], readOnly: true,
        timeoutMs: 5000, maxInputBytes: 100000, maxOutputBytes: 16000, failureMode: 'block' }] },
    authorize: async request => request.scope.agentId === record.metadata.id && request.sessionId === 'native-studio-session' ? 'allow' : 'deny',
    callback: async request => {
      await appendFile(join(options.directory, 'native-hook-callbacks.jsonl'), JSON.stringify({ agentId: request.scope.agentId,
        runId: request.runId, sessionId: request.sessionId, operationKey: request.operationKey, event: request.event }) + '\n');
      return { additionalContext: [`Host ${request.event} governance feedback`],
        ...(request.event === 'PreToolUse' ? { updatedArguments: { ...request.input.call.arguments,
          content: request.input.call.arguments.content + ' via Hook' } } : {}) };
    } }];
}

/** Exercise production Host, preset plugin and ToolRegistry in the shipped CLI. */
export async function apply(ctx, options) {
  try { await applyProof(ctx, options); }
  catch (error) {
    await writeFile(join(options.directory, 'fixture-startup-error.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
    throw error;
  }
}
async function applyProof(ctx, options) {
  // Match bootstrap's public Host import, including portable loader resolution.
  const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt');
  const { emitAgentEvent } = await import('@deepseek-ai/dsh-agent');
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    // Synchronous observation lets the HTTP peer prove a prefix is public
    // before it sends the provider's terminal response.
    appendFileSync(join(options.directory, 'assistant-stream.jsonl'), JSON.stringify({ session: agent.session.id, frame }) + '\n');
  });
  const workspaceRoot = join(options.directory, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const agents = createAgentStore({ storeDir: options.mountHost ? join(options.directory, 'studio/agents') : join(options.directory, 'studio') });
  const identity = join(options.directory, 'agent-id.json');
  let record, savedIdentity;
  try { savedIdentity = JSON.parse(await readFile(identity, 'utf8')); record = await agents.get(savedIdentity.id); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!record) {
    record = await agents.create({ name: 'Native Host proof', runtimeType: 'harness',
      spec: { ...(options.frozen || options.automation ? { instructions: { system: 'FROZEN_NATIVE_SYSTEM_A' } } : {}),
        execution: { ...(options.todos || options.planMode || options.conversationFork ? {} : { nativeTodoMode: 'off' }),
          ...(options.planMode ? {} : { nativePlanMode: 'off' }),
          ...(options.workspaceRepair ? { nativeToolSearchMode: 'off' } : {}),
          ...(options.mcpUrl && !options.toolSearch && !options.planMcp ? { nativeToolSearchMode: 'off' } : {}),
          ...(options.deliveryReview ? { deliveryReviewPolicy: { pathSuffixes: ['.ts'] } } : {}),
          ...(options.deadlinePolicy ? { nativeWallDeliveryPolicy: 'deadline-delivery/v7', timeoutSeconds: 600 } : {}) },
        ...(options.memory ? { memory: { enabled: true, providerRef: 'local-default', scopes: ['user'],
          recall: { enabled: true }, write: { mode: 'candidate', flushBeforeCompaction: !options.memoryManaged, flushAfterTurn: Boolean(options.memoryManaged) } },
          context: { maxInputTokens: options.memoryManaged ? 16000 : 6000, reserveOutputTokens: 128, rollout: { memoryWrite: 'enabled' },
            compaction: { thresholdRatio: options.memoryManaged ? .9 : .55, targetRatio: .2, summaryMaxTokens: 80 } } } : {}) },
      bindings: { modelProfileIds: ['fixture'], ...(options.mcpUrl
        ? { mcpServers: ['native-schema-fixture'], ...(options.planMcp ? { tools: ['write_workspace_file'] } : {}) } : { tools: options.planCommands ? ['write_workspace_file', 'run_command'] : options.memory ? [] : options.web ? ['web_fetch', 'web_search']
          : options.workspaceRepair ? ['apply_workspace_patch'] : options.editCreate ? ['read_workspace_file', 'edit_workspace_file'] : options.instructions ? ['read_workspace_file'] : options.artifactPolicy ? ['list_workspace_files']
          : options.conversationCommandRewind ? ['run_command', 'read_command_output', 'stop_command'] : options.deadlinePolicy || options.conversationRewind ? ['write_workspace_file', 'read_workspace_file', 'edit_workspace_file']
            : options.deliveryReview ? ['write_workspace_file', 'read_workspace_file'] : [options.commands ? 'run_command' : 'write_workspace_file'] }) } });
    await writeFile(identity, JSON.stringify({ id: record.metadata.id }));
  }
  if (options.frozen) {
    const { createStudioBuild } = await import('../../src/studio-build.mjs');
    const builds = createStudioBuild({ storeDir: join(options.directory, 'studio'), nativeEngineContract: 'agentkit.native-dsh-turn/v1' });
    if (!savedIdentity?.buildId) {
      const built = await builds.build({ agentId: record.metadata.id, agentName: record.metadata.name,
        revision: record.metadata.revision, metadata: record.metadata, spec: record.spec, bindings: record.spec.bindings });
      savedIdentity = { id: record.metadata.id, buildId: built.id };
      await writeFile(identity, JSON.stringify(savedIdentity));
      await agents.update(record.metadata.id, { spec: { ...record.spec, instructions: { system: 'LATEST_NATIVE_SYSTEM_B' },
        ...(options.memory ? { memory: { ...record.spec.memory, enabled: false },
          context: { ...record.spec.context, rollout: { memoryWrite: 'off' } } } : {}) } });
    }
    record = await builds.resolve(savedIdentity.id, savedIdentity.buildId);
  }
  let presetId = 'studio-native-proof';
  if (options.mountHost) {
    const home = options.directory;
    const warn = console.warn;
    const captureWarning = (...args) => {
      void appendFile(join(home, 'mounted-host-warnings.log'), args.map(String).join(' ') + '\n').catch(() => {});
      warn(...args);
    };
    console.warn = captureWarning;
    ctx.effect(() => () => { if (console.warn === captureWarning) console.warn = warn; }, 'Studio verification warnings');
    await writeFile(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
      modelName: 'pinned', baseUrl: options.modelUrl, default: true, credentialName: 'STUDIO_NATIVE_FIXTURE_KEY' }],
      modelProfileKeys: { STUDIO_NATIVE_FIXTURE_KEY: 'sk-studio-fixture-secret' } }), { mode: 0o600 });
    const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
    await mountStudioHost(ctx, { configurationHome: home,
      nativeHookRegistrations: options.hooks ? proofNativeHookRegistrations(options, record) : [], ...(options.mcpUrl ? {
      resourceAdapterFactory: deps => createLocalResourceAdapters({ ...deps, resourceStore: { get: id => id === 'native-schema-fixture'
        ? { resourceId: id, endpointUrl: options.mcpUrl } : deps.resourceStore?.get(id) } }),
    } : {}), env: { AGENTKIT_HOME: home,
      AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
      ...(options.web ? { KSADK_WEB_SEARCH_PROVIDER: 'http',
        KSADK_WEB_SEARCH_BASE_URL: new URL('/search', options.modelUrl).href,
        KSADK_WEB_SEARCH_API_KEY: 'web-proof-search-secret', KSADK_WEB_SSRF_POLICY_JSON: '{"allow_private":true}' } : {}),
      // Exercise the actual product default, including restored presets.
    } });
    presetId = dshPresetId(record.metadata.id, record.metadata.revision, record.buildId || '');
  } else {
    const bridge = mountRuntimeBridge(ctx);
    const models = createModelService({
      configuration: { resolve: async () => ({ values: { modelProfiles: [{ id: 'fixture', provider: 'openai-compatible',
        modelName: 'pinned', baseUrl: options.modelUrl, default: true }] } }) },
      credentials: { resolve: async () => ({ value: 'sk-studio-fixture-secret' }) },
    });
    const native = await createStudioNativeHarness({ ctx, storeDir: join(options.directory, 'studio'),
      workspaceRoot, agents, models, renderPrompt,
      publishStreamFrame: ({ agent }, frame) => emitAgentEvent(ctx, agent, 'agent/assistant-stream', { frame }) });
    ctx.effect(() => () => native.close(), 'Studio Native Host lifetime');
    ctx.effect(() => bridge.setNativeToolsFactory(({ ctx: toolsCtx, config }) => createNativeDshTools({
      ctx: toolsCtx, config, workspaceRoot, stateDir: join(options.directory, 'workspace-state'),
    })), 'Studio Native tool factory');
    ctx.effect(() => bridge.setNativeTurnExecutor(payload => native.executeTurn(payload)), 'Studio Native turn executor');
  }
  let delegate = false;
  ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Studio Native proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => {
      if (!delegate) throw Error('DSH model loop entered during Studio Native execution');
      return { model: { provider: 'agentkit-studio-fixture', id: 'pinned', name: 'pinned' }, stream: async function* () {
        await appendFile(join(options.directory, 'default-invocations.jsonl'), '{}\n');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Default engine completed.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Default engine completed.' } };
        yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 17 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  });
  if (!options.mountHost) {
    const disposePreset = await ctx.agentPresets.register({ id: presetId, plugins: [{ id: 'runtime',
      name: pathToFileURL(join(options.repository, 'src/providers/dsh-runtime-plugin.mjs')).href,
      config: { agentId: record.metadata.id, agentRevision: 1, runtime: 'harness', local: true,
        nativeEngineContract: 'agentkit.native-dsh-turn/v1',
        toolBindings: [options.commands ? 'run_command' : 'write_workspace_file'], toolContracts: [{ name: options.commands ? 'run_command' : 'write_workspace_file', executor: 'builtin',
          description: 'Write the verification marker', parameters: { type: 'object' } }] },
    }] });
    ctx.effect(() => disposePreset, 'Studio verification preset');
  }
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id === 'native-studio-session' || options.conversationFork && agent.session.header.isSeeded
      || options.memoryParallel && agent.session.id === 'native-studio-peer') {
      if (options.mountHost) {
        const origin = ctx.webServer.getOrigin();
        const unauthorized = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'host/compatibility', payload: {} }), signal: AbortSignal.timeout(5000) });
        if (unauthorized.status !== 401) throw Error('Mounted Host accepted unauthenticated control RPC');
        await unauthorized.text();
        const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (login.status !== 302) throw Error('Mounted Host connection authentication failed');
        const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        if (options.automation || options.recovery || options.trace || options.workspaceRepair || options.conversationRewind) await writeFile(join(options.directory, 'mounted-host-connection.json'), JSON.stringify({ origin, cookie }), { mode: 0o600 });
        const rpc = async (method, payload = {}) => {
          const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
            body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(10000) });
          const result = (await response.json()).result;
          if (response.status !== 200 || !result?.ok) throw Error(`Mounted Host RPC ${method} failed: ${result?.error?.code}`);
          return result.value;
        };
        const compatibility = await rpc('host/compatibility');
        if (!compatibility.features['agent-presets'].available) throw Error('Mounted Host preset compatibility failed');
        const stored = await rpc('agents/local-get', { agentId: record.metadata.id });
        if (stored.metadata.id !== record.metadata.id) throw Error('Mounted Host read a different Agent');
        if (source !== 'resume') {
          const admitted = await rpc('agents/ensure-preset', { agentId: record.metadata.id,
            ...(record.buildId ? { buildId: record.buildId } : {}) });
          if (admitted.presetId !== presetId) throw Error('Mounted Host admitted a different preset');
        }
        await appendFile(join(options.directory, 'mounted-host-http.jsonl'), JSON.stringify({ source,
          hostPid: process.pid, agentId: record.metadata.id, presetId, unauthorizedStatus: unauthorized.status, compatible: true }) + '\n');
        // The SDK handshake precedes optional Host reconciliation. Wait for the
        // real registration; do not install a substitute preset in this fixture.
        const deadline = Date.now() + 15000;
        let rows;
        while (!rows) {
          try { rows = await ctx.agentPresets.pluginsFor(presetId); }
          catch (error) {
            if (error.code !== 'agent-preset/not-found' || Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        if (!rows.some(row => row.name === '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin'
          && row.config?.nativeEngineContract === 'agentkit.native-dsh-turn/v1')) throw Error('Production Native preset was not admitted');
      }
      if (source === 'resume' || options.conversationFork && agent.session.header.isSeeded) {
        if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== presetId) throw Error('Native preset identity was not persisted');
        await ctx.agentPresets.recompose(agent.ctx, presetId);
      } else await ctx.agentPresets.select(agent, presetId);
      if (options.planMode && source === 'resume') ctx.get('planMode').set(agent, true);
    }
  });
  ctx.on('agent/execute-turn', async (payload, next) => {
    if (payload.agent.session.id === 'default-session') delegate = true;
    const result = await next();
    if (options.todos || options.planMode) await appendFile(join(options.directory, 'todos-projections.jsonl'), JSON.stringify({
      todos: ctx.sessionProjections.stateOf(payload.agent.session, 'todos'),
      plan: ctx.sessionProjections.stateOf(payload.agent.session, 'plan'), hostPid: process.pid }) + '\n');
    return result;
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent.session.id === 'native-studio-session' || options.memoryParallel && exec.agent.session.id === 'native-studio-peer') {
      await appendFile(join(options.directory, 'tool-admissions.jsonl'), JSON.stringify({ callId: exec.callId, name: exec.name,
        ...(options.memoryParallel ? { sessionId: exec.agent.session.id } : {}) }) + '\n');
      if (options.memoryManaged && exec.name === 'manage_memory' && exec.arguments.content === 'Memory pipeline forbidden')
        return { kind: 'deny', reason: 'Memory pipeline denied the write' };
      if (options.planMcp && exec.name === 'plan_safe' && exec.arguments.deny)
        return { kind: 'deny', reason: 'MCP exploration denied by Host policy' };
      if (options.planCommands && exec.name === 'run_command' && exec.arguments.command === 'printf denied-by-host')
        return { kind: 'deny', reason: 'Command exploration denied by Host policy' };
      if (exec.arguments.path === 'denied.txt' || options.commands && exec.arguments.command.endsWith('> denied.txt'))
        return { kind: 'deny', reason: 'Verification policy denied this write' };
    }
    return next();
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.agent.session.id !== 'native-studio-session' || result.isError || options.editCreate || options.conversationFork || options.workspaceRepair || options.memory || options.web || options.deliveryReview || options.deadlinePolicy || options.artifactPolicy || options.instructions || options.planMode) return next();
    const path = options.commands ? / > ([A-Za-z0-9.-]+)$/.exec(exec.arguments.command)?.[1] : exec.arguments.path;
    // This really enters the Host's next-step inbox. The Native loop must claim
    // it through prepareInput after the complete tool batch, including policy.
    exec.agent.steer({ id: `live-steer-${path}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: `Live instruction for ${path}` }] });
    return { kind: 'accept', content: [{ type: 'text', text: `Published ${path} (policy view)` }],
      additionalContexts: [{ id: `context-${exec.callId}`, role: 'user', source: { kind: 'tool', callId: exec.callId },
        content: [{ type: 'text', text: `Loaded context for ${path}` }] }] };
  });
  if (options.planMode) ctx.on('user-questions/request', async (request, next) => {
    const review = request.questions.find(question => question.intent?.kind === 'plan-review');
    if (!review || request.agent?.session.id !== 'native-studio-session') return next();
    const filename = join(options.directory, 'plan-reviews.jsonl');
    let prior = []; try { prior = (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const approved = prior.length > 0;
    await appendFile(filename, JSON.stringify({ question: review, approved, hostPid: process.pid }) + '\n');
    return { answers: [{ id: review.id, selected: [approved ? 'Approve' : 'Keep planning'],
      ...(approved ? {} : { custom: 'Include rollback steps.' }) }] };
  }, { prepend: true });
  if (options.conversationCommandRewind) ctx.on('approval/request', async request => {
    if (request.agent.session.id === 'native-studio-session' && ['run_command', 'stop_command'].includes(request.toolName)) return 'allowed-once';
  }, { prepend: true });
  if (options.memoryManaged) ctx.on('approval/request', async request => {
    if (request.agent.session.id !== 'native-studio-session' || request.toolName !== 'manage_memory') return;
    if (options.memoryParallel) {
      await writeFile(join(options.directory, 'memory-approval-waiting'), request.callId);
      const deadline = Date.now() + 15000;
      while (!existsSync(join(options.directory, 'memory-approval-release'))) {
        request.signal.throwIfAborted();
        if (Date.now() >= deadline) throw Error('Parallel Memory approval proof timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      request.signal.throwIfAborted();
      return 'allowed-once';
    }
    // Deterministic human responder; the actual ApprovalService still owns
    // turn enclosure, the policy decision and persisted asked/decided events.
    return Promise.resolve(request.reason?.includes('forget') ? 'allowed-once' : 'rejected');
  }, { prepend: true });
  if (options.workspaceRepair) await installWorkspaceRepairFault(ctx, options, record);
  if (options.conversationFork) installConversationForkControls(ctx, options);
  if (options.recovery) {
    const origin = ctx.webServer.getOrigin();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (login.status !== 302) throw Error('Recovery proof authentication failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await writeFile(join(options.directory, 'mounted-host-connection.json'), JSON.stringify({ origin, cookie }), { mode: 0o600 });
    const marker = join(options.directory, 'recovery-crash.json');
    const originalFlush = ctx.sessions.flush.bind(ctx.sessions);
    const { SqliteRunStore } = await import('../../packages/agentkit-harness/src/native/sqlite-store.mjs');
    const { parseNativeJson } = await import('../../packages/agentkit-harness-core/dist/index.mjs');
    ctx.sessions.flush = async session => {
      const durable = await originalFlush(session);
      const events = session.snapshotEvents(), owner = events.findLast(event => event.type === 'turn/owner');
      if (durable === true && session.id === 'native-studio-session' && owner && !existsSync(marker)) {
        const admission = parseNativeJson(owner.data.binding);
        const ledger = new SqliteRunStore(join(options.directory, 'studio/native-harness/runs.sqlite'));
        const runs = ledger.list(admission.identity.scope); ledger.close();
        writeFileSync(marker, JSON.stringify({ pid: process.pid, owner: owner.data, events, runs }));
        const fd = openSync(marker, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        process.exit(37); // No turn/end, Host cleanup or Native Run creation.
      }
      return durable;
    };
    ctx.effect(() => () => { ctx.sessions.flush = originalFlush; }, 'Recovery proof flush injection');
  }
}
