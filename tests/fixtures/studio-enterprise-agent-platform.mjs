/** Enterprise business + coding Agent vertical acceptance instrumentation.

  This fixture is instrumentation that drives the real product control plane.
  It never creates a record by direct store access, never supplies an
  alternative executor, and never synthesizes a production record. Every
  Agent, Build and preset admission is performed over the real authenticated
  /agentkit HTTP control plane (routes/http.mjs connection.admit) — the same
  routes the Studio UI uses — from inside the mounted Host process, because
  /connect authentication is owned by the Host connection service
  (ctx.connection.authenticatedUrl). The fixture additionally mounts the SAME
  trusted production Host, registers the sentinel DSH model adapter whose
  prepareCall is the entry point of the legacy DSH loop (reaching it proves that
  loop ran, which the Native Harness must prevent), wires the real local MCP
  resource adapter, and selects the preset each Session should run. */
import { appendFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLocalResourceAdapters } from '../../src/local-resource-adapters.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';

export const name = 'studio-enterprise-agent-platform-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'connection', 'webServer'];

const BUSINESS_SESSION = 'enterprise-business';
const FROZEN_SESSION = 'enterprise-frozen-business';
const CODING_SESSION = 'enterprise-coding';
const BUSINESS_ORIGINAL_SYSTEM = 'BUSINESS_ORIGINAL_SYSTEM';
const BUSINESS_EDITED_SYSTEM = 'BUSINESS_EDITED_SYSTEM';
const CODING_SYSTEM = 'CODING_AGENT_SYSTEM';
const strictPolicy = { contract: 'agentkit.native-agent-policy/v1', mode: 'strict', rules: {} };

export async function apply(ctx, options) {
  const root = options.directory;
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });

  await writeFile(join(root, 'config.yaml'), JSON.stringify({
    modelProfiles: [{ id: 'fixture', provider: 'openai-compatible', modelName: 'pinned',
      baseUrl: options.modelUrl, default: true, credentialName: 'ENTERPRISE_FIXTURE_KEY' }],
    modelProfileKeys: { ENTERPRISE_FIXTURE_KEY: 'local-enterprise-fixture-key' },
  }), { mode: 0o600 });

  let sentinelAttempts = 0;
  const registerSentinel = () => {
    // Sentinel DSH model adapter. For runtimeType 'harness' the production Native
    // Harness (agentkit.native-dsh-turn/v1) replaces the whole turn and calls the
    // bound OpenAI-compatible profile directly; the DSH legacy loop must never
    // run. prepareCall is that loop's entry point, so reaching it is a failure.
    ctx.llm.registerAdapter(['agentkit-studio-fixture'], {
      providerInfo: provider => ({ id: provider, name: 'Enterprise sentinel' }),
      providerRetryPolicy: () => undefined,
      listModels: async provider => [{ provider, id: 'pinned', name: 'pinned' }],
      resolveModel: (provider, model) => ({ provider, id: model, name: model }),
      prepareCall: () => {
        sentinelAttempts += 1;
        appendFileSync(join(root, 'sentinel-attempts.jsonl'), JSON.stringify({ pid: process.pid, attempt: sentinelAttempts }) + '\n');
        throw Error('DSH default model loop entered during Enterprise Native execution; the Native Harness must own the whole turn');
      },
    });
  };
  ctx.effect(() => () => { writeFileSync(join(root, 'sentinel-total.json'), JSON.stringify({ attempts: sentinelAttempts })); }, 'Enterprise sentinel total');

  const { mountStudioHost } = await import('@kingsoftcloud/agentkit-studio/host-bootstrap');
  await mountStudioHost(ctx, {
    configurationHome: root,
    ...(options.mcpUrl ? {
      resourceAdapterFactory: deps => createLocalResourceAdapters({ ...deps,
        // The only instrumentation injected into the resource graph: route the
        // bound 'enterprise-crm' resource id at the real local MCP HTTP server
        // the verifier script runs. Discovery and execution stay in production.
        resourceStore: { get: async id => ['enterprise-crm', 'enterprise-crm-live'].includes(id)
          ? { resourceId: id, endpointUrl: options.mcpUrl + (id.endsWith('-live') ? '-live' : '-frozen') } : undefined } }),
    } : {}),
    env: {
      AGENTKIT_HOME: root,
      AGENTKIT_STUDIO_WORKSPACE: workspaceRoot,
      // runtimeType 'harness' is the Studio Native engine contract; 'dsh-native'
      // is DSH's separate engine. Pin the Native Harness whole-turn contract.
      AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1',
    },
  });
  // Register the sentinel AFTER mount so it lands on the same llm service the
  // bootstrap just wired its runtime adapter into (matches the proven fixtures).
  registerSentinel();

  // ---- Real authenticated /agentkit control-plane admission ----
  // The Host owns /connect authentication. Issue every admission through the
  // real HTTP routes; no direct store/build/admission calls are made here.
  let admission;
  const admit = () => admission ??= admitThroughHttp();
  async function admitThroughHttp() {
    const origin = ctx.webServer.getOrigin();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (login.status !== 302) throw Error(`Enterprise Host /connect authentication failed: ${login.status}`);
    // Credential held in memory only; never written or printed.
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method, payload = {}) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload, rpcId: method }), signal: AbortSignal.timeout(20000) });
      const result = (await response.json()).result;
      if (response.status !== 200 || !result?.ok) throw Error(`RPC ${method} failed: ${result?.error?.code} ${result?.error?.message}`);
      return result.value;
    };
    // Unauthenticated control RPC must be rejected by connection.admit.
    const unauthorized = await fetch(origin + '/agentkit', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'host/compatibility', payload: {} }), signal: AbortSignal.timeout(5000) });
    if (unauthorized.status !== 401) throw Error('Host accepted unauthenticated control RPC');
    await unauthorized.text();

    const saved = await readFile(join(root, 'identity.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (saved) {
      for (const entry of Object.values(saved)) {
        const existing = await rpc('agents/local-get', { agentId: entry.agentId });
        if (!existing) throw Error('Persisted Agent disappeared');
        const admitted = await rpc('agents/ensure-preset', { agentId: entry.agentId, ...(entry.buildId ? { buildId: entry.buildId } : {}) });
        if (admitted.presetId !== entry.presetId) throw Error('Cold admission changed the preset identity');
      }
      return saved;
    }

    // 1) Create two local Agents via the real create-local route (no templateSource
    //    => the route's templateAuthoring.create falls through to store.create).
    const business = await rpc('agents/create-local', { name: 'Enterprise CRM approval Agent', runtimeType: 'harness',
      description: 'Enterprise business agent bound to a real local CRM MCP tool',
      spec: { execution: { nativeTodoMode: 'off', nativePlanMode: 'off', nativeToolSearchMode: 'off' }, instructions: { system: BUSINESS_ORIGINAL_SYSTEM }, runtime: { type: 'harness' },
        bindings: { modelProfileIds: ['fixture'], mcpServers: ['enterprise-crm'], nativeAgentPolicy: strictPolicy } },
      bindings: { modelProfileIds: ['fixture'], mcpServers: ['enterprise-crm'], nativeAgentPolicy: strictPolicy } });
    const businessAgentId = business.metadata.id;
    const coding = await rpc('agents/create-local', { name: 'Enterprise coding Agent', runtimeType: 'harness',
      description: 'Enterprise coding agent bound to workspace read/write tools',
      spec: { execution: { nativeTodoMode: 'off', nativePlanMode: 'off', nativeToolSearchMode: 'off' }, instructions: { system: CODING_SYSTEM }, runtime: { type: 'harness' },
        bindings: { modelProfileIds: ['fixture'], tools: ['read_workspace_file', 'write_workspace_file', 'edit_workspace_file'], nativeAgentPolicy: strictPolicy } },
      bindings: { modelProfileIds: ['fixture'], tools: ['read_workspace_file', 'write_workspace_file', 'edit_workspace_file'], nativeAgentPolicy: strictPolicy } });
    const codingAgentId = coding.metadata.id;

    // 2) Create an immutable Build of the business Agent at revision 1 (captures
    //    BUSINESS_ORIGINAL_SYSTEM) via the real builds/create route, then observe
    //    the operation completing through operations/list and the build via builds/list.
    const buildOp = await rpc('builds/create', { agentId: businessAgentId, revision: 1 });
    if (!buildOp.operationId) throw Error('builds/create returned no operationId');
    let buildId = buildOp.buildId || null;
    for (let deadline = Date.now() + 15000; Date.now() < deadline && !buildId;) {
      const list = await rpc('builds/list', { agentId: businessAgentId });
      buildId = list.items?.[0]?.id || null;
      if (!buildId) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!buildId) throw Error('Frozen build never completed');
    let completed = false;
    for (let deadline = Date.now() + 15000; Date.now() < deadline && !completed;) {
      const operations = await rpc('operations/list', { resourceId: businessAgentId, kind: 'build' });
      const operation = operations.items?.find(op => op.id === buildOp.operationId);
      if (operation?.status === 'failed') throw Error('Product Build failed');
      completed = operation?.status === 'succeeded';
      if (!completed) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!completed) throw Error('Build operation never reported succeeded');
    await appendFile(join(root, 'admission-rpc.jsonl'), JSON.stringify({ step: 'build', operationId: buildOp.operationId, buildId, status: 'succeeded' }) + '\n');

    // 3) Edit the live Agent AFTER the Build via the real update-local route with
    //    expectedRevision (optimistic concurrency). The live record moves to
    //    revision 2 with BUSINESS_EDITED_SYSTEM; the Build keeps the original.
    const updated = await rpc('agents/update-local', { agentId: businessAgentId, expectedRevision: 1,
      spec: { execution: { nativeTodoMode: 'off', nativePlanMode: 'off', nativeToolSearchMode: 'off' }, instructions: { system: BUSINESS_EDITED_SYSTEM }, runtime: { type: 'harness' },
        bindings: { modelProfileIds: ['fixture'], mcpServers: ['enterprise-crm-live'], nativeAgentPolicy: strictPolicy } },
      bindings: { modelProfileIds: ['fixture'], mcpServers: ['enterprise-crm-live'], nativeAgentPolicy: strictPolicy } });
    if (Number(updated.metadata.revision) !== 2) throw Error(`update-local did not advance revision: ${updated.metadata.revision}`);

    // 4) Admit three presets via the real ensure-preset route: business-live (no
    //    buildId, revision 2 EDITED), business-frozen (immutable buildId, revision
    //    1 ORIGINAL) and coding-live (no buildId). Assert each preset id.
    const livePresetId = dshPresetId(businessAgentId, 2, '');
    const frozenPresetId = dshPresetId(businessAgentId, 1, buildId);
    const codingPresetId = dshPresetId(codingAgentId, 1, '');
    const admittedLive = await rpc('agents/ensure-preset', { agentId: businessAgentId });
    if (admittedLive.presetId !== livePresetId) throw Error(`live preset id mismatch: ${admittedLive.presetId} !== ${livePresetId}`);
    const admittedFrozen = await rpc('agents/ensure-preset', { agentId: businessAgentId, buildId });
    if (admittedFrozen.presetId !== frozenPresetId) throw Error(`frozen preset id mismatch: ${admittedFrozen.presetId} !== ${frozenPresetId}`);
    const admittedCoding = await rpc('agents/ensure-preset', { agentId: codingAgentId });
    if (admittedCoding.presetId !== codingPresetId) throw Error(`coding preset id mismatch: ${admittedCoding.presetId} !== ${codingPresetId}`);
    // Confirm the live record now carries the edited instruction (edit took effect).
    const liveGet = await rpc('agents/local-get', { agentId: businessAgentId });
    if (liveGet.metadata.revision !== 2 || liveGet.spec?.instructions?.system !== BUSINESS_EDITED_SYSTEM)
      throw Error('agents/local-get did not reflect the edited live Agent');

    await appendFile(join(root, 'admission-rpc.jsonl'), JSON.stringify({ step: 'ensure-preset', livePresetId, frozenPresetId, codingPresetId, businessAgentId, codingAgentId, buildId }) + '\n');
    const identity = {
      business: { role: 'business', agentId: businessAgentId, revision: 2, presetId: livePresetId, sessionId: BUSINESS_SESSION },
      frozen: { role: 'frozen-business', agentId: businessAgentId, revision: 1, presetId: frozenPresetId, sessionId: FROZEN_SESSION, buildId },
      coding: { role: 'coding', agentId: codingAgentId, revision: 1, presetId: codingPresetId, sessionId: CODING_SESSION },
    };
    await writeFile(join(root, 'identity.json'), JSON.stringify(identity));
    await appendFile(join(root, 'host-ready.json'), JSON.stringify({ pid: process.pid, origin, mounted: true, admitted: true }) + '\n');
    return identity;
  }

  // ---- Session/preset selection + observation ----
  const identityFile = join(root, 'identity.json');
  const readIdentity = async () => { try { return JSON.parse(await readFile(identityFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } };
  const entryFor = (identity, sessionId) => identity ? Object.values(identity).find(v => v && v.sessionId === sessionId) : undefined;

  ctx.on('agent/created', async ({ agent, source }) => {
    const identity = await admit();
    const entry = entryFor(identity, agent.session.id);
    if (!entry) return;
    const deadline = Date.now() + 15000;
    let rows;
    while (!rows) {
      try { rows = await ctx.agentPresets.pluginsFor(entry.presetId); }
      catch (error) { if (error.code !== 'agent-preset/not-found' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    if (!rows.some(row => row.name === '@kingsoftcloud/agentkit-studio/dsh-runtime-plugin'
        && row.config?.nativeEngineContract === 'agentkit.native-dsh-turn/v1'))
      throw Error(`Production Native preset was not admitted for ${entry.role}`);
    if (source === 'resume') {
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== entry.presetId)
        throw Error('Resumed session lost its persisted Native preset identity');
      await ctx.agentPresets.recompose(agent.ctx, entry.presetId);
    } else {
      await ctx.agentPresets.select(agent, entry.presetId);
      // A mutable permissive Session must not erase the frozen strict Agent
      // policy. The real ToolRegistry still produces one approval per effect.
      setSandboxMode(agent.session, 'danger-full-access');
    }
    appendFileSync(join(root, 'session-loads.jsonl'), JSON.stringify({ role: entry.role, source, sessionId: agent.session.id, presetId: entry.presetId, pid: process.pid }) + '\n');
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const identity = await readIdentity();
    const entry = entryFor(identity, exec.agent.session.id);
    if (entry) appendFileSync(join(root, 'tool-admissions.jsonl'), JSON.stringify({ role: entry.role, name: exec.name, callId: exec.callId, sessionId: exec.agent.session.id }) + '\n');
    return next();
  });

  // Deterministic human approval for the bound tools, through the real
  // ApprovalService (its durable asked/decided events are still produced).
  ctx.on('approval/request', async request => {
    const identity = await readIdentity();
    if (entryFor(identity, request.agent.session.id)) return 'allowed-once';
  }, { prepend: true });
}
