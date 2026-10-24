/**
 * Test fixture for verify-studio-native-a2a: mounts the production Studio
 * Host from the packed archive with an A2A-bound Agent spec, real DSH SDK
 * preset/ToolRegistry/SessionController (full mounted host with authenticated
 * HTTP control RPC and production preset admission), a real local HTTP A2A
 * AgentCard discovery + JSONRPC/SSE peer, and a deterministic local model HTTP
 * SSE server.
 *
 * The fixture creates an Agent spec with:
 *   bindings.modelProfileIds = ['fixture']   (text-only primary, modelName 'main')
 *   bindings.tools = ['call_a2a_agent']
 *   bindings.a2a = [{ local_name, binding_id, space_id, target_agent_id,
 *     expected_version_id, exposure: 'tool' }]
 *   runtime.type = 'harness'                 (Native entry)
 *
 * The model emits a call_a2a_agent tool call. The Native A2A host discovers
 * the remote agent via the local HTTP ListAToASpaceAgents peer, sends a real
 * JSONRPC SendMessage (or SSE SendStreamingMessage), receives a Task with a
 * text artifact, selects the terminal reply, and the model completes.
 *
 * The verify script's session.run() drives the real turn through DSH's agent
 * loop; this fixture only sets up the mounted Host, admits the preset, and
 * registers tool admission logging. It does NOT call host.executeTurn directly.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';

export const name = 'studio-native-a2a-verification';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer'];

export async function apply(ctx, options) {
  try {
    await applyProof(ctx, options);
  } catch (error) {
    await writeFile(join(options.directory, 'a2a-fixture-error.json'),
      JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
    throw error;
  }
}

async function applyProof(ctx, options) {
  await appendFile(join(options.directory, 'host-processes.jsonl'), JSON.stringify({ pid: process.pid, node: process.version, path: process.env.PATH }) + '\n');
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    appendFileSync(join(options.directory, 'assistant-stream.jsonl'),
      JSON.stringify({ session: agent.session.id, frame }) + '\n');
  });
  if (options.holdTerminalClose) ctx.on('agent/created', ({ agent }) => {
    const session = agent.session, append = session.append;
    const boundary = join(options.directory, 'held-terminal-close.json');
    // Explicit fault injector: fail the first real DSH turn/end append before
    // any bytes are written, then the parent kills this actual Host process.
    // The replacement runs the original method; no fake event is supplied.
    const heldAppend = function(type, data, ...rest) {
      if (session.id === 'a2a-session' && type === 'turn/end' && data.reason?.kind === 'completed' && !existsSync(boundary)) {
        writeFileSync(boundary, JSON.stringify({ pid: process.pid, sessionId: session.id, turn: data.turn }), { mode: 0o600 });
        throw Error('Verification held original turn/end before append');
      }
      return append.call(this, type, data, ...rest);
    };
    session.append = heldAppend;
    ctx.effect(() => () => { if (session.append === heldAppend) session.append = append; }, 'verification terminal-close fault');
  });

  const workspaceRoot = join(options.directory, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });

  const agents = createAgentStore({ storeDir: join(options.directory, 'studio/agents') });
  const identity = join(options.directory, 'agent-id.json');
  let record, savedIdentity;
  try {
    savedIdentity = JSON.parse(await readFile(identity, 'utf8'));
    record = await agents.get(savedIdentity.id);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!record) {
    record = await agents.create({
      name: 'A2A Proof Agent',
      runtimeType: 'harness',
      spec: { context: { maxInputTokens: 8000, reserveOutputTokens: 256 },
        ...(options.childQuestion ? { subAgents: [{ name: 'researcher', instructions: 'Ask the remote research agent. Report its exact reply.',
          tools: ['call_a2a_agent'], modelProfileId: 'child-fixture', maxTurns: 3, maxToolCalls: 2, timeoutSeconds: 300 }] } : {}) },
      bindings: {
        modelProfileIds: ['fixture', ...(options.childQuestion ? ['child-fixture'] : [])],
        tools: ['call_a2a_agent'],
        a2a: typeof options.a2aBindings === 'string' ? JSON.parse(options.a2aBindings) : options.a2aBindings,
      },
    });
    savedIdentity = { id: record.metadata.id };
    await writeFile(identity, JSON.stringify(savedIdentity));
  }

  const home = options.directory;
  const warn = console.warn;
  const captureWarning = (...args) => {
    void appendFile(join(home, 'mounted-host-warnings.log'), args.map(String).join(' ') + '\n').catch(() => {});
    warn(...args);
  };
  console.warn = captureWarning;
  ctx.effect(() => () => { if (console.warn === captureWarning) console.warn = warn; }, 'Studio a2a verification warnings');

  // Model profile: text-only primary. The profile id is 'fixture' so
  // dshModelRoute maps it to 'agentkit-studio-fixture', matching the harness
  // provider; its modelName 'main' is what the HTTP server routes on.
  await writeFile(join(home, 'config.yaml'), JSON.stringify({
    modelProfiles: [
      { id: 'fixture', provider: 'openai-compatible', modelName: 'main',
        baseUrl: options.modelUrl, default: true, credentialName: 'STUDIO_NATIVE_A2A_KEY' },
      ...(options.childQuestion ? [{ id: 'child-fixture', provider: 'openai-compatible', modelName: 'child',
        baseUrl: options.modelUrl, credentialName: 'STUDIO_NATIVE_A2A_KEY' }] : []),
    ],
    modelProfileKeys: { STUDIO_NATIVE_A2A_KEY: 'sk-studio-a2a-secret' },
  }), { mode: 0o600 });

  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, {
    configurationHome: home,
    nativeHookRegistrations: [],
    env: {
      AGENTKIT_HOME: home,
      AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
      AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1',
      KSADK_A2A_SERVICE_URL: options.a2aServiceUrl,
      KSADK_A2A_SERVICE_TOKEN: options.a2aServiceToken,
      KSADK_A2A_ALLOW_PRIVATE: 'true',
      ...(options.a2aControlPlaneUrl ? { KSADK_A2A_CONTROL_PLANE_URL: options.a2aControlPlaneUrl,
        KSADK_A2A_TOKEN_DIR: options.a2aTokenDirectory } : {}),
    },
  });

  const presetId = dshPresetId(record.metadata.id, record.metadata.revision, record.buildId || '');

  // Default-engine adapter for any non-Native (default-session) delegation.
  let delegate = false;
  ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Studio Native a2a proof' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'main', name: 'main' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => {
      if (!delegate) throw Error('DSH model loop entered during Studio Native a2a execution');
      return { model: { provider: 'agentkit-studio-fixture', id: 'main', name: 'main' }, stream: async function* () {
        await appendFile(join(options.directory, 'default-invocations.jsonl'), '{}\n');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Default engine completed.' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Default engine completed.' } };
        yield { type: 'usage', usage: { inputTokens: 13, outputTokens: 17 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    },
  });

  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== 'a2a-session') return;
    const origin = ctx.webServer.getOrigin();
    const unauthorized = await fetch(origin + '/agentkit', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'host/compatibility', payload: {} }), signal: AbortSignal.timeout(5000) });
    if (unauthorized.status !== 401) throw Error('Mounted Host accepted unauthenticated control RPC');
    await unauthorized.text();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (login.status !== 302) throw Error('Mounted Host connection authentication failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method, payload = {}) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
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
      const admitted = await rpc('agents/ensure-preset', { agentId: record.metadata.id });
      if (admitted.presetId !== presetId) throw Error('Mounted Host admitted a different preset');
    }
    // Wait for the real registration; do not install a substitute preset.
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
      && row.config?.nativeEngineContract === 'agentkit.native-dsh-turn/v1'))
      throw Error('Production Native preset was not admitted');
    if (source === 'resume') {
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== presetId)
        throw Error('Native preset identity was not persisted');
      await ctx.agentPresets.recompose(agent.ctx, presetId);
    } else await ctx.agentPresets.select(agent, presetId);
    const history = agent.session.snapshotEvents();
    if (options.exportControl) {
      const deadline = Date.now() + 15000;
      while (!ctx.get('sessionController')) {
        if (Date.now() >= deadline) throw Error('Actual SessionController did not mount');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    await appendFile(join(options.directory, 'mounted-host-http.jsonl'), JSON.stringify({
      source, pid: process.pid, sessionId: agent.session.id, agentId: record.metadata.id, presetId,
      unauthorizedStatus: unauthorized.status, compatible: true, historyEvents: history.length,
      historyHasAnswer: JSON.stringify(history).includes('The remote agent found 3 relevant documents.'),
      historyHasCompletedTurn: history.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed'),
    }) + '\n');
    if (options.exportControl) await writeFile(join(options.directory, 'control-auth.json'),
      JSON.stringify({ origin, cookie, pid: process.pid }), { mode: 0o600 });
  });

  ctx.on('agent/execute-turn', async (payload, next) => {
    if (payload.agent.session.id === 'default-session') delegate = true;
    return next();
  });
  if (options.approvalUrl) ctx.on('approval/request', async request => {
    if (request.agent.session.id !== 'a2a-session' || !['a2a_cancel_task', ...(options.childQuestion ? ['a2a_continue_task'] : [])].includes(request.toolName)) return;
    // Controlled human answerer, through the real ApprovalService and a real
    // HTTP boundary. This is not the browser/gateway approval UI.
    const response = await fetch(options.approvalUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: request.toolName, callId: request.callId, reason: request.reason }), signal: request.signal });
    if (!response.ok) throw Error('Approval peer failed');
    const result = await response.json();
    return result.outcome === 'allowed-once' ? 'allowed-once' : 'rejected';
  }, { prepend: true });

  if (options.questionUrl) ctx.on('user-questions/request', async request => {
    if (request.agent.session.id !== 'a2a-session') return;
    // Deterministic human answerer only. Production userQuestions, approval,
    // Session, projection and Native services remain fully mounted.
    const response = await fetch(options.questionUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: process.pid, sessionId: request.agent.session.id, questions: request.questions }), signal: request.signal });
    if (!response.ok) throw Error('Question answer peer failed');
    return response.json();
  }, { prepend: true });

  // The Native tool port re-enters ctx.tools.execute, so pre-execute fires for
  // the a2a tool. Log the admission; never deny the a2a tool here.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent.session.id === 'a2a-session') {
      await appendFile(join(options.directory, 'tool-admissions.jsonl'),
        JSON.stringify({ callId: exec.callId, name: exec.name, arguments: exec.arguments }) + '\n');
    }
    return next();
  });
}
