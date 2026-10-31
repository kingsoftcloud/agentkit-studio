import { join } from 'node:path';
import { canonical, invariant, parseNativeJson, requiresExactJsonWire, stringifyModelJson } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeWorkspaceTools } from '@kingsoftcloud/agentkit-harness-node/native/workspace-tools';
import { committedWorkspaceCheckpoint } from '@kingsoftcloud/agentkit-harness-node/native/workspace-checkpoints';
import { createBackgroundCommandPort } from '@kingsoftcloud/agentkit-harness-node/native/background-command-port';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { projectNativeDshContent } from './native-input.mjs';
import { requestedExactWorkspaceFile, exactByteDifference } from './native-final-shape.mjs';
import { directoryModelReply } from './native-directory-observation.mjs';
import { workspaceSourceModelReply } from './native-source-observation.mjs';
import { nativeConversationReadStates } from './native-conversation-reads.mjs';
import { createNativeDshWebTools } from './native-dsh-web.mjs';
import { createNativeToolAuthorityReader, createNativeToolReceiptAuthority, createNativeWorkspaceRepairAuthority } from './native-tool-authority.mjs';
import { createNativeComponentTools, NATIVE_COMPONENT_TOOLS_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/component-tools';
import { createNativeSkillDisclosurePort } from '@kingsoftcloud/agentkit-harness-node/native/skill-disclosure';
import { createNativeDshA2aTools } from './native-dsh-a2a.mjs';
import { createNativeA2aReceiptObserver, createNativeA2aReceiptWaiter, createNativeA2aQuestionTerminator } from './native-a2a-receipt.mjs';
import { sandboxRegistryName } from './sandbox-code-name.mjs';
import { NATIVE_DURABLE_APPROVAL, HOST_PREFLIGHT_DEFER } from './native-durable-approval.mjs';

/** Per-agent ports share the preset registry but retain their original ledger authority. */
export function createNativeDshAgentTools(environment, agent, commandAuthority) {
  const {
    isClosed, WORKSPACE_REPAIR_TOOL, a2a, a2aOwners, allowed, argumentEncoding,
    browserName, browserTools, builtinNames, calls, codeNames, codeToolsFor,
    commandBackend, commandNames, commandToolsFor, componentOwners, ctx, disclosureNames,
    disclosureOwners, formal, hasSkills, hash, mcpContracts, memoryOwners,
    remoteSkillOwners, remoteSkills, resultRetention, skillSource, state, stateDir, webEnvironmentSnapshot, durableApproval,
    webFetch, webOwners, workspace, workspaceToolNames, durableApprovalContract
  } = environment;

  const sessionId = commandAuthority?.childSessionId ?? String(agent.session.id);
  const workspaceTools = commandAuthority?.childSessionId && commandAuthority.workspaceRoot
    ? createNativeWorkspaceTools({ workspaceRoot: commandAuthority.workspaceRoot,
      stateDir: join(stateDir, 'child-tool-state', commandAuthority.workspaceBinding.isolationId), enablePatches: true, enableRewind: true,
      sessionId, authorize: async () => 'allow' }) : state(agent, sessionId);
  const readAuthority = commandAuthority ? createNativeToolAuthorityReader({ ...commandAuthority, sessionId,
    isClosed: () => isClosed() }) : undefined;
  const childSkills = commandAuthority?.childSkills ? structuredClone(commandAuthority.childSkills) : null;
  const assertCurrent = readAuthority ? request => {
    const current = readAuthority(request);
    if (!current) return false;
    // Borrowed Skill identity needs its original admission. Ordinary parent
    // calls do not read that larger header, or any historical tool receipt.
    if (childSkills) {
      const original = commandAuthority.store.authority?.(commandAuthority.scope, request.runId)
        ?? commandAuthority.store.load(commandAuthority.scope, request.runId);
      invariant(original.snapshot.configDigest === current.snapshot.configDigest && request.buildId === childSkills.buildId
        && canonical(original.configuration.hostRecoveryBinding?.childSkills ?? null) === canonical(childSkills), 'studio_native_child_skill_binding_changed');
    }
    workspaceTools.adoptConversationBranch(current.snapshot.conversationBranch, () => {
      // Historical receipts are needed only when actually adopting a new
      // conversation branch. The workspace owner skips this callback when its
      // current generation is already installed.
      const original = commandAuthority.store.authority?.(commandAuthority.scope, request.runId)
        ?? commandAuthority.store.load(commandAuthority.scope, request.runId);
      invariant(canonical(original.snapshot.conversationBranch) === canonical(current.snapshot.conversationBranch),
        'studio_native_conversation_branch_changed');
      return nativeConversationReadStates({ store: commandAuthority.store, scope: commandAuthority.scope,
        seed: original.configuration.conversationSeed });
    });
    return true;
  } : undefined;
  const assertReceiptCurrent = commandAuthority?.store ? createNativeToolReceiptAuthority({ ...commandAuthority, sessionId,
    isClosed: () => isClosed() }) : undefined;
  const assertRepairCurrent = commandAuthority?.store ? createNativeWorkspaceRepairAuthority({ ...commandAuthority, sessionId,
    isClosed: () => isClosed() }) : undefined;
  const a2aReceiptObserver = a2a && commandAuthority?.store ? createNativeA2aReceiptObserver({ a2a,
    scope: commandAuthority.scope, sessionId, store: commandAuthority.store,
    stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace, isClosed: () => isClosed() }) : null;
  const a2aService = a2a && commandAuthority?.scope && assertCurrent ? a2a.forSession({ scope: commandAuthority.scope, sessionId,
    destinationSessionId: String(agent.session.id),
    stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace, assertCurrent }) : null;
  if (a2aService) {
    // Child state remains in its own journal/session. Its live transport
    // lifetime is released with the root Session after children drain.
    const ownerSessionId = String(agent.session.id);
    if (!a2aOwners.has(ownerSessionId)) a2aOwners.set(ownerSessionId, new Set());
    a2aOwners.get(ownerSessionId).add(a2aService);
  }
  const a2aPort = a2aService ? createNativeDshA2aTools({ config: {
    ...a2aService,
    scope: commandAuthority.scope, sessionId, spaceId: a2a.spaceId, assertCurrent, authorize: async () => 'allow', receiptObservation: true,
  } }) : null;
  const remoteSkillPort = remoteSkills && commandAuthority?.scope && assertCurrent ? remoteSkills.forSession({
    agent: { session: { id: sessionId } }, scope: commandAuthority.scope, sessionId,
    stateRoot: join(stateDir, 'remote-skills'), workspaceRoot: workspace, assertCurrent }) : null;
  if (remoteSkillPort) {
    if (!remoteSkillOwners.has(sessionId)) remoteSkillOwners.set(sessionId, new Set());
    remoteSkillOwners.get(sessionId).add(remoteSkillPort);
  }
  let disclosure;
  if (disclosureNames.size && commandAuthority?.store && (!commandAuthority.childSessionId || childSkills)) {
    disclosure = createNativeSkillDisclosurePort({ scope: commandAuthority.scope, sessionId,
      store: commandAuthority.store, source: skillSource.source, skillRefs: skillSource.source.refs,
      authorize: async () => 'allow', assertCurrent });
    // Child ports borrow the source, never a parent's disclosure cursor.
    // Their lifetime belongs to the parent Session that owns the child.
    const ownerSessionId = String(agent.session.id);
    if (!disclosureOwners.has(ownerSessionId)) disclosureOwners.set(ownerSessionId, new Set());
    disclosureOwners.get(ownerSessionId).add(disclosure);
  }
  let components;
  if (builtinNames.has('component_status') && commandAuthority?.componentBinding
    && (!commandAuthority.toolNames || commandAuthority.toolNames.includes('component_status'))) {
    invariant(commandAuthority.componentBinding.contract === NATIVE_COMPONENT_TOOLS_CONTRACT,
      'studio_native_component_binding_invalid');
    components = createNativeComponentTools({ scope: commandAuthority.scope, sessionId,
      status: commandAuthority.componentBinding.status, assertCurrent });
    if (!componentOwners.has(sessionId)) componentOwners.set(sessionId, new Set());
    componentOwners.get(sessionId).add(components);
  }
  let commandsPromise;
  const commands = () => commandsPromise ||= commandToolsFor(agent, commandAuthority, workspaceTools);
  let codePromise;
  const code = () => codePromise ||= codeToolsFor(agent, commandAuthority);
  let webPromise;
  const web = () => {
    if (webPromise) return webPromise;
    invariant(!isClosed() && commandAuthority?.scope && commandAuthority?.store, 'studio_native_web_ledger_unavailable');
    webPromise = (async () => {
      const artifacts = await createNativeArtifactStore({ directory: join(stateDir, 'web-artifacts'), scope: commandAuthority.scope });
      invariant(!isClosed(), 'studio_native_tools_closed');
      return createNativeDshWebTools({ config: { env: webEnvironmentSnapshot, sessionId, inlineMaxChars: 6000, authorize: async () => 'allow',
        artifact: { store: artifacts, scope: commandAuthority.scope } }, ...(webFetch ? { fetch: webFetch } : {}) });
    })();
    if (!webOwners.has(sessionId)) webOwners.set(sessionId, new Set());
    webOwners.get(sessionId).add(webPromise);
    return webPromise;
  };
  return { workspace: { observe: request => workspaceTools.observe(request) },
    ...(commandAuthority?.children ? { children: commandAuthority.children.owner } : {}),
    ...(commandAuthority && [...commandNames].some(name => builtinNames.has(name)) ? {
      background: createBackgroundCommandPort({ ...commandAuthority,
        readers: { [commandBackend]: async request => (await commands()).reader(request) } }),
    } : {}),
    ...(builtinNames.has(browserName) ? { browser: { recoverSessions: request => browserTools.forSession(sessionId).recoverSessions(request) } } : {}),
    tools: {
      executionLifecycle: 'dispatch/v1',
      ...(durableApprovalContract ? { approvalPolicy: durableApprovalContract } : {}),
      checkPlanMode: async request => {
        if (commandBackend !== 'local_process' || !builtinNames.has(request.call.name)
          || request.call.name !== 'run_command' || request.definition.planModeCommandPolicy !== 'zcode-posix-readonly/v1'
          || !assertCurrent || !assertCurrent(request)) return false;
        return (await commands()).checkPlanMode(request);
      },
      ...(a2a && commandAuthority?.store ? { settleQuestions: createNativeA2aQuestionTerminator({ a2a,
        scope: commandAuthority.scope, sessionId, store: commandAuthority.store,
        stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace, isClosed: () => isClosed() }) } : {}),
      ...(a2a && commandAuthority?.store ? { waitForReceipt: createNativeA2aReceiptWaiter({ a2a,
        scope: commandAuthority.scope, sessionId, store: commandAuthority.store,
        stateRoot: join(stateDir, 'a2a-calls'), workspaceRoot: workspace, isClosed: () => isClosed() }) } : {}),
      ...(assertReceiptCurrent ? { observeReceipt: async request => {
        if (request.definition.workspaceCheckpointPolicy === 'file-preimages/v1' && builtinNames.has(request.call.name)
          && formal.has(request.call.name) && allowed.has(request.call.name))
          return workspaceTools.observeReceipt(request, { assertCurrent: assertReceiptCurrent });
        if (a2aReceiptObserver) return a2aReceiptObserver(request);
        invariant(assertReceiptCurrent(request), 'studio_native_tool_receipt_authority_stale');
        return { contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result: null };
      } } : {}),
      ...(assertRepairCurrent ? { repairWorkspace: async request => {
        invariant(assertRepairCurrent(request) && builtinNames.has(request.call.name) && workspaceToolNames.has(request.call.name)
          && allowed.has(request.call.name), 'studio_native_repair_authority_missing');
        const callId = `ak-repair-${hash({ runId: request.runId, operationKey: request.operationKey, scope: request.scope })}`;
        invariant(!calls.has(callId), 'studio_native_tool_already_executing');
        const originalSignal = request.signal, session = agent.session, sessionIdentity = String(session.id),
          sealed = canonical({ ...request, signal: null });
        const assertCurrent = candidate => !isClosed() && agent.session === session && String(session.id) === sessionIdentity
          && request.signal === originalSignal && !originalSignal.aborted && canonical({ ...request, signal: null }) === sealed
          && canonical({ ...candidate, signal: null }) === sealed && assertRepairCurrent(candidate);
        const invocation = { repair: true, request, agent, workspaceTools, assertCurrent };
        const envelope = result => ({ contract: request.contract, originalOperationKey: request.originalOperationKey, callId: request.call.callId, result });
        calls.set(callId, invocation);
        try {
          const output = await ctx.tools.execute({ name: WORKSPACE_REPAIR_TOOL, callId, agent, signal: request.signal,
            arguments: { original_operation_key: request.originalOperationKey } });
          invariant(assertCurrent(request), 'studio_native_repair_authority_stale');
          // The raw compensation is an error result by design. Only its
          // exact typed marker surviving post-policy may settle the Run.
          if (!invocation.outcome || output?.concludesTurn || typeof output?.isError !== 'boolean'
            || !Array.isArray(output.content)) return envelope(null);
          const context = await projectNativeDshContent(output.content, { signal: request.signal, attachments: () => ctx.get?.('attachments') });
          let approved;
          try { approved = canonical(parseNativeJson(context.content)) === canonical(invocation.outcome.content); } catch { approved = false; }
          if (!approved || context.media?.length) return envelope(null);
          const additionalContexts = [];
          for (const message of output.additionalContexts ?? []) {
            invariant(message?.role === 'user', 'studio_native_tool_context_invalid');
            additionalContexts.push(await projectNativeDshContent(message.content, { signal: request.signal,
              attachments: () => ctx.get?.('attachments') }));
          }
          const result = { ...invocation.outcome, context, ...(additionalContexts.length ? { additionalContexts } : {}) };
          workspaceTools.recordRepairReceipt(request, result, { assertCurrent });
          return envelope(result);
        } finally { calls.delete(callId); }
      } } : {}),
      execute: async (request, executionLifecycle) => {
    invariant(!isClosed(), 'studio_native_tools_closed');
    invariant(request.sessionId === sessionId && (allowed.has(request.call.name)
      || hasSkills && ['skill', 'bash', 'pwsh'].includes(request.call.name)),
    'studio_native_tool_not_bound');
    if (commandAuthority?.childSessionId) invariant(canonical(request.scope) === canonical(commandAuthority.scope)
      && commandAuthority.toolNames.includes(request.call.name), 'studio_native_child_tool_not_bound');
    request.signal.throwIfAborted();
    // One runtime owns retention and retrieval. The host still settles every
    // approval and post-policy transformation before Native archives output.
    if (request.resultGovernance === 'runtime-artifacts/v1' && resultRetention !== 'caller/v1')
      return { status: 'error', content: { code: 'studio_native_result_retention_unavailable', executed: false,
        message: 'This host cannot delegate tool-result retention to Native. Upgrade the maintained host before running this task.' } };
    // Adopt the conversation branch before a workspace tool snapshots read
    // preconditions. Edit matching may capture them before its first await;
    // adopting only from the later publication guard is too late.
    if (assertCurrent && builtinNames.has(request.call.name) && workspaceToolNames.has(request.call.name))
      invariant(assertCurrent(request), 'studio_native_tool_authority_stale');
    if (builtinNames.has(request.call.name) && request.definition.exactContentPolicy && commandAuthority?.store) {
      invariant(assertCurrent?.(request), 'studio_native_tool_authority_stale');
      const goal = readAuthority?.(request)?.snapshot.goal;
      invariant(typeof goal === 'string', 'studio_native_tool_authority_stale');
      const required = requestedExactWorkspaceFile(goal), proposed = request.call.arguments;
      if (required && proposed.path === required.relativePath) {
        if (request.call.name === 'edit_workspace_file' && request.definition.exactContentPolicy === 'complete-write-only/v1')
          return { status: 'error', content: { code: 'workspace_exact_content_requires_write', path: required.relativePath,
            instruction: 'This goal requires exact file bytes. Submit the complete requested content through write_workspace_file; no edit was applied.' } };
        if (request.call.name === 'write_workspace_file' && typeof proposed.content === 'string' && proposed.content !== required.content)
          return { status: 'error', content: { code: 'workspace_content_contract_mismatch', source: 'current_run_goal', path: required.relativePath,
            difference: exactByteDifference(Buffer.from(required.content, 'utf8'), Buffer.from(proposed.content, 'utf8')),
            instruction: 'Submit a new write_workspace_file call with the exact UTF-8 content requested in the current goal. No file was written.' } };
      }
    }
    // Both parent and child calls belong to the current Native intent.
    // DSH policy and MCP credential/connection waits cannot extend that
    // authority after its lease or immutable request has changed.
    const ownedMcp = commandAuthority?.store && mcpContracts.has(request.call.name);
    const originalSignal = request.signal;
    const sealed = ownedMcp ? canonical(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'signal'))) : null;
    const assertMcpCurrent = ownedMcp ? () => {
      invariant(request.signal === originalSignal && !originalSignal.aborted
        && canonical(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'signal'))) === sealed
        && assertCurrent(request), commandAuthority.childSessionId
          ? 'studio_native_child_mcp_authority_stale' : 'studio_native_mcp_authority_stale');
    } : undefined;
    assertMcpCurrent?.();
    const exactNumbers = requiresExactJsonWire(request.call.arguments);
    if (exactNumbers && !argumentEncoding) return { status: 'error', content: {
      code: 'STUDIO_NATIVE_EXACT_NUMBER_UNSUPPORTED', executed: false,
      message: 'The current DSH tool boundary cannot preserve this exact numeric value. The tool was not executed.',
    } };
    const callId = `ak-native-${hash({ scope: request.scope, runId: request.runId, operationKey: request.operationKey, callId: request.call.callId })}`;
    invariant(!calls.has(callId), 'studio_native_tool_already_executing');
    const checkpointCommitted = commandAuthority?.store && commandAuthority.scope
      ? row => committedWorkspaceCheckpoint(row, { store: commandAuthority.store, scope: commandAuthority.scope, sessionId }) : undefined;
    const currentAuthority = readAuthority?.(request);
    if (readAuthority) invariant(currentAuthority, 'studio_native_tool_authority_stale');
    const invocation = { agent, request, workspaceTools, assertCurrent, checkpointCommitted, components, disclosure, a2a: a2aPort, remoteSkills: remoteSkillPort, children: commandAuthority?.children,
      splitModelObservation: currentAuthority?.splitModelObservation ?? false,
      registryName: codeNames.has(request.call.name) ? sandboxRegistryName(request.call.name) : request.call.name,
      loadRecord: () => commandAuthority.store.load(request.scope, request.runId),
      argumentEncoding: exactNumbers ? argumentEncoding : null, commands, code, web, assertMcpCurrent, executionLifecycle,
      commandProgress: commandAuthority?.commandProgress };
    calls.set(callId, invocation);
    try {
      // Numeric raw tokens retain their intrinsic brand through the negotiated
      // SDK snapshot. The Native request remains the owned builtin's source.
      const args = exactNumbers ? JSON.parse(stringifyModelJson(request.call.arguments), (_key, value, context) => {
        if (typeof value !== 'number' || Number.isFinite(value) && !requiresExactJsonWire(value)) return value;
        invariant(typeof context?.source === 'string', 'studio_native_raw_number_source_missing');
        return JSON.rawJSON(context.source);
      }) : structuredClone(request.call.arguments);
      const result = await ctx.tools.execute({ callId, name: codeNames.has(request.call.name) ? sandboxRegistryName(request.call.name) : request.call.name,
        arguments: args, ...(exactNumbers ? { argumentEncoding } : {}),
        ...(request.resultGovernance === 'runtime-artifacts/v1' ? { resultRetention } : {}),
        ...(request.definition.approvalPolicy === NATIVE_DURABLE_APPROVAL ? { preflightDefer: HOST_PREFLIGHT_DEFER } : {}),
        signal: request.signal, agent });
      request.signal.throwIfAborted();
      invariant(typeof result?.isError === 'boolean' && Array.isArray(result.content), 'studio_native_tool_result_invalid');
      durableApproval.assertProjection(invocation, result);
      if (invocation.deferredApproval && result.isError)
        invocation.outcome = { status: 'error', content: { code: 'native_approval_preflight_denied', executed: false } };
      // Memory tools live per-session (not in the shared formal map): resolve
      // the caller-session's locked definition for readOnly/mutation checks.
      const memOwner = memoryOwners.get(sessionId);
      const memDef = memOwner?.definitions.get(request.call.name);
      const lockedFormal = memDef ?? formal.get(request.call.name);
      const readOnlyBuiltin = builtinNames.has(request.call.name) && lockedFormal?.readOnly;
      const afterWriteFailure = result?.isError && invocation.outcome?.status === 'ok' && !readOnlyBuiltin;
      // Without an owned builtin receipt an external failure cannot prove
      // whether its effect ran. Never infer safe retry from isError alone.
      const externalFailure = result?.isError && !builtinNames.has(request.call.name) && !invocation.outcome
        && (!mcpContracts.has(request.call.name) || invocation.dispatched);
      let staleMcp = false;
      if (assertMcpCurrent) { try { assertMcpCurrent(); } catch { staleMcp = true; } }
      let status = staleMcp || invocation.outcome?.status === 'uncertain' || afterWriteFailure || externalFailure || result?.concludesTurn ? 'uncertain'
        // Approval is a Native control result, not a successful execution.
        // Keep its original interactionId so the kernel durably waits and
        // resumes the exact call. A rejecting post-policy still takes effect.
        : invocation.outcome?.status === 'approval_required' && !result?.isError ? 'approval_required'
        : invocation.outcome?.status === 'error' || result?.isError ? 'error' : 'ok';
      const options = { signal: request.signal, attachments: () => ctx.get?.('attachments'),
        fileRequestText: async ref => {
          const llm = ctx.get?.('llm');
          invariant(typeof llm?.fileRequestText === 'function', 'STUDIO_FILE_ATTACHMENT_UNAVAILABLE');
          return llm.fileRequestText(ref);
        } };
      let context = await projectNativeDshContent(result.content, options); const additionalContexts = [];
      const displayObservationVisible = !context.media?.length && invocation.outcome
        && context.content === canonical(invocation.outcome.content);
      // A filtered/hidden Read is not evidence that its original full bytes
      // entered the authorized observation. Writes/edits record bytes this
      // invocation itself successfully published, independent of display.
      const visibleWorkspaceRead = request.call.name !== 'read_workspace_file'
        || !context.media?.length && invocation.outcome && context.content === canonical(invocation.outcome.content);
      let archiveContext;
      if (status === 'ok' && request.definition.directoryObservationPolicy && builtinNames.has(request.call.name)
        && formal.get(request.call.name)?.contextRole === 'workspace_list' && !context.media?.length) {
        let projected = null;
        try {
          projected = directoryModelReply(parseNativeJson(context.content), request.call.arguments, {
            policy: request.definition.directoryObservationPolicy,
            resultBytes: currentAuthority.configuration.limits.maxToolResultBytes,
          });
        } catch { /* Unfamiliar post-policy output keeps normal result governance. */ }
        if (projected !== null) { archiveContext = context; context = { ...context, content: projected }; }
      }
      if (status === 'ok' && request.definition.sourceObservationPolicy && builtinNames.has(request.call.name)
        && formal.get(request.call.name)?.contextRole === 'workspace_read' && !context.media?.length) {
        let projected = null;
        try { projected = workspaceSourceModelReply(parseNativeJson(context.content)); } catch { /* retain actual post-policy view */ }
        if (projected !== null) { archiveContext = context; context = { ...context, content: projected }; }
      }
      for (const message of result.additionalContexts ?? []) {
        invariant(message?.role === 'user', 'studio_native_tool_context_invalid');
        const projected = await projectNativeDshContent(message.content, options);
        if (message.source) projected.presentation.source = message.source.kind === 'tool'
          ? { ...structuredClone(message.source), callId: request.call.callId } : structuredClone(message.source);
        additionalContexts.push(projected);
      }
      // Host facts (including browser interaction diagnostics) need their
      // original typed receipt. Model/display views still use the complete
      // post-policy DSH output above; native context cannot bypass it.
      const content = invocation.outcome ? structuredClone(invocation.outcome.content) : result?.additionalContexts?.length
        ? { content: result.content, additionalContexts: result.additionalContexts } : result.content;
      if (assertMcpCurrent) { try { assertMcpCurrent(); } catch { status = 'uncertain'; } }
      const outcome = { ...invocation.outcome, status, content,
      context, ...(archiveContext ? { archiveContext } : {}), ...(additionalContexts.length ? { additionalContexts } : {}) };
      if (outcome.metadata?.nativeTaskDisplay && (!displayObservationVisible || status !== 'ok')) {
        outcome.metadata = { ...outcome.metadata }; delete outcome.metadata.nativeTaskDisplay;
        if (!Object.keys(outcome.metadata).length) delete outcome.metadata;
      }
      if (!visibleWorkspaceRead && outcome.metadata?.nativeWorkspaceReads) {
        outcome.metadata = { ...outcome.metadata }; delete outcome.metadata.nativeWorkspaceReads;
        if (!Object.keys(outcome.metadata).length) delete outcome.metadata;
      }
      if (assertCurrent && builtinNames.has(request.call.name) && formal.has(request.call.name))
        workspaceTools.recordReceipt(request, outcome, { assertCurrent });
      return outcome;
    } finally { calls.delete(callId); }
  } } };
}
