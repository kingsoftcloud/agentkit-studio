import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  let grantProof;
  const a2aProof = options.managedA2aProofPath ? JSON.parse(await readFile(options.managedA2aProofPath, 'utf8')) : null;
  if (options.managedProofPath || options.taskControls || options.editMatching || options.structuredPatch || options.conversationRewindProof || options.commandWorkspace) await appendFile(join(home, 'host-processes.jsonl'), JSON.stringify({ pid: process.pid,
    node: process.version, path: process.env.PATH }) + '\n');
  await mkdir(workspaceRoot, { recursive: true });
  if (!existsSync(join(workspaceRoot, 'proof.txt'))) await writeFile(join(workspaceRoot, 'proof.txt'), 'Evidence from the actual child workspace');
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
      subAgents: [a2aProof
        ? { name: 'reader', instructions: 'CHILD_A2A_RESEARCHER: ask the bound remote agent and report its exact reply.',
          tools: ['call_a2a_agent'], modelProfileId: 'child-profile', maxTurns: 3, maxToolCalls: 2 }
        : options.writingRecovery
        ? { name: 'writer', instructions: 'CHILD_WORKSPACE_WRITER: write child.txt in the isolated child workspace and report completion.',
          tools: ['read_workspace_file', 'write_workspace_file'], modelProfileId: 'child-profile',
          inheritMcp: Boolean(options.mcpUrl), maxTurns: options.mcpUrl ? 5 : 4, maxToolCalls: options.mcpUrl ? 3 : 2 }
        : { name: 'reader', instructions: 'CHILD_WORKSPACE_READER: read proof.txt and report its evidence.',
          tools: ['read_workspace_file', ...(options.commandWorkspace ? ['run_command'] : []), ...(options.childPlanMode ? ['write_workspace_file'] : []),
            ...(options.editMatching ? ['edit_workspace_file', 'multi_edit_workspace_file'] : []),
            ...(options.structuredPatch ? ['apply_workspace_patch'] : []),
            ...(options.workspaceRewind ? ['list_workspace_checkpoints', 'preview_workspace_rewind', 'rewind_workspace_files'] : [])], modelProfileId: 'child-profile', maxTurns: options.taskControls || options.workspaceRewind ? 5 : 3, maxToolCalls: options.taskControls || options.workspaceRewind ? 4 : 2 }],
      bindings: { nativeAgentPolicy: { contract: 'agentkit.native-agent-policy/v1', mode: 'loose', rules: {} },
        tools: a2aProof ? ['call_a2a_agent'] : options.structuredPatch ? ['read_workspace_file', 'apply_workspace_patch',
        ...(options.workspaceRewind ? ['list_workspace_checkpoints', 'preview_workspace_rewind', 'rewind_workspace_files'] : [])]
        : options.editMatching ? ['read_workspace_file', 'edit_workspace_file', 'multi_edit_workspace_file']
        : options.writingRecovery || options.childPlanMode ? ['read_workspace_file', 'write_workspace_file']
          : options.commandWorkspace ? ['read_workspace_file', 'run_command'] : ['read_workspace_file'],
        ...(a2aProof ? { a2a: a2aProof.bindings } : {}),
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
  let nativeManagedKernel;
  if (options.managedProofPath) {
    const proof = JSON.parse(await readFile(options.managedProofPath, 'utf8'));
    grantProof = proof.executionGrants === true;
    const target = { tenantId: 'managed-child-tenant', agentInstanceId: record.metadata.id };
    const { createNativeKernelPermitVerifier } = await import('../../src/providers/native-kernel-permit.mjs');
    nativeManagedKernel = { target, principal: { userId: 'managed-child-user' }, assertCurrent: () => ctx.fiber.uid !== null,
      ...(a2aProof?.serverInput ? { authorizeInteraction: ({ command, pending }) =>
        command.payload.token_ref === 'managed-input-token' && command.payload.interaction_id === pending.interactionId } : {}),
      ...(a2aProof ? { onWorkerError: ({ sessionId, error }) => writeFileSync(join(home, 'managed-worker-error.json'),
        JSON.stringify({ pid: process.pid, sessionId, code: error.code, message: error.message, stack: error.stack })) } : {}),
      permitVerifier: createNativeKernelPermitVerifier({ target, verificationKeys: async () => ({ server: proof.publicKeyPem }) }) };
  }
  await mountStudioHost(ctx, { configurationHome: home, ...resourceOptions,
    ...(nativeManagedKernel ? { nativeManagedKernel } : {}), env: { AGENTKIT_HOME: home,
    AGENTKIT_STUDIO_WORKSPACE: workspaceRoot, AGENTKIT_STUDIO_NATIVE_HARNESS: 'agentkit.native-dsh-turn/v1',
    ...(a2aProof?.env ?? {}) } });
  if (grantProof) {
    // Test-only trusted Host composition. No production route or workspace
    // option installs this file driver, creates grants or supplies authority.
    const runtime = ctx.studioManagedNativeKernel, grants = runtime.executionGrants;
    const specifications = Object.fromEntries(['send', 'cancel', 'promote', 'discard'].map(action => [action, {
      grant_id: `sdk-occurrence/${action}`, tenant_id: 'managed-child-tenant', agent_instance_id: record.metadata.id,
      session_id: 'native-child-parent', owner_ref: `trusted-proof/${action}`, attempt_epoch: action === 'cancel' ? 7 : null,
    }]));
    for (const [action, spec] of Object.entries(specifications)) {
      grants.ensure(spec, action === 'cancel' ? { expires_at: new Date(Date.now() + 600000).toISOString() } : {});
      if (action === 'promote') grants.setState(spec, 'suspended', { expected_revision: 1, idempotency_key: 'initial-suspend' });
      else grants.setAdmission(spec, false, { expected_revision: 1, idempotency_key: 'initial-pause' });
    }
    await writeFile(join(home, 'grant-proof-ready.json'), JSON.stringify({ pid: process.pid, specifications }));
    let busy = false, handled;
    const timer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const request = JSON.parse(await readFile(join(home, 'grant-proof-request.json'), 'utf8'));
        if (handled === request.id) return;
        const spec = specifications[request.action]; if (!spec) throw Error('Unknown proof grant');
        let result;
        try {
          if (request.operation === 'get') result = grants.get(spec);
          else if (request.operation === 'require') result = grants.require(spec);
          else if (request.operation === 'state') result = grants.setState(spec, request.state, request.options);
          else if (request.operation === 'admission') result = grants.setAdmission(spec, request.allowed, request.options);
          else throw Error('Unknown proof operation');
          result = { ok: true, value: result };
        } catch (error) { result = { ok: false, code: error.code, message: error.message }; }
        const responsePath = join(home, `grant-proof-response-${request.id}.json`);
        await writeFile(responsePath + '.tmp', JSON.stringify(result)); await rename(responsePath + '.tmp', responsePath); handled = request.id;
      } catch (error) { if (error.code !== 'ENOENT') writeFileSync(join(home, 'grant-proof-error.txt'), String(error.stack)); }
      finally { busy = false; }
    }, 20);
    ctx.effect(() => () => clearInterval(timer), 'managed grant proof driver');
  }
  if (a2aProof) {
    // Only the human answer is controlled. The mounted question/approval
    // services, their audit records, ownership and remote effects remain real.
    ctx.on('user-questions/request', async request => {
      if (request.agent.session.id !== 'native-child-parent') return;
      const response = await fetch(a2aProof.questionUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: process.pid, sessionId: request.agent.session.id, questions: request.questions }), signal: request.signal });
      if (!response.ok) throw Error('Managed A2A question peer failed');
      return response.json();
    }, { prepend: true });
    ctx.on('approval/request', async request => {
      if (request.agent.session.id !== 'native-child-parent'
        || !['a2a_continue_task', ...(a2aProof.strict ? ['call_a2a_agent'] : [])].includes(request.toolName)) return;
      const response = await fetch(a2aProof.approvalUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: process.pid, toolName: request.toolName, callId: request.callId, reason: request.reason }), signal: request.signal });
      if (!response.ok) throw Error('Managed A2A approval peer failed');
      return (await response.json()).outcome;
    }, { prepend: true });
  }
  let catalogBuildId = '';
  let activeAgent;
  const authenticate = async () => {
    const origin = ctx.webServer.getOrigin();
    const login = await fetch(ctx.connection.authenticatedUrl(origin + '/connect'), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (login.status !== 302) throw Error('Child proof authentication failed');
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await writeFile(join(home, 'control-auth.json'), JSON.stringify({ origin, cookie }), { mode: 0o600 });
    return { origin, cookie };
  };
  if (options.structuredPatch) {
    const { origin, cookie } = await authenticate();
    const rpc = async (method, payload) => {
      const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ method, payload }), signal: AbortSignal.timeout(10000) });
      const result = (await response.json()).result;
      if (response.status !== 200 || !result?.ok) throw Error(`Native catalog proof ${method}: ${result?.error?.code || response.status}`);
      return result.value;
    };
    const catalog = await rpc('resources/list', { kind: 'tool', runtimeType: 'harness', query: 'apply_workspace_patch' });
    const patch = catalog.items.find(item => item.resourceId === 'apply_workspace_patch' && item.source === 'studio-native');
    if (!patch || patch.contract.executor !== 'builtin' || patch.contract.sideEffect !== 'workspace') throw Error('Native patch catalog missing its writer contract');
    const proofPath = join(home, 'native-catalog-authoring-proof.json');
    if (!existsSync(proofPath)) {
      // Exercise the ordinary Agent form's authenticated create/build routes,
      // using the discovered ID rather than a test-only tool registration.
      record = await rpc('agents/create-local', { name: 'Native catalog patch agent', runtimeType: 'harness', spec: {
        ...record.spec, bindings: { ...record.spec.bindings, tools: [{ resourceId: 'read_workspace_file' }, { resourceId: patch.resourceId },
          ...(options.workspaceRewind ? ['list_workspace_checkpoints', 'preview_workspace_rewind', 'rewind_workspace_files'].map(resourceId => ({ resourceId })) : [])] },
      } });
      await writeFile(join(home, 'identity.json'), JSON.stringify({ agentId: record.metadata.id }));
      await rpc('builds/create', { agentId: record.metadata.id, revision: record.metadata.revision });
      const deadline = Date.now() + 15000;
      while (!catalogBuildId) {
        const builds = await rpc('builds/list', { agentId: record.metadata.id });
        catalogBuildId = builds.items.find(item => item.status === 'SUCCEEDED')?.id || '';
        if (!catalogBuildId) {
          if (Date.now() >= deadline) throw Error('Native catalog proof build timed out');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      await writeFile(proofPath, JSON.stringify({ authenticatedCatalog: true, authenticatedCreate: true, authenticatedBuild: true,
        agentId: record.metadata.id, buildId: catalogBuildId, tool: patch }, null, 2));
    } else {
      const proof = JSON.parse(await readFile(proofPath, 'utf8'));
      if (proof.agentId !== record.metadata.id) throw Error('Native catalog proof Agent changed on restart');
      catalogBuildId = proof.buildId;
    }
  }
  const presetId = dshPresetId(record.metadata.id, record.metadata.revision, catalogBuildId);
  // The real SessionController must be callable before reconstructing an agent.
  if (options.writingRecovery) await authenticate();
  ctx.on('agent/created', async ({ agent, source }) => {
    if (agent.session.id !== 'native-child-parent') return;
    activeAgent = agent;
    const { origin, cookie } = await authenticate();
    const response = await fetch(origin + '/agentkit', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'agents/ensure-preset', payload: { agentId: record.metadata.id, ...(catalogBuildId ? { buildId: catalogBuildId } : {}) } }) });
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
    if (options.commandWorkspace) agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next();
      await appendFile(join(home, 'host-instruction-sources.jsonl'), JSON.stringify({ pid: process.pid,
        sessionId: agent.session.id, sections: assembly.sections.map(section => section.name) }) + '\n');
      return assembly;
    });
    // A trusted idle-boundary mode selection using the actual Host controller.
    // Exact model-requested approval is covered separately by the Plan tests.
    if (options.childPlanMode) ctx.get('planMode').set(agent, source !== 'resume');
    if (options.managedProofPath) await writeFile(join(home, 'managed-session-history.json'), JSON.stringify(agent.session.snapshotEvents()));
  });
  if (options.managedProofPath) {
    ctx.on('session/event', (session) => {
      if (session.id === 'native-child-parent') writeFileSync(join(home, 'managed-session-history.json'), JSON.stringify(session.snapshotEvents()));
    });
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent.session.id === 'native-child-parent') writeFileSync(join(home, 'managed-stream-latest.json'), JSON.stringify(frame));
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
      await appendFile(join(home, 'managed-tool-admissions.jsonl'), JSON.stringify({ pid: process.pid, name: exec.name,
        callId: exec.callId, sessionId: exec.agent.session.id }) + '\n');
      return next();
    });
  }
  if (options.conversationRewindProof) {
    const { SqliteRunStore } = await import('@kingsoftcloud/agentkit-harness-node/native/sqlite-store');
    const scope = { tenantId: 'local', workspaceId: createHash('sha256').update(JSON.stringify(workspaceRoot)).digest('hex'),
      userId: 'local-user', agentId: record.metadata.id };
    ctx.on('session/event', session => {
      if (session.id !== 'native-child-parent') return;
      const marker = session.snapshotEvents().at(-1)?.data?.source?.nativeRewind;
      if (marker?.commandId !== 'active-owned-child-rewind') return;
      const store = new SqliteRunStore(join(home, 'studio/native-harness/runs.sqlite'));
      try {
        const parent = store.load(scope, marker.expectedHeadRunId), reservation = parent.snapshot.childBudgetReservations[0];
        const child = store.load(reservation.childScope, reservation.childRunId);
        writeFileSync(join(home, 'child-rewind-commit-observation.json'), JSON.stringify({ pid: process.pid,
          parentPhase: parent.snapshot.phase, childPhase: child.snapshot.phase,
          settledUsageDigest: reservation.settledUsageDigest, generation: marker.generation,
          observedAt: 'synchronous Session event for branch commit' }));
      } finally { store.close(); }
    });
  }
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
    const { SqliteRunStore } = await import('@kingsoftcloud/agentkit-harness-node/native/sqlite-store');
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
