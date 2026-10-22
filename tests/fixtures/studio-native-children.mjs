import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createAgentStore } from '../../src/agent-store.mjs';
import { dshPresetId } from '../../src/agent-preset-admission.mjs';
import { mountStudioHost } from '../../src/host/bootstrap.mjs';

export const name = 'studio-native-children-proof';
export const inject = ['llm', 'sessions', 'sessionProjections', 'agents', 'agentPresets', 'credentials', 'connection', 'webServer'];
export async function apply(ctx, options) {
  const home = options.directory, workspaceRoot = join(home, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'proof.txt'), 'Evidence from the actual child workspace');
  await writeFile(join(home, 'config.yaml'), JSON.stringify({ modelProfiles: [
    { id: 'parent-profile', provider: 'openai-compatible', modelName: 'parent-proof', baseUrl: options.modelUrl, default: true,
      credentialName: 'CHILD_PROOF_KEY' },
    { id: 'child-profile', provider: 'openai-compatible', modelName: 'child-proof', baseUrl: options.modelUrl, credentialName: 'CHILD_PROOF_KEY' },
  ], modelProfileKeys: { CHILD_PROOF_KEY: 'child-proof-secret' } }), { mode: 0o600 });
  const agents = createAgentStore({ storeDir: join(home, 'studio/agents') });
  let record;
  try { const saved = JSON.parse(await readFile(join(home, 'identity.json'), 'utf8')); record = await agents.get(saved.agentId); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!record) {
    record = await agents.create({ name: 'Native child proof', runtimeType: 'harness', spec: {
      subAgents: [options.writingRecovery
        ? { name: 'writer', instructions: 'CHILD_WORKSPACE_WRITER: write child.txt in the isolated child workspace and report completion.',
          tools: ['read_workspace_file', 'write_workspace_file'], modelProfileId: 'child-profile',
          inheritMcp: Boolean(options.mcpUrl), maxTurns: options.mcpUrl ? 5 : 4, maxToolCalls: options.mcpUrl ? 3 : 2 }
        : { name: 'reader', instructions: 'CHILD_WORKSPACE_READER: read proof.txt and report its evidence.',
          tools: ['read_workspace_file'], modelProfileId: 'child-profile', maxTurns: 3, maxToolCalls: 2 }],
      bindings: { tools: options.writingRecovery ? ['read_workspace_file', 'write_workspace_file'] : ['read_workspace_file'],
        ...(options.mcpUrl ? { mcpServers: ['child-proof-mcp'] } : {}),
        modelProfileIds: ['parent-profile', 'child-profile'] },
    } });
    await writeFile(join(home, 'identity.json'), JSON.stringify({ agentId: record.metadata.id }));
  }
  const resourceOptions = options.mcpUrl ? { resourceAdapterFactory: deps =>
    import('../../src/local-resource-adapters.mjs').then(({ createLocalResourceAdapters }) => createLocalResourceAdapters({
      ...deps, resourceStore: { get: id => id === 'child-proof-mcp'
        ? { resourceId: id, endpointUrl: options.mcpUrl } : deps.resourceStore?.get(id) },
    })) } : {};
  await mountStudioHost(ctx, { configurationHome: home, ...resourceOptions, env: { AGENTKIT_HOME: home,
    AGENTKIT_STUDIO_WORKSPACE: workspaceRoot, AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1' } });
  const presetId = dshPresetId(record.metadata.id, record.metadata.revision);
  let activeAgent;
  const authenticate = async () => {
    const origin = ctx.webServer.getOrigin();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (login.status !== 302) throw Error('Child proof authentication failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await writeFile(join(home, 'control-auth.json'), JSON.stringify({ origin, cookie }), { mode: 0o600 });
    return { origin, cookie };
  };
  // The real SessionController must be callable before reconstructing an agent.
  if (options.writingRecovery) await authenticate();
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== 'native-child-parent') return;
    activeAgent = agent;
    const { origin, cookie } = await authenticate();
    const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'agents/ensure-preset', payload: { agentId: record.metadata.id } }) });
    const result = (await response.json()).result;
    if (response.status !== 200 || !result?.ok || result.value.presetId !== presetId) throw Error('Child proof preset admission failed');
    await writeFile(join(home, 'control-auth.json'), JSON.stringify({ origin, cookie }), { mode: 0o600 });
    const deadline = Date.now() + 15000;
    while (true) {
      try { await ctx.agentPresets.pluginsFor(presetId); break; }
      catch (error) { if (error.code !== 'agent-preset/not-found' || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    if (source === 'resume') {
      if (ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== presetId) throw Error('Child proof persisted preset changed');
      await ctx.agentPresets.recompose(agent.ctx, presetId);
    } else await ctx.agentPresets.select(agent, presetId);
  });
  // Any entry into the DSH model loop would violate Native loop ownership.
  ctx.llm.registerAdapter(['agentkit-studio-parent-profile'], {
    providerInfo: provider => ({ id: provider, name: 'Native child proof' }), providerRetryPolicy: () => undefined,
    listModels: async provider => [{ provider, id: 'parent-proof', name: 'parent-proof' }],
    resolveModel: (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: () => { throw Error('DSH model loop entered during Native child proof'); },
  });
  if (options.writingRecovery) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent.session.id === 'native-child-parent') await appendFile(join(home, 'tool-admissions.jsonl'),
        JSON.stringify({ name: exec.name, arguments: exec.arguments, callId: exec.callId }) + '\n');
      return next();
    });
    const { SqliteRunStore } = await import('../../packages/agentkit-harness/src/native/sqlite-store.mjs');
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex'),
      userId: 'local-user', agentId: record.metadata.id };
    const childScope = { ...scope, agentId: `${scope.agentId}:child:writer` };
    const marker = join(home, 'child-write-crash.json');
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || !activeAgent || existsSync(marker) || !existsSync(join(home, 'crash-requested'))) return;
      checking = true;
      let ledger;
      try {
        ledger = new SqliteRunStore(join(home, 'studio/native-harness/runs.sqlite'));
        const parent = ledger.sessionHead(scope, 'native-child-parent');
        const child = ledger.list(childScope).at(-1);
        if (!parent || !child) return;
        const parentRecord = ledger.load(scope, parent.runId), childRecord = ledger.load(childScope, child.runId);
        const pendingModel = row => row.intents.some(intent => intent.operationKey === row.snapshot.pendingIntent
          && intent.kind === 'model' && intent.status === 'running');
        const committedWrite = childRecord.intents.some(intent => intent.kind === 'tool'
          && intent.payload.calls?.length === 1 && intent.payload.calls[0].name === 'write_workspace_file'
          && intent.payload.calls[0].arguments.path === 'child.txt'
          && childRecord.receipts.some(receipt => receipt.operationKey === intent.operationKey && receipt.status === 'committed'
            && receipt.result.results?.[0]?.status === 'ok' && receipt.result.results[0].content?.ok === true));
        const committedMcp = !options.mcpUrl || childRecord.intents.some(intent => intent.kind === 'tool'
          && intent.payload.calls?.length === 1 && intent.payload.calls[0].name === 'remote_proof'
          && childRecord.receipts.some(receipt => receipt.operationKey === intent.operationKey && receipt.status === 'committed'
            && receipt.result.results?.[0]?.status === 'ok'
            && receipt.result.results[0].content?.structuredContent?.receipt_id === 'remote-once-1'));
        const unknownMcp = options.mcpUnknown && existsSync(join(home, 'remote-effect.json'))
          && childRecord.intents.some(intent => intent.operationKey === childRecord.snapshot.pendingIntent
            && intent.kind === 'tool' && intent.status === 'running'
            && intent.payload.calls?.length === 1 && intent.payload.calls[0].name === 'remote_proof');
        if (!pendingModel(parentRecord) || !committedWrite
          || !(options.mcpUnknown ? unknownMcp : pendingModel(childRecord) && committedMcp)) return;
        if (await ctx.sessions.flush(activeAgent.session) !== true) throw Error('Child proof Session flush was not durable');
        const events = activeAgent.session.snapshotEvents();
        if (!events.some(event => event.type === 'turn/owner') || events.some(event => event.type === 'turn/end'))
          throw Error('Child proof did not stop inside the original owned turn');
        writeFileSync(marker, JSON.stringify({ pid: process.pid, parent: parentRecord, child: childRecord, events }));
        const fd = openSync(marker, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
        process.exit(37); // Deliberately bypass all Kernel/Host/child cleanup.
      } catch (error) {
        writeFileSync(join(home, 'child-write-crash-error.txt'), String(error.stack)); process.exit(38);
      } finally { ledger?.close(); checking = false; }
    }, 20);
    ctx.effect(() => () => clearInterval(timer), 'Child writing recovery crash injection');
  }
}
