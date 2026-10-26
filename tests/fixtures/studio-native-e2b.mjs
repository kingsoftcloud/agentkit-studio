/** Packed production E2B fixture. Uses the real installed JS SDK with a
 * refused endpoint and synthetic credentials; no SDK or transport substitution.
 * Cold startup verifies persisted configuration and restores the real preset.
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

export const name = 'studio-native-e2b-verification';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer'];

export async function apply(ctx, options) {
  try {
    await applyProof(ctx, options);
  } catch (error) {
    await writeFile(join(options.directory, 'e2b-fixture-error.json'),
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
      name: 'E2B Proof Agent',
      runtimeType: 'harness',
      spec: { context: { maxInputTokens: 8000, reserveOutputTokens: 256 } },
      bindings: {
        modelProfileIds: ['fixture'],
        nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} },
        tools: ['sandbox_status', 'component_status', 'run_command'],
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
  ctx.effect(() => () => { if (console.warn === captureWarning) console.warn = warn; }, 'Studio E2B verification warnings');

  await initializeFile(join(home, 'config.yaml'), JSON.stringify({
    modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'main',
      baseUrl: options.modelUrl, default: true, credentialName: 'E2B_PROOF_KEY' }],
    modelProfileKeys: { E2B_PROOF_KEY: 'e2b-proof-model-key' },
  }), { mode: 0o600 });

  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, {
    configurationHome: home,
    nativeHookRegistrations: [],
    env: {
      AGENTKIT_HOME: home,
      AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
      AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1',
      KSADK_SANDBOX_BACKEND: 'e2b', KSADK_SANDBOX_TEMPLATE_ID: 'e2b-proof-template-0001',
      KSADK_SANDBOX_TIMEOUT: '60', KSADK_SANDBOX_TYPE: 'aio',
      E2B_API_URL: 'https://127.0.0.1:9', E2B_DOMAIN: 'e2b-proof.synthetic',
      E2B_API_KEY: 'e2b-proof-key-do-not-use', KSADK_TRAFFIC_SOURCE: 'agentkit-proof',
    },
  });

  const presetId = dshPresetId(record.metadata.id, record.metadata.revision, record.buildId || '');

  ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
    providerInfo: provider => ({ id: provider, name: 'E2B proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'main', name: 'main' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during Native E2B execution'); },
  });

  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== 'e2b-proof-session') return;
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
    const unknownResults = history.filter(event => event.type === 'tool/result').flatMap(event => {
      try {
        const content = JSON.parse(event.data.message.content.find(block => block.type === 'text').text);
        return content.error_type === 'e2b_sandbox_outcome_unknown'
          ? [{ content, isError: event.data.message.isError }] : [];
      } catch { return []; }
    });
    await appendFile(join(options.directory, 'mounted-host-http.jsonl'), JSON.stringify({
      source, pid: process.pid, sessionId: agent.session.id, agentId: record.metadata.id, presetId,
      unauthorizedStatus: unauthorized.status, compatible: true, historyEvents: history.length,
      historyHasOriginalGoal: JSON.stringify(history).includes('Inspect the E2B binding, then run the probe command.'),
      historyHasUnknown: JSON.stringify(history).includes('e2b_sandbox_outcome_unknown'),
      unknownResults,
      historyHasTurnEnd: history.some(event => event.type === 'turn/end'),
      historyHasOwnedTurn: history.some(event => event.type === 'turn/owner'
        && event.data.contract === 'dsh.external-turn/v1'
        && event.data.engine === 'agentkit.native-dsh-turn/v1'),
    }) + '\n');
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent.session.id === 'e2b-proof-session') {
      await appendFile(join(options.directory, 'tool-admissions.jsonl'),
        JSON.stringify({ callId: exec.callId, name: exec.name, arguments: exec.arguments }) + '\n');
    }
    return next();
  });
}
