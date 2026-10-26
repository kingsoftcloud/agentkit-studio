/**
 * Test fixture for verify-studio-native-vision: mounts the production Studio
 * Host from the packed archive with a vision-capable Agent spec, real DSH SDK
 * preset/ToolRegistry/SessionController (full mounted host with authenticated
 * HTTP control RPC and production preset admission), deterministic local model
 * HTTP SSE for both the primary text model and the vision observer model, and a
 * real browser (Chromium) backend via the Native browser owner.
 *
 * The fixture creates an Agent spec with:
 *   bindings.modelProfileIds = ['fixture']       (text-only primary, modelName 'main')
 *   bindings.visionModelProfileId = 'observer'   (image-capable observer)
 *   bindings.tools = ['browser_inspect_workspace']
 *   runtime.type = 'harness'                     (Native entry)
 *
 * The mounted Host wires the ledger-owned vision binding: the browser owner
 * screenshots the page via real Chromium, the observer model receives the
 * data:image and returns a fixed untrusted caption, and the primary model
 * receives the text-only caption (no image media) and completes.
 *
 * The verify script's session.run() enters the real DSH lifecycle and delegates
 * the complete execution loop to Native; this fixture mounts the Host, admits
 * the preset, and
 * registers tool admission logging. It does NOT call host.executeTurn directly.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';

async function initializeFile(path, text, options = {}) {
  try {
    if (await readFile(path, 'utf8') !== text) throw Error('Persisted fixture input changed: ' + path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(path, text, { ...options, flag: 'wx' });
  }
}

export const name = 'studio-native-vision-verification';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer'];

export async function apply(ctx, options) {
  try {
    await applyProof(ctx, options);
  } catch (error) {
    await writeFile(join(options.directory, 'vision-fixture-error.json'),
      JSON.stringify({ code: error.code, message: error.message, stack: error.stack }));
    throw error;
  }
}

async function applyProof(ctx, options) {
  await appendFile(join(options.directory, 'host-processes.jsonl'),
    JSON.stringify({ pid: process.pid, ppid: process.ppid, node: process.version, path: process.env.PATH }) + '\n');
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    appendFileSync(join(options.directory, 'assistant-stream.jsonl'),
      JSON.stringify({ session: agent.session.id, frame }) + '\n');
  });

  const workspaceRoot = join(options.directory, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(join(workspaceRoot, 'app'), { recursive: true });
  await initializeFile(join(workspaceRoot, 'app/index.html'),
    '<!doctype html><html><head><title>Vision Proof</title></head><body>' +
    '<h1>Login Form</h1><form><input type="text" placeholder="Username"/>' +
    '<input type="password" placeholder="Password"/><button type="submit">Login</button></form></body></html>');

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
      name: 'Vision Proof Agent',
      runtimeType: 'harness',
      spec: { context: { maxInputTokens: 8000, reserveOutputTokens: 256 } },
      bindings: {
        modelProfileIds: ['fixture'],
        nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} },
        visionModelProfileId: 'observer',
        tools: ['browser_inspect_workspace'],
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
  ctx.effect(() => () => { if (console.warn === captureWarning) console.warn = warn; }, 'Studio vision verification warnings');

  // Two model profiles: the primary (text-only, default) and the observer
  // (image-capable). The primary profile id is 'fixture' so dshModelRoute maps
  // it to 'agentkit-studio-fixture', matching the harness provider; its
  // modelName 'main' is what the HTTP server routes on. The observer declares
  // input:['text','image'] so the Host's nativeVisionProfileId invariant
  // (visionDescription.input includes 'image') holds and the vision binding
  // captions screenshots through it.
  await initializeFile(join(home, 'config.yaml'), JSON.stringify({
    modelProfiles: [
      { id: 'fixture', provider: 'openai-compatible', modelName: 'main',
        baseUrl: options.modelUrl, default: true, credentialName: 'STUDIO_NATIVE_VISION_KEY' },
      { id: 'observer', provider: 'openai-compatible', modelName: 'observer',
        baseUrl: options.modelUrl, input: ['text', 'image'], credentialName: 'STUDIO_NATIVE_VISION_KEY' },
    ],
    modelProfileKeys: { STUDIO_NATIVE_VISION_KEY: 'sk-studio-vision-secret' },
  }), { mode: 0o600 });

  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, {
    configurationHome: home,
    nativeHookRegistrations: [],
    env: {
      AGENTKIT_HOME: home,
      AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
      AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1',
      AGENTKIT_STUDIO_NATIVE_CHROMIUM_EXECUTABLE: options.chromium,
    },
  });

  const presetId = dshPresetId(record.metadata.id, record.metadata.revision, record.buildId || '');

  // Default-engine adapter for any non-Native (default-session) delegation.
  let delegate = false;
  ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'Studio Native vision proof' }),
    providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'main', name: 'main' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => {
      if (!delegate) throw Error('DSH model loop entered during Studio Native vision execution');
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
    if (agent.session.id !== 'vision-session') return;
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
    await appendFile(join(options.directory, 'mounted-host-http.jsonl'), JSON.stringify({
      source, pid: process.pid, sessionId: agent.session.id, agentId: record.metadata.id, presetId,
      unauthorizedStatus: unauthorized.status, compatible: true, historyEvents: history.length,
      historyHasAnswer: JSON.stringify(history).includes('I can see a login form on the page.'),
      historyHasCompletedTurn: history.some(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed'),
    }) + '\n');
  });

  ctx.on('agent/execute-turn', async (payload, next) => {
    if (payload.agent.session.id === 'default-session') delegate = true;
    return next();
  });

  // The Native tool port re-enters ctx.tools.execute, so pre-execute fires for
  // the browser tool. Log the admission; never deny the browser tool here.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent.session.id === 'vision-session') {
      await appendFile(join(options.directory, 'tool-admissions.jsonl'),
        JSON.stringify({ callId: exec.callId, name: exec.name, arguments: exec.arguments }) + '\n');
    }
    return next();
  });
}
