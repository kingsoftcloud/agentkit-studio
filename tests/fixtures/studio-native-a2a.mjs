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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
        nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} },
        tools: ['call_a2a_agent'],
        a2a: typeof options.a2aBindings === 'string' ? JSON.parse(options.a2aBindings) : options.a2aBindings,
      },
    });
    savedIdentity = { id: record.metadata.id };
    await writeFile(identity, JSON.stringify(savedIdentity));
  }
  const inboundProof = options.inboundProofPath ? JSON.parse(await readFile(options.inboundProofPath, 'utf8')) : null;
  let managedRecord;
  if (inboundProof?.formalBinding) {
    const identityPath = join(options.directory, 'managed-agent-id.json');
    try { managedRecord = await agents.get(JSON.parse(await readFile(identityPath, 'utf8')).id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!managedRecord) {
      managedRecord = await agents.create({ name: 'Managed formal Native Agent', runtimeType: 'harness',
        spec: { context: { maxInputTokens: 8000, reserveOutputTokens: 256 } },
        bindings: { modelProfileIds: ['inbound-fixture'], tools: ['write_workspace_file'],
          nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} } } });
      await writeFile(identityPath, JSON.stringify({ id: managedRecord.metadata.id }));
    }
    inboundProof.targetBinding.agentId = managedRecord.metadata.id;
    await writeFile(join(options.directory, 'managed-studio-binding.json'), JSON.stringify({ agentId: managedRecord.metadata.id }));
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
      ...(managedRecord ? [{ id: 'inbound-fixture', provider: 'openai-compatible', modelName: 'inbound-model',
        ...(inboundProof?.structuredInput ? { input: ['text', 'image'] } : {}),
        baseUrl: options.a2aControlPlaneUrl + '/native-inbound-model', credentialName: 'STUDIO_NATIVE_INBOUND_KEY' }] : []),
      ...(options.childQuestion ? [{ id: 'child-fixture', provider: 'openai-compatible', modelName: 'child',
        baseUrl: options.modelUrl, credentialName: 'STUDIO_NATIVE_A2A_KEY' }] : []),
    ],
    modelProfileKeys: { STUDIO_NATIVE_A2A_KEY: 'sk-studio-a2a-secret', ...(managedRecord ? { STUDIO_NATIVE_INBOUND_KEY: 'controlled-inbound-model' } : {}) },
  }), { mode: 0o600 });

  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  let nativeA2aInbound, nativeManagedKernel, managedExecution, managedSessionId, managedAgentHandle;
  ctx.effect(() => () => managedAgentHandle?.dispose(), 'verification managed Session handle');
  if (options.inboundProofPath) {
    const proof = inboundProof;
    const { createA2aGatewayIdentityVerifier } = await import('../../src/providers/native-a2a-ingress-identity.mjs');
    const { createInternalA2AControlPlane } = await import('../../src/providers/native-a2a-control-plane.mjs');
    const client = createInternalA2AControlPlane({ baseUrl: options.a2aControlPlaneUrl, tokenProvider: {
      getToken({ audience, assertCurrent }) { assertCurrent(); return requireToken(audience); },
    } });
    const tokens = {};
    for (const audience of ['a2a-registry', 'a2a-task-sink']) tokens[audience] = (await readFile(join(options.a2aTokenDirectory, audience + '.jwt'), 'utf8')).trim();
    function requireToken(audience) { if (!tokens[audience]) throw Error('Fixture token audience mismatch'); return tokens[audience]; }
    ctx.effect(() => () => client.close(), 'mounted inbound controlled registry transport');
    nativeA2aInbound = { card: { name: 'Mounted inbound', baseUrl: 'https://native.example' }, controlPlane: client,
      verifier: createA2aGatewayIdentityVerifier({ publicKeyPem: proof.publicKeyPem, targetBinding: proof.targetBinding }),
      ...(proof.executeNative ? {} : { events: { async *subscribe(sessionId, cursor) {
        await appendFile(join(options.directory, 'inbound-event-subscriptions.jsonl'), JSON.stringify({ pid: process.pid, sessionId, cursor }) + '\n');
        for (const row of proof.rows) if (row.seq > cursor) yield row;
      } } }), assertCurrent: () => ctx.fiber.uid !== null };
    if (proof.executeNative) {
      const { createNativeKernelPermitVerifier } = await import('../../src/providers/native-kernel-permit.mjs');
      const { createNativeModelPort } = await import('../../packages/agentkit-harness/src/native/model-port.mjs');
      const { configure } = await import('../../packages/agentkit-harness-core/dist/index.mjs');
      const { createStudioManagedNativeExecution } = await import('../../src/host/services/native-managed-execution.mjs');
      managedSessionId = proof.sessionId;
      if (!proof.formalBinding) {
        managedExecution = createStudioManagedNativeExecution({ ctx });
        ctx.effect(() => () => managedExecution.close(), 'verification managed Session owner');
      }
      const target = { tenantId: proof.targetBinding.tenantId, agentInstanceId: proof.targetBinding.agentId };
      const model = createNativeModelPort({ resolveProfile: async () => ({ protocol: 'openai-chat',
        baseUrl: options.a2aControlPlaneUrl + '/native-inbound-model', apiKey: 'controlled-inbound-model', model: 'inbound-model' }) });
      nativeManagedKernel = { target, assertCurrent: () => ctx.fiber.uid !== null,
        permitVerifier: createNativeKernelPermitVerifier({ target, verificationKeys: async () => ({ server: proof.kernelPublicKeyPem }) }),
        resolveBinding: async ({ command }) => ({ scope: { tenantId: target.tenantId, agentId: target.agentInstanceId,
          workspaceId: 'mounted-managed-workspace', userId: 'mounted-managed-user' }, buildId: 'mounted-managed-build',
          configuration: configure({ profile: { profileId: 'inbound-model', profileVersion: '1', providerFamily: 'openai-compatible',
            compatibilityDigest: 'mounted-inbound-model/v1' }, hostBindingDigest: 'mounted-inbound-host/v1',
            contract: { objective: 'Complete the admitted inbound request' }, inputMessages: [{ role: 'user', content: command.payload.content }],
            tools: [{ name: 'write_fixture', description: 'Write the proof file', parameters: { type: 'object', properties: {} },
              readOnly: false, concurrentSafe: false, permissions: [], timeoutMs: 2000,
              contextRole: 'none', observationRole: 'none', progressObservation: false, contextRetention: 'normal' }] }),
          withExecution: async request => {
            let result;
            try { result = await managedExecution.run(request); }
            catch (error) {
              await writeFile(join(options.directory, 'managed-owner-error.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
              throw error;
            }
            const found = await ctx.get('sessionController').resolveAgent(request.identity.sessionId);
            if (found.error) throw found.error;
            await appendFile(join(options.directory, 'managed-session-owner.jsonl'), JSON.stringify({ phase: 'closed', pid: process.pid,
              runId: result.runId, state: managedExecution.status(found.agent) }) + '\n');
            return result;
          },
          ports: { model, tools: { execute: async request => {
            request.signal.throwIfAborted();
            await appendFile(join(options.directory, 'inbound-native-effects.jsonl'), JSON.stringify({ pid: process.pid, callId: request.call.callId }) + '\n');
            return { status: 'ok', content: 'Durable proof file written' };
          } } },
        }),
      };
      if (proof.formalBinding) {
        delete nativeManagedKernel.resolveBinding;
        nativeManagedKernel.principal = { userId: 'mounted-managed-user' };
      }
    }
  }
  await mountStudioHost(ctx, {
    configurationHome: home,
    ...(nativeA2aInbound ? { nativeA2aInbound } : {}),
    ...(nativeManagedKernel ? { nativeManagedKernel } : {}),
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

  if (inboundProof?.crashBoundary) {
    const { installManagedNativeCrashFaults } = await import('./studio-native-managed-crash.mjs');
    installManagedNativeCrashFaults(ctx, { root: options.directory, sessionId: managedSessionId, boundary: inboundProof.crashBoundary });
  }
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
    if (nativeA2aInbound) await appendFile(join(options.directory, 'mounted-inbound-host.jsonl'), JSON.stringify({ pid: process.pid, origin }) + '\n');
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
    if (managedSessionId) {
      let managedAgent;
      if (source === 'resume') {
        const found = await ctx.get('sessionController').resolveAgent(managedSessionId);
        if (found.error) throw found.error;
        managedAgent = found.agent;
      } else {
        managedAgentHandle = await ctx.agents.create({ sessionId: managedSessionId,
          agentOptions: managedRecord ? { provider: 'agentkit-studio-inbound-fixture', model: 'inbound-model' }
            : { provider: 'agentkit-studio-fixture', model: 'main' }, meta: { cwd: workspaceRoot } });
        managedAgent = managedAgentHandle.agent;
        await ctx.agentPresets.select(managedAgent, managedRecord ? dshPresetId(managedRecord.metadata.id, 1) : presetId);
      }
      if (inboundProof?.structuredInput) {
        if (source === 'resume') {
          const previous = JSON.parse(await readFile(join(options.directory, 'managed-input-upload.json'), 'utf8'));
          await writeFile(join(options.directory, 'managed-input-cold.json'), JSON.stringify({ pid: process.pid,
            receiptAvailable: ctx.get('fileUploads').resolve(managedAgent, previous.receiptId) !== undefined }));
        } else {
          const { PNG } = await import('pngjs');
          const imageData = PNG.sync.write(new PNG({ width: 1, height: 1 })).toString('base64');
          const uploaded = await ctx.get('fileUploads').upload(managedAgent, {
            data: Buffer.from('Original managed file input.\n').toString('base64'), name: 'managed-input.txt' }, new AbortController().signal);
          const foreign = await ctx.get('fileUploads').upload(agent, {
            data: Buffer.from('Different Session private input.\n').toString('base64'), name: 'foreign-input.txt' }, new AbortController().signal);
          await writeFile(join(options.directory, 'managed-input-upload.json'), JSON.stringify({ receiptId: uploaded.receiptId,
            foreignReceiptId: foreign.receiptId, imageData }));
        }
      }
      const managedStatus = () => managedExecution ? managedExecution.status(managedAgent)
        : ctx.get('sessionProjections').stateOf(managedAgent.session, 'agentkitManagedNativeOwner');
      if (inboundProof?.formalBinding && source === 'resume')
        await writeFile(join(options.directory, 'managed-session-history-cold.json'), JSON.stringify(managedAgent.session.snapshotEvents()));
      await appendFile(join(options.directory, 'managed-session-owner.jsonl'), JSON.stringify({ phase: 'loaded', pid: process.pid,
        source, state: managedStatus() }) + '\n');
      if (managedRecord && (source !== 'resume' || inboundProof?.crashBoundary)) {
        let observed = false, draining = false;
        const observer = setInterval(() => {
          if (!inboundProof.crashBoundary && !draining && existsSync(join(options.directory, 'managed-command-accepted'))) {
            draining = true;
            void ctx.get('studioManagedNativeKernel').drain(managedSessionId).catch(error =>
              writeFile(join(options.directory, 'managed-owner-error.json'), JSON.stringify({ code: error.code, message: error.message, stack: error.stack })));
          }
          const state = managedStatus();
          if (observed || !state.lastClosed) return;
          observed = true;
          if (inboundProof.formalBinding) {
            const history = managedAgent.session.snapshotEvents();
            const persisted = { pid: process.pid, history, receiptAvailable: false };
            if (inboundProof.structuredInput) {
              const uploaded = JSON.parse(readFileSync(join(options.directory, 'managed-input-upload.json'), 'utf8'));
              persisted.receiptAvailable = ctx.get('fileUploads').resolve(managedAgent, uploaded.receiptId) !== undefined;
            }
            writeFileSync(join(options.directory, 'managed-session-history.json'), JSON.stringify(persisted));
          }
          appendFileSync(join(options.directory, 'managed-session-owner.jsonl'), JSON.stringify({ phase: 'closed', pid: process.pid,
            runId: JSON.parse(state.lastClosed.binding).identity.runId, state }) + '\n');
        }, 20);
        ctx.effect(() => () => clearInterval(observer), 'verification managed owner observation');
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
  if (managedRecord) ctx.on('approval/request', async request => {
    if (request.agent.session.id !== managedSessionId || request.toolName !== 'write_workspace_file') return;
    await appendFile(join(options.directory, 'managed-workspace-approvals.jsonl'), JSON.stringify({ pid: process.pid, callId: request.callId }) + '\n');
    return 'allowed-once';
  });
}
