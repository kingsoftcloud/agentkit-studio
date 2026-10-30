import { createStudioNativeModelBinding } from './native-model-binding.mjs';
import { createStudioNativeSessionInjection } from './native-session-injection.mjs';
import { createStudioNativeChildViews } from './native-child-views.mjs';
import { createNativeChildObservationCache } from '@kingsoftcloud/agentkit-harness-node/native/child-observation';
import { createWorkspaceGitStatus } from './workspace-status.mjs';
import { createStudioNativeCommandOutput, createStudioNativeCommandPreview } from './native-command-output.mjs';
import { createNativeTraceProjection } from '../../providers/native-trace-projection.mjs';
import { bindStudioNativeCloudMemoryTurn, readStudioNativeCloudMemoryTurn } from '../../providers/native-cloud-memory-turn.mjs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonical, copy, invariant, normalizeDeliveryReviewPolicy, artifactToolDefinitions, toolDiscoveryDefinitions, todoToolDefinitions, planModeToolDefinitions, deliveryToolDefinitions, RESULT_DELIVERY_POLICY } from '@kingsoftcloud/agentkit-harness-core';
import { createNativeArtifactStore } from '@kingsoftcloud/agentkit-harness-node/native/artifact-store';
import { selectedNativeBuildContract } from '../../build-engine.mjs';
import { SqliteRunStore } from '@kingsoftcloud/agentkit-harness-node/native/sqlite-store';
import { createNativeDshTurnExecutor, freezeNativeDshConfiguration, NATIVE_DSH_TURN_CONTRACT, canCloseNativeReadInterruption, nativeDshRunId } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-runtime';
import { nativeDeliveryProjection } from '@kingsoftcloud/agentkit-harness-node/native/session-delivery';
import { nativeLiveStream } from '@kingsoftcloud/agentkit-harness-node/native/assistant-stream';
import { projectNativeDshInput, projectNativeDshContent } from '../../providers/native-input.mjs';
import { NATIVE_EXECUTION_CONTEXT_OWNERSHIP, NATIVE_WORKSPACE_CONTEXT_OWNERSHIP, NATIVE_CURRENT_INSTRUCTION_OWNERSHIP, nativeHostInputRows, nativeHostInputIsRefresh } from '../../providers/native-context-ownership.mjs';
import { bindNativeModelSurface, nativeChildInputMediaSources } from '../../providers/native-model-surface.mjs';
import { NATIVE_INSTRUCTION_ASSEMBLY, nativeInstructionAssembly } from '@kingsoftcloud/agentkit-harness-node/native/instruction-assembly';
import { admitNativeWorkspaceContext, ensureNativeWorkspaceContext } from '@kingsoftcloud/agentkit-harness-node/native/workspace-context';
import { createNativeWorkspaceInstructions } from '@kingsoftcloud/agentkit-harness-node/native/workspace-instructions';
import { nativeConversationForkSeed } from '../../providers/native-conversation-fork.mjs';
import { bindNativeContext, nativeContextDefaults } from '../../providers/native-context.mjs';
import { bindStudioNativeMemoryRecall } from '../../providers/native-memory-recall.mjs';
import { bindNativeDeadlinePolicy, bindNativeTaskPolicy, STUDIO_NATIVE_TASK_POLICY_CONTRACT } from '../../providers/native-task-policy.mjs';
import { createNativeVerification, nativeGoalContract, STUDIO_NATIVE_VERIFICATION_CONTRACT } from '../../providers/native-verification.mjs';
import { dshModelRoute } from '../../agent-preset-admission.mjs';
import { prepareLocalResourceContext } from '../../local-runtime.mjs';
import { createNativeHostInteraction, STUDIO_NATIVE_INTERACTION_CONTRACT } from '../../providers/native-host-interaction.mjs';
import { createStudioNativeChildren, nativeChildRoles, STUDIO_NATIVE_CHILD_CONTRACT } from '../../providers/native-subagents.mjs';
import { createStudioNativeChildWorkspaces } from '../../providers/native-child-workspace-host.mjs';
import { childCommandResource } from '@kingsoftcloud/agentkit-harness-node/native/child-command-resource';
import { nativeRecoveryBinding, readNativeRecoveryBinding, assertNativeRecoveryPreset } from '../../providers/native-recovery-binding.mjs';
import { createStudioNativeRecovery } from './native-recovery.mjs';
import { hash, restoredPolicyConfiguration, profileIds, admittedModelSelection, recoveredPromptAssembly, nativePlanAssembly, createStudioNativeBackgroundBinding, createStudioNativeMemoryExtractionBinding } from './native-harness-bindings.mjs';
import { createNativeModelDescriptions } from '../../providers/native-model-capabilities.mjs';
import { createStudioNativeConversation } from './native-conversation.mjs';
import { nativeConversationRewindAdmission } from '../../providers/native-conversation-rewind.mjs';
import { createStudioNativeA2aControl } from './native-a2a-control.mjs';
import { createStudioNativeManagedScopeControl } from './native-managed-scope-control.mjs';
import { createStudioNativeBackgroundAdmission, createStudioNativeBackgroundDispatcher } from './native-background-admission.mjs';
import { STUDIO_NATIVE_HOOK_CONTRACT } from '../../providers/native-hooks.mjs';
import { bindStudioNativeMemoryFlush, composeStudioNativeHooks } from '../../providers/native-memory.mjs';
import { bindStudioNativeMemoryHost, extendNativeMemoryGoal } from '../../providers/native-memory-host.mjs';
import { studioNativeComponentStatus } from '../../providers/native-component-status.mjs';
import { nativeVisionProfileId } from '../../native-vision-model.mjs';
import { createStudioNativeVisionBinding } from '../../providers/native-vision-binding.mjs';
import { nativeA2aReceiptWaitSource, NATIVE_A2A_QUESTION_CLEANUP } from '../../providers/native-a2a-receipt.mjs';
import { nativeChildA2aWaitSource } from '../../providers/native-child-a2a-wait.mjs';
import { readNativeDshManagedOwnership } from '@kingsoftcloud/agentkit-harness-node/native/dsh-managed-ownership';
import { createStudioNativeCommandProgress } from './native-command-progress.mjs';
import { createStudioNativeChildFile } from './native-child-file-binding.mjs';
/** Host services and credentials stay outside the serializable Native core. */
export async function createStudioNativeHarness({ ctx, storeDir, workspaceRoot, agents, builds, models, resources,
  fetchImpl, renderPrompt, publishStreamFrame, ledger, agentEvents, assembleContextFor, hookRegistry, contextSourceRegistry, observability,
  modelCompatibilityRule, projectCommandPreview } = {}) {
  const sessions = ctx.get('sessions'), projections = ctx.get('sessionProjections'), llm = ctx.get('llm');
  invariant(typeof sessions?.flush === 'function' && typeof projections?.register === 'function'
    && typeof renderPrompt === 'function', 'studio_native_host_services_unavailable');
  const store = ledger ?? new SqliteRunStore(join(storeDir, 'native-harness', 'runs.sqlite'));
  const localStore = store;
  const traceProjection = observability ? createNativeTraceProjection({ stateDir: join(storeDir, 'native-harness', 'trace-projections'), observability,
    onError: error => console.warn('[agentkit-studio] Native trace projection failed:', error.code) }) : null;
  let unregister;
  try { unregister = projections.register(nativeDeliveryProjection()); }
  catch (error) { if (!ledger) store.close(); throw error; }
  const lifetime = new AbortController(), active = new Set(), childOwners = new Set(), controls = new Map();
  const bindingLeases = new Map(), streamRevisions = new WeakMap();
  async function acquireBinding(sessionId, signal) {
    const scoped = AbortSignal.any([signal, lifetime.signal]);
    for (;;) {
      scoped.throwIfAborted();
      const previous = bindingLeases.get(sessionId);
      if (!previous) {
        let finish; const done = new Promise(resolve => { finish = resolve; });
        const lease = { done }; bindingLeases.set(sessionId, lease);
        return () => { if (bindingLeases.get(sessionId) === lease) { bindingLeases.delete(sessionId); finish(); } };
      }
      let onAbort;
      const stopped = new Promise((_, reject) => {
        onAbort = () => reject(scoped.reason); scoped.addEventListener('abort', onAbort, { once: true });
      });
      try { await Promise.race([previous.done, stopped]); }
      finally { scoped.removeEventListener('abort', onAbort); }
    }
  }
  let closed = false, closing;
  let backgroundRegistry, backgroundOwner, backgroundStart = Promise.resolve();
  let waitRecoveryOwner, waitRecoveryStart = Promise.resolve();
  const childObservations = createNativeChildObservationCache();
  const workspaceId = hash(resolve(workspaceRoot));
  const sessionInjection = createStudioNativeSessionInjection({ ctx, store, agents, builds, workspaceId, lifetime, agentEvents });
  const projectOperatorCommandOutput = createStudioNativeCommandPreview({ ctx, projectCommandPreview });
  const commandProgress = createStudioNativeCommandProgress({ workspaceId, project: projectOperatorCommandOutput });
  const controlKey = (agentId, sessionId) => canonical({ agentId, sessionId });
  const installControl = (payload, control) => {
    invariant(!closed && !lifetime.signal.aborted, 'studio_native_host_closed');
    const key = controlKey(control.scope.agentId, control.sessionId);
    invariant(!controls.has(key), 'studio_native_child_control_already_active');
    controls.set(key, control);
    try { payload.recoveryStarted?.(control); }
    catch (error) { controls.delete(key); throw error; }
    const trace = traceProjection?.attach({ store: control.store ?? store, scope: control.scope, runId: control.runId,
      sessionId: control.sessionId, agentName: payload.agent?.options?.name ?? '' });
    return async () => { if (controls.get(key) === control) controls.delete(key); await trace?.close(); };
  };
  const controlFor = request => {
    invariant(!closed && typeof request?.agentId === 'string' && request.agentId.trim()
      && typeof request.sessionId === 'string' && request.sessionId.trim(), 'studio_native_child_control_invalid');
    const control = controls.get(controlKey(request.agentId, request.sessionId));
    invariant(control && (request.runId === undefined || request.runId === control.runId), 'studio_native_child_control_run_unavailable');
    control.assertCurrent?.();
    return control;
  };
  const { childCommand, childHistory, readChildren } = createStudioNativeChildViews({ ctx, controls, controlKey, controlFor, store, localStore,
    workspaceId, lifetime, childObservations, isClosed: () => closed, getRecovery: () => recovery });
  const resolveBinding = async ({ agent, input, binding, signal, prepareInput, turn }, original, execution) => {
      // Both entrypoints assemble identical ports; managed Runs must use the
      // receiver's actual ledger and trusted principal, never the local ledger.
      const store = execution?.store ?? localStore;
      if (binding?.runtime !== 'harness' || binding.local !== true) return null;
      invariant(binding.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT, 'studio_native_engine_contract_unsupported');
      invariant(typeof prepareInput === 'function', 'studio_native_whole_turn_host_required');
      invariant(binding.agentId && Number.isSafeInteger(binding.agentRevision) && binding.agentRevision > 0
        && binding.nativeTools, 'studio_native_revision_binding_missing');
      if (!original) binding.nativeTools.assertConversationWorkspaceSettled?.(agent);
      invariant(!binding.buildId || typeof builds?.resolve === 'function', 'studio_native_build_service_unavailable');
      const releaseBinding = await acquireBinding(String(agent.session.id), signal);
      let transferred = false;
      try {
      const record = binding.buildId ? await builds.resolve(binding.agentId, binding.buildId)
        : await agents.getRevision(binding.agentId, binding.agentRevision);
      signal.throwIfAborted();
      invariant(record?.metadata?.id === binding.agentId && record.metadata.local === true
        && record.metadata.revision === binding.agentRevision && record.spec?.runtime?.type === 'harness', 'studio_native_revision_binding_changed');
      if (binding.buildId) invariant(selectedNativeBuildContract({ ...record, buildId: binding.buildId }) === NATIVE_DSH_TURN_CONTRACT,
        'studio_native_build_engine_mismatch');
      const scope = execution?.scope ?? { tenantId: 'local', workspaceId, userId: 'local-user', agentId: binding.agentId };
      const sessionId = String(agent.session.id);
      let capabilityCapsule = original?.capsule;
      let capabilityConfiguration = original?.configuration;
      if (!original && !execution) {
        const runId = nativeDshRunId(scope, sessionId, turn);
        let existing;
        try { existing = store.load(scope, runId); } catch (error) { if (error.code !== 'run_not_found') throw error; }
        if (existing) {
          capabilityConfiguration = existing.configuration;
          capabilityCapsule = existing.configuration.hostRecoveryBinding
            ? readNativeRecoveryBinding(existing, { agentId: binding.agentId, sessionId, runId }) : {};
        }
      }
      // Session headers identify their storage/container project; Native tools
      // own the execution workspace. Context discovery must use that same
      // workspace inside the durable input effect, including UI Sessions.
      // Historical capsules retain the absence of this binding on recovery.
      const workspaceContextPort = binding.nativeTools.workspaceContext?.(agent);
      const workspaceContext = capabilityCapsule ? capabilityCapsule.workspaceContext : workspaceContextPort
        ? admitNativeWorkspaceContext(workspaceContextPort.binding, workspaceContextPort.directory) : undefined;
      if (workspaceContext) {
        invariant(workspaceContextPort && workspaceContextPort.binding.contract === workspaceContext.contract
          && workspaceContextPort.binding.workspaceRoot === workspaceContext.workspaceRoot,
          'studio_native_workspace_context_binding_changed');
      }
      const ids = profileIds(record), profiles = await Promise.all((ids.length ? ids : [''])
        .map(async id => structuredClone(await models.profile(id))));
      signal.throwIfAborted();
      const selection = original ? { ...original.capsule.source,
        ...(original.capsule.maxTokens === null ? {} : { maxTokens: original.capsule.maxTokens }) }
        : admittedModelSelection(agent, input.assembly);
      let selected, selectedId;
      for (let index = 0; index < profiles.length; index++) {
        const profile = profiles[index], id = ids[index] || '';
        if (selection.provider && dshModelRoute(profile) !== selection.provider) continue;
        if (!selection.model || profile.modelName === selection.model) { selected = profile; selectedId = id; break; }
        if (!binding.buildId && typeof models.catalog === 'function') {
          const catalog = await models.catalog(id);
          if (catalog.items?.some(item => item.id === selection.model)) { selected = { ...profile, modelName: selection.model }; selectedId = id; break; }
        }
      }
      invariant(selected, 'studio_native_bound_model_unavailable');
      const descriptions = createNativeModelDescriptions({ models, originalCapsule: capabilityCapsule, signal });
      await Promise.all(profiles.map(profile => descriptions.describe(profile)));
      const description = await descriptions.describe(selected);
      const visionId = nativeVisionProfileId(record);
      const visionProfile = visionId ? structuredClone(await models.profile(visionId)) : null;
      signal.throwIfAborted();
      const visionDescription = visionProfile ? await descriptions.describe(visionProfile) : null;
      invariant(!visionDescription || visionDescription.input.includes('image'), 'studio_native_vision_model_image_input_required');
      // Older TS runs could contain an unconsumed product field. Restore their
      // actual admission, rather than activating a newly supported policy.
      const deadlineExecution = original && !Object.hasOwn(original.configuration, 'wallDeliveryPolicy') ? undefined : record.spec.execution;
      const deadline = bindNativeDeadlinePolicy(deadlineExecution);
      const contextDefaults = nativeContextDefaults(original?.configuration);
      const surfaceEpoch = !original || original.configuration.modelSurface !== undefined;
      const childAllocationPolicy = original ? original.configuration.childAllocationPolicy
        : typeof binding.nativeTools.childBindingFor === 'function' ? 'parent-shared/v1' : undefined;
      // Absence on historical capsules means their exact original controls,
      // even when that Run already has the modern output/environment policy.
      const executionOptions = { modern: surfaceEpoch,
        resourceProfile: original ? original.capsule.localExecutionProfile : 'local-development/v1' };
      const localExecution = binding.nativeTools.localExecution?.(executionOptions);
      const commandBinding = localExecution?.binding ?? binding.nativeTools.commandBinding;
      const modelSurface = surfaceEpoch ? bindNativeModelSurface({
        ...(!original || original.configuration.modelSurface?.executionCapabilities !== undefined
          ? { executionCapabilities: binding.nativeTools.executionCapabilities?.() ?? [] } : {}),
        environment: binding.nativeTools.executionEnvironment?.(executionOptions) ?? {
          workspaceRoot: await realpath(workspaceRoot), cwd: await realpath(workspaceRoot), platform: process.platform, commandBackend: 'none' },
        description, original: original?.configuration.modelSurface }) : undefined;
      const context = bindNativeContext({ description, context: record.spec.context, maxTokens: selection.maxTokens,
        ...contextDefaults });
      const source = { provider: selection.provider || dshModelRoute(selected), model: selected.modelName };
      const inputSelection = original ? admittedModelSelection(agent, input.assembly) : { ...selection, ...source };
      const inputServices = { attachments: () => ctx.get('attachments'),
        fileRequestText: typeof llm?.fileRequestText === 'function' ? ref => llm.fileRequestText(ref) : undefined };
      // Replay the already-admitted bytes and resource context. Mutable files,
      // attachments and memory are not a substitute for the original input.
      const inputContextPolicy = original ? original.capsule.inputContextPolicy
        : capabilityCapsule ? capabilityCapsule.inputContextPolicy
          : workspaceContext?.instructionSource ? NATIVE_CURRENT_INSTRUCTION_OWNERSHIP
            : workspaceContext ? NATIVE_WORKSPACE_CONTEXT_OWNERSHIP : NATIVE_EXECUTION_CONTEXT_OWNERSHIP;
      const inputRows = nativeHostInputRows(input.messages, inputContextPolicy, {
        initial: !!workspaceContext && workspaceContext.sourceRoot !== workspaceContext.workspaceRoot });
      const admission = original ? { objective: original.configuration.contract.objective,
        messages: structuredClone(original.configuration.inputMessages) }
        : await projectNativeDshInput(inputRows.map(row => row.message), { ...inputServices, signal });
      const childMediaSources = nativeChildInputMediaSources(inputRows, admission);
      const buildId = binding.buildId || `revision-${hash({ agentId: binding.agentId, revision: binding.agentRevision, spec: record.spec })}`;
      // Pin the combined browser + observer deadline in the same formal tool
      // definition used by the Kernel, registry gateway and browser owner.
      const visionDispose = visionDescription && typeof binding.nativeTools.bindVision === 'function'
        ? binding.nativeTools.bindVision({ sessionId, requestTimeoutMs: visionDescription.requestTimeoutMs }) : undefined;
      try {
      // Lock the non-memory tool bundle before Memory tools are bound so the
      // Memory locked digest can bind it without a circular dependency. The
      // profile/plugin digests pin the Build's model and non-hook bindings.
      const baseTools = binding.nativeTools.definitions(agent, input.assembly.tools);
      const instructionAssemblyPolicy = capabilityCapsule ? capabilityCapsule.instructionAssemblyPolicy : NATIVE_INSTRUCTION_ASSEMBLY;
      invariant(record.spec.execution?.nativePlanMode === undefined || ['auto', 'off'].includes(record.spec.execution.nativePlanMode),
        'studio_native_plan_mode_invalid');
      const planModePolicy = original ? original.configuration.planModePolicy
        : record.spec.execution?.nativePlanMode !== 'off' && ctx.get('planMode')
          && projections?.stateOf?.(agent.session, 'plan') !== undefined
          && !baseTools.some(tool => ['EnterPlanMode', 'ExitPlanMode', 'exit_plan_mode'].includes(tool.name)) ? 'session-plan/v1' : undefined;
      const currentPlanActive = () => {
        const state = ctx.get('planMode')?.get(agent);
        invariant(typeof state?.active === 'boolean', 'studio_native_plan_state_unavailable');
        return state.active;
      };
      const bundleDigest = hash(baseTools);
      const profileDigest = hash(description);
      const pluginLockDigest = hash({ mcpBindingDigest: binding.nativeTools.mcpBindingDigest ?? null,
        ...(binding.nativeTools.skillDisclosureBindingDigest ? { skillDisclosureBindingDigest: binding.nativeTools.skillDisclosureBindingDigest } : {}),
        commandBinding: commandBinding ?? null,
        ...(binding.nativeTools.codeBinding ? { codeBinding: binding.nativeTools.codeBinding } : {}),
        ...(binding.nativeTools.webBinding ? { webBinding: binding.nativeTools.webBinding } : {}),
        ...(binding.nativeTools.a2aBinding ? { a2aBinding: binding.nativeTools.a2aBinding } : {}),
        ...(binding.nativeTools.remoteSkillBinding ? { remoteSkillBinding: binding.nativeTools.remoteSkillBinding } : {}),
        ...(binding.nativeTools.skillManagementBinding ? { skillManagementBinding: binding.nativeTools.skillManagementBinding } : {}),
        ...(binding.nativeTools.knowledgeBinding ? { knowledgeBinding: binding.nativeTools.knowledgeBinding } : {}),
        ...(binding.nativeTools.legacyMemoryBinding ? { legacyMemoryBinding: binding.nativeTools.legacyMemoryBinding } : {}),
        ...(visionDescription ? { visionModel: visionDescription } : {}),
        ...(binding.nativeTools.workspaceMutationContract ? { workspaceMutationContract: binding.nativeTools.workspaceMutationContract } : {}),
        workspaceSyntax: binding.nativeTools.workspaceSyntax ?? null });
      // Compose the local-default Memory owner for this Build (Revision or
      // Frozen) and bind its tools into the real DSH pipeline. Returns null for
      // a non-local provider so the cloud Memory path stays unchanged. The
      // verification wrapper is always produced for local-default so an explicit
      // Memory task fails closed when the owner is not installed.
      const promptAssembly = assembly => nativeInstructionAssembly(nativePlanAssembly(assembly, planModePolicy), {
        policy: instructionAssemblyPolicy, toolNames: baseTools.map(tool => tool.name) });
      const systemPrompt = original ? original.capsule.systemPrompt : renderPrompt(promptAssembly(input.assembly));
      // New Native runs use the original Studio recovery policies. A cold
      // restore retains the exact older optional configuration and digest.
      const recoveryPolicies = original ? Object.fromEntries(['workspaceCapturePolicy', 'deliveryScopePolicy', 'outputRecoveryPolicy', 'toolExecutionPolicy', 'childCapabilityPolicy', 'toolErrorRecoveryPolicy', 'toolErrorRecoveryModelCalls', 'deliveryReviewPolicy', 'wallDeliveryPolicy', 'artifactPolicy', 'inputPolicy', 'sourceReadPolicy', 'toolDiscoveryPolicy', 'todoPolicy', 'planModePolicy', 'planModeInitialActive', 'childTaskPolicy', 'childPlanPolicy']
        .filter(key => Object.hasOwn(original.configuration, key)).map(key => [key, original.configuration[key]]))
        : { workspaceCapturePolicy: 'declared-subjects/v1', deliveryScopePolicy: RESULT_DELIVERY_POLICY, outputRecoveryPolicy: 'response-boundary/v2', toolExecutionPolicy: 'owner-execution/v1', toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1', artifactPolicy: 'runtime-artifacts/v1', sourceReadPolicy: 'studio-source-read/v1',
          ...(workspaceContext && (!capabilityCapsule || [NATIVE_WORKSPACE_CONTEXT_OWNERSHIP, NATIVE_CURRENT_INSTRUCTION_OWNERSHIP].includes(capabilityCapsule.inputContextPolicy))
            ? { inputPolicy: 'before-first-model/v1' } : {}),
          ...(nativeChildRoles(record.spec).length ? { childTaskPolicy: 'session-controls/v1', childCapabilityPolicy: 'required-tools/v1' } : {}),
          ...(planModePolicy && nativeChildRoles(record.spec).length ? { childPlanPolicy: 'inherit-plan/v1' } : {}),
          ...(planModePolicy ? { planModePolicy, planModeInitialActive: currentPlanActive() } : {}),
          ...(Object.hasOwn(deadline, 'wallDeliveryPolicy') ? { wallDeliveryPolicy: deadline.wallDeliveryPolicy } : {}),
          ...(record.spec.execution?.toolErrorRecoveryModelCalls === undefined ? {}
            : { toolErrorRecoveryModelCalls: record.spec.execution.toolErrorRecoveryModelCalls }),
          ...(record.spec.execution?.deliveryReviewPolicy === undefined ? {} : { deliveryReviewPolicy: record.spec.execution.deliveryReviewPolicy === null
            ? null : normalizeDeliveryReviewPolicy(record.spec.execution.deliveryReviewPolicy) }) };
      if (original) invariant(renderPrompt(promptAssembly(recoveredPromptAssembly(input.assembly, source))) === systemPrompt,
        'studio_native_recovery_prompt_changed');
      // Seal the Host recovery capsule once per Build. The Memory owner guard
      // compares the CURRENT configuration's capsule to THIS sealed identity
      // (revision, buildId, system prompt, source, messages), so a legitimately
      // advanced/replaced Run or a new owner cannot authorize a stale write.
      const sealedCapsule = nativeRecoveryBinding({ binding, input, source, selection, systemPrompt, inputContextPolicy,
        modelBindings: descriptions.manifest(), localExecutionProfile: localExecution?.resourceProfile, instructionAssemblyPolicy, workspaceContext });
      const memoryHost = bindStudioNativeMemoryHost({ record, scope, sessionId, store, storeDir,
        buildId: binding.buildId ?? null, context, ctx, bundleDigest, profileDigest, pluginLockDigest, sealedCapsule });
      let memoryDispose, registeredContext, vision, cloudMemory;
      try {
        if (memoryHost?.port && typeof binding.nativeTools.bindMemory === 'function')
          memoryDispose = binding.nativeTools.bindMemory(memoryHost);
      } catch (error) { visionDispose?.(); memoryHost?.close(); throw error; }
      try {
      invariant(record.spec.execution?.nativeToolSearchMode === undefined || ['auto', 'off'].includes(record.spec.execution.nativeToolSearchMode),
        'studio_native_tool_search_mode_invalid');
      invariant(record.spec.execution?.nativeTodoMode === undefined || ['auto', 'off'].includes(record.spec.execution.nativeTodoMode),
        'studio_native_todo_mode_invalid');
      if (!original && record.spec.execution?.nativeTodoMode !== 'off'
        && projections?.stateOf?.(agent.session, 'todos') !== undefined
        && !baseTools.some(tool => ['TodoRead', 'TodoWrite', 'todo_write'].includes(tool.name))) recoveryPolicies.todoPolicy = 'session-todos/v1';
      const toolDiscoveryPolicy = original ? original.configuration.toolDiscoveryPolicy
        : record.spec.execution?.nativeToolSearchMode === 'off'
          || baseTools.some(tool => toolDiscoveryDefinitions().some(control => control.name === tool.name))
          ? undefined : 'local-tool-search/v1';
      if (childAllocationPolicy && nativeChildRoles(record.spec).length) recoveryPolicies.childAllocationPolicy = childAllocationPolicy;
      const toolOptions = { ...(toolDiscoveryPolicy ? { toolDiscoveryPolicy } : {}),
        ...(recoveryPolicies.childCapabilityPolicy ? { childCapabilityPolicy: recoveryPolicies.childCapabilityPolicy } : {}),
        ...(childAllocationPolicy ? { childAllocationPolicy } : {}),
        ...(surfaceEpoch ? { workspaceMediaPolicy: 'bounded-image-read/v1' } : {}),
        ...((original ? original.configuration.tools.some(tool => tool.modelGuidance) : surfaceEpoch)
          ? { modelSurfacePolicy: 'bound-model-surface/v1' } : {}),
        ...(original ? { approvalDefinitions: original.configuration.tools }
          : binding.nativeTools.durableApprovalContract ? { approvalPolicy: binding.nativeTools.durableApprovalContract } : {}),
        ...(original ? { workspaceCheckpointDefinitions: original.configuration.tools,
          executionTimeoutDefinitions: original.configuration.tools } : { executionTimeoutPolicy: 'dispatch/v2' }),
        ...((original ? original.configuration.tools.some(tool => tool.workspaceEditPolicy) : true)
          ? { workspaceEditPolicy: original ? original.configuration.tools.find(tool => tool.workspaceEditPolicy).workspaceEditPolicy : 'zcode-match/v2' } : {}),
        // Old Runs retain the exact absence/selection of Plan exceptions.
        planModeMcpAccess: original ? original.configuration.tools.filter(tool => tool.planModeAccess).map(tool => tool.name) : !!planModePolicy,
        ...((original ? original.configuration.tools.some(tool => tool.planModeCommandPolicy) : !!planModePolicy)
          ? { planModeCommandPolicy: 'zcode-posix-readonly/v1' } : {}),
        deadlineDelivery: original
        ? original.configuration.limits.finalizationReserveWallMs > 0 || !!original.configuration.wallDeliveryPolicy
        : (record.spec.execution?.nativeLimits?.finalizationReserveWallMs ?? 0) > 0 || !!deadline.wallDeliveryPolicy,
      exactContentPolicy: original ? original.configuration.tools.some(tool => tool.exactContentPolicy) : true,
      ...((original ? original.configuration.tools.find(tool => tool.sourceObservationPolicy)?.sourceObservationPolicy : 'workspace-source-model/v1')
        ? { sourceObservationPolicy: original ? original.configuration.tools.find(tool => tool.sourceObservationPolicy).sourceObservationPolicy
          : 'workspace-source-model/v1' } : {}),
      ...((original ? original.configuration.tools.find(tool => tool.directoryObservationPolicy)?.directoryObservationPolicy : 'studio-directory-observation/v3')
        ? { directoryObservationPolicy: original ? original.configuration.tools.find(tool => tool.directoryObservationPolicy).directoryObservationPolicy
          : 'studio-directory-observation/v3' } : {}),
      ...((original ? original.configuration.wallDeliveryPolicy : deadline.wallDeliveryPolicy)
        ? { wallDeliveryPolicy: original ? original.configuration.wallDeliveryPolicy : deadline.wallDeliveryPolicy } : {}) };
      const boundToolDefinitions = binding.nativeTools.definitions(agent, input.assembly.tools, toolOptions);
      if (!original && toolDiscoveryPolicy && (boundToolDefinitions.some(tool => tool.discovery) || planModePolicy))
        recoveryPolicies.toolDiscoveryPolicy = toolDiscoveryPolicy;
      const tools = [...boundToolDefinitions, ...(recoveryPolicies.toolDiscoveryPolicy ? toolDiscoveryDefinitions() : []),
        ...(recoveryPolicies.deliveryScopePolicy ? deliveryToolDefinitions(recoveryPolicies.deliveryScopePolicy) : []),
        ...(recoveryPolicies.todoPolicy ? todoToolDefinitions(!!recoveryPolicies.toolDiscoveryPolicy) : []),
        ...(planModePolicy ? planModeToolDefinitions(!!recoveryPolicies.toolDiscoveryPolicy) : []),
        ...(recoveryPolicies.artifactPolicy ? artifactToolDefinitions() : [])];
      const artifactFactory = childScope => typeof binding.nativeTools.artifactsFor === 'function'
        ? binding.nativeTools.artifactsFor(childScope) : createNativeArtifactStore({ directory: join(storeDir, 'native-harness', 'result-artifacts'), scope: childScope });
      const taskPolicy = bindNativeTaskPolicy({ tools, nativeLimits: record.spec.execution?.nativeLimits, vision: !!visionDescription, execution: deadlineExecution });
      const materialized = original ? { memoryWrite: false } : await prepareLocalResourceContext({ record, input: admission.objective, resourceAdapter: resources,
        toolAdapter: {}, agent, agentId: binding.agentId, userId: scope.userId, resourceMode: 'context-only' });
      cloudMemory = await bindStudioNativeCloudMemoryTurn({ record, scope, sessionId, store, storeDir, resources,
        sealedCapsule, input: admission.objective, agent });
      invariant(!materialized.memoryWrite || cloudMemory, 'studio_native_memory_write_port_unavailable');
      const skillInstructions = await binding.nativeTools.skillInstructions?.(signal, { completeDirectory: surfaceEpoch });
      const instructions = original ? original.configuration.instructions : [systemPrompt, materialized.resourceContext,
        skillInstructions].filter(Boolean).join('\n\n');
      const verification = await createNativeVerification({ scope, sessionId, workspaceRoot,
        ...(recoveryPolicies.deliveryScopePolicy ? { deliveryScopePolicy: recoveryPolicies.deliveryScopePolicy } : {}),
        evidenceDirectory: join(storeDir, 'native-harness', 'verification-evidence'),
        verifyBrowserPage: taskPolicy.workspaceObservationPolicy && typeof binding.nativeTools.verifyBrowserPage === 'function'
          ? request => binding.nativeTools.verifyBrowserPage(agent, request, { scope, store }) : undefined });
      // Combine the baseline delivery verifier with the Memory owner verifier.
      // The wrapper is always present for a local-default Build (fail-closed for
      // explicit Memory tasks) and delegates to the baseline otherwise.
      const memoryVerification = memoryHost ? memoryHost.wrapVerification(verification) : null;
      const modelBinding = createStudioNativeModelBinding({ descriptions, models, fetchImpl, original, capabilityCapsule,
        capabilityConfiguration, modelCompatibilityRule, surfaceEpoch, recoveryPolicies, contextSpec: record.spec.context, contextDefaults });
      const parentModel = modelBinding(selected, selectedId, context, true), roles = nativeChildRoles(record.spec, { childAllocationPolicy });
      invariant(original || !execution || !agent.session.header?.isSeeded || !agent.session.header.parentSession
        || store.sessionHead(scope, sessionId), 'native_conversation_fork_managed_not_supported');
      const branchHead = !original && !execution ? store.sessionHead(scope, sessionId) : null;
      const branchAdmission = original ? { conversationRewind: original.configuration.conversationRewind }
        : execution ? {} : nativeConversationRewindAdmission({ session: agent.session,
          head: branchHead, turn, sameTurnConfiguration: branchHead?.turnId === String(turn)
            ? store.load(scope, branchHead.runId).configuration : undefined });
      // Only a new rewind admission adds this durability barrier. Ordinary
      // turns retain their existing delivery/flush path and cost.
      if (!original && branchAdmission.conversationRewind)
        invariant(await sessions.flush(agent.session) === true, 'native_conversation_rewind_not_durable');
      const conversationSeed = original ? original.configuration.conversationSeed : branchAdmission.conversationSeed ?? (execution ? undefined
        : await nativeConversationForkSeed({ ctx, agent, store, scope, turn, profile: parentModel.profile,
          tools, policies: recoveryPolicies, signal }));
      signal.throwIfAborted();
      if (visionProfile) {
        const observer = modelBinding(visionProfile, visionId);
        vision = createStudioNativeVisionBinding({ scope, sessionId, store, model: observer.model,
          profile: { ...observer.profile, imageInputMode: 'native' }, isClosed: () => lifetime.signal.aborted });
      }
      const childBinding = binding.nativeTools.childBindingFor?.({ childAllocationPolicy }) ?? binding.nativeTools.childBinding;
      invariant(!roles.length || canonical(childBinding?.roles) === canonical(roles), 'studio_native_child_revision_binding_changed');
      const childQuestionPreset = roles.length && binding.nativeTools.a2aBinding
        ? ctx.get('sessionProjections')?.stateOf?.(agent.session, 'agentPreset') : undefined;
      const children = await createStudioNativeChildren({ onStream: (identity, _event, record) => childObservations.accept(identity, record),
        roles, scope, sessionId, store, tools, mediaSources: childMediaSources,
        ...(inputContextPolicy === NATIVE_CURRENT_INSTRUCTION_OWNERSHIP ? { workspaceContext } : {}),
        ...(recoveryPolicies.childCapabilityPolicy ? { childCapabilityPolicy: recoveryPolicies.childCapabilityPolicy,
          outputRecoveryPolicy: recoveryPolicies.outputRecoveryPolicy } : {}),
        ...(recoveryPolicies.childTaskPolicy ? { childTaskPolicy: recoveryPolicies.childTaskPolicy } : {}),
        ...(recoveryPolicies.toolExecutionPolicy ? { toolExecutionPolicy: recoveryPolicies.toolExecutionPolicy } : {}),
        ...(childAllocationPolicy ? { childAllocationPolicy } : {}),
        ...(modelSurface ? { modelSurface } : {}),
        ...(recoveryPolicies.childPlanPolicy ? { childPlanPolicy: recoveryPolicies.childPlanPolicy } : {}),
        isClosed: () => lifetime.signal.aborted,
        fileWorkspaces: roles.length ? createStudioNativeChildWorkspaces({ workspaceRoot,
          stateDir: join(storeDir, 'native-harness') }) : null,
        commandResource: childCommandResource(commandBinding),
        hasSkills: Boolean(record.spec.bindings?.skills?.length || binding.nativeTools.childCapabilities?.skills),
        hasMcp: Boolean(record.spec.bindings?.mcpServers?.length || binding.nativeTools.childCapabilities?.mcp),
        mcpBinding: binding.nativeTools.childMcpBinding,
        a2aBinding: binding.nativeTools.a2aBinding,
        waitForChildReceipt: ({ snapshot, tools: childTools, signal: childSignal }) => {
          invariant(typeof childQuestionPreset === 'string' && childQuestionPreset
            && ctx.get('sessionProjections')?.stateOf?.(agent.session, 'agentPreset') === childQuestionPreset,
          'A2A_QUESTION_AUTHORITY_LOST');
          return createNativeHostInteraction({ ctx, store })({ agent, signal: AbortSignal.any([signal, childSignal]) }, snapshot,
            { waitForToolReceipt: childTools.waitForReceipt });
        },
        skillBinding: binding.nativeTools.childSkillBinding, skillInstructions,
        resolveModel: async id => {
          if (id === null) return parentModel;
          const index = ids.indexOf(id);
          invariant(index >= 0, 'studio_native_child_model_unbound');
          return modelBinding(profiles[index], id);
        },
        bindTools: authority => binding.nativeTools.forChild(agent, { ...authority,
          ...(localExecution?.resourceProfile ? { localExecution } : {}),
          ...(childAllocationPolicy ? { childAllocationPolicy } : {}) }),
        ...(recoveryPolicies.artifactPolicy ? { artifactPolicy: recoveryPolicies.artifactPolicy, artifactFactory } : {}),
        ...(recoveryPolicies.sourceReadPolicy ? { sourceReadPolicy: recoveryPolicies.sourceReadPolicy } : {}),
        verificationFactory: child => createNativeVerification({ ...child, workspaceRoot: child.workspaceRoot ?? workspaceRoot,
          evidenceDirectory: join(storeDir, 'native-harness', 'verification-evidence') }),
      });
      const ownedChildren = children && { scope, owner: children.owner, runIds: new Set() };
      if (ownedChildren) childOwners.add(ownedChildren);
      signal.throwIfAborted();
      const hookOptions = { scope, sessionId, record, buildId: binding.buildId ?? null, store };
      const memoryRecall = bindStudioNativeMemoryRecall({ ...hookOptions, storeDir });
      registeredContext = contextSourceRegistry?.bind({ ...hookOptions, expectedRuntimeBuildId: buildId });
      const workspaceInstructions = inputContextPolicy === NATIVE_CURRENT_INSTRUCTION_OWNERSHIP
        ? createNativeWorkspaceInstructions(workspaceContext) : null;
      const contextSources = [...(workspaceInstructions ? [workspaceInstructions.source] : []),
        ...(memoryRecall ? [memoryRecall.source] : []), ...(registeredContext?.sources ?? [])];
      invariant(new Set(contextSources.map(source => source.sourceId)).size === contextSources.length,
        'studio_native_context_source_collision');
      const readContextSource = request => {
        if (workspaceInstructions && request.source.sourceId === workspaceInstructions.source.sourceId) return workspaceInstructions.readSource(request);
        if (memoryRecall && request.source.sourceId === memoryRecall.source.sourceId) return memoryRecall.readSource(request);
        invariant(registeredContext?.sources.some(source => source.sourceId === request.source.sourceId),
          'studio_native_context_source_unbound');
        return registeredContext.readSource(request);
      };
      const memoryHooks = bindStudioNativeMemoryFlush({ ...hookOptions, storeDir, contextWindow: context.profile.contextWindow });
      let registeredHooks, hooks;
      try { registeredHooks = hookRegistry?.bind(hookOptions); hooks = composeStudioNativeHooks(registeredHooks, memoryHooks); }
      catch (error) { await registeredHooks?.close(); await memoryHooks?.close(); throw error; }
      const memoryProviderRef = memoryHost?.policy.providerRef ?? 'local-default';
      const componentBinding = binding.nativeTools.componentContract ? studioNativeComponentStatus({ record,
        modelName: selected.modelName, workspaceRoot, tools, commandBinding, codeBinding: binding.nativeTools.codeBinding,
        remoteSkillBinding: binding.nativeTools.remoteSkillBinding,
        localMemoryBound: Boolean(memoryHost?.policy.enabled) }) : null;
      const toolPorts = binding.nativeTools.forAgent(agent, { scope, store, commandProgress,
        ...(localExecution ? { localExecution } : {}),
        ...(componentBinding ? { componentBinding } : {}), ...(children ? { children } : {}) });
      if (vision) toolPorts.tools = vision.wrapTools(toolPorts.tools);
      const resolved = { scope, buildId, source,
        // Optional completed-Turn consumption: the Memory owner consumes only
        // original current-Run human inputs after the committed terminal. It
        // never rewrites the main answer/usage/verification; the executor wraps
        // it so a failure cannot replace the task terminal.
        consumeCompletedTurn: async (snapshot, { signal } = {}) => {
          // The completed-Turn consumer passes the full call context
          // ({scope, runId, operationKey, call, definition, toolResultContent,
          // signal}); forward all of it to the locked tool port so the bound
          // definition and principal stay on the receipt. A non-matching passed
          // scope is rejected; the Host's bound scope is the trusted default the
          // locked port requires. The owner receipt the port returns is the raw
          // sealed result, deep-equal to the ledger tool result content — never a
          // forged JSON body.
          const directWriteReceipt = memoryHost?.port ? async ({ scope: receiptScope, runId, operationKey, call, definition, signal }) => {
            if (receiptScope !== undefined && canonical(receiptScope) !== canonical(scope)) return null;
            const result = await memoryHost.port.reconcile({ call, definition, scope: copy(scope), operationKey, signal });
            if (result.status === 'ok' && result.content.receipt?.committed === true) return result.content.receipt;
            return null;
          } : undefined;
          const result = await memoryHost?.memoryTurn?.consume(snapshot, { signal, directWriteReceipt });
          // Persist before releasing this turn's ports; dispatch owns fresh
          // model/Memory bindings and does not delay delivery of the main answer.
          // Managed receivers use their own ledger/lifetime and are not granted
          // access to this local Host's auxiliary dispatcher.
          if (store === localStore) memoryExtraction.schedule({ scope, sessionId, runId: snapshot.runId,
            record, buildId: binding.buildId ?? null });
          return result;
        },
        releaseResources: async request => {
          // The Memory consumer/tool owner and its database are released in a
          // finally so a failure in hooks/children/nativeTools release cannot
          // leak the Memory provider. The committed terminal and the
          // completed-Turn consumer have already finished before this runs.
          try {
            let questionError;
            try {
              const snapshot = (store.authority ? store.authority(scope, request.runId) : store.load(scope, request.runId)).snapshot;
              if (typeof toolPorts.tools.settleQuestions === 'function') {
                toolPorts.tools.settleQuestions(snapshot);
                if (['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase))
                  store.acknowledge(scope, request.runId, NATIVE_A2A_QUESTION_CLEANUP, snapshot.eventSeq);
              }
            }
            catch (error) { if (error.code !== 'run_not_found') questionError = error; }
            await hooks?.close();
            if (ownedChildren) {
              ownedChildren.runIds.add(request.runId);
              let phase;
              try { phase = (store.authority ? store.authority(scope, request.runId) : store.load(scope, request.runId)).snapshot.phase; }
              catch (error) { if (error.code !== 'run_not_found') throw error; }
              if (!phase || signal.aborted || ['completed', 'failed', 'canceled', 'interrupted'].includes(phase)) {
                await children.owner.releaseRun(request); childOwners.delete(ownedChildren);
              }
            }
            await binding.nativeTools.releaseSession?.(request);
            if (questionError) throw questionError;
          } finally {
            try { vision?.close(); visionDispose?.(); registeredContext?.close(); memoryDispose?.(); memoryHost?.close(); }
            finally { try { cloudMemory?.close(); } finally { releaseBinding(); } }
          }
        },
        taskContractFactory: facts => extendNativeMemoryGoal(facts.goal,
          nativeGoalContract({ sessionId: facts.sessionId, parentRunId: facts.parentRunId, goal: facts.goal }),
          { providerRef: memoryProviderRef }),
        configuration: { ...restoredPolicyConfiguration(original),
        ...(modelSurface ? { modelSurface } : {}),
        ...(!original ? { sessionInjectionPolicy: 'next-turn-inbox/v1' } : {}), profile: parentModel.profile, modelRecoveryPolicy: parentModel.modelRecoveryPolicy, ...recoveryPolicies,
        ...(conversationSeed === undefined ? {} : { conversationSeed }),
        ...(branchAdmission.conversationRewind === undefined ? {} : { conversationRewind: branchAdmission.conversationRewind }),
        ...(contextSources.length ? { contextSources } : {}),
        ...(hooks ? { hooks: hooks.definitions, stopHookContinuationLimit: hooks.stopContinuationLimit } : {}),
        hostRecoveryBinding: sealedCapsule,
        hostBindingDigest: hash({ agentId: binding.agentId, revision: binding.agentRevision, buildId, source, tools, workspaceId,
          ...(binding.boundToolPolicy ? { boundToolPolicy: binding.boundToolPolicy } : {}),
          inputContract: 'agentkit.native-host-input/v1', contextPolicy: context.policy, ...recoveryPolicies,
          interactionContract: STUDIO_NATIVE_INTERACTION_CONTRACT,
          ...(contextSources.length ? { contextSources } : {}),
          ...(hooks ? { hookContract: STUDIO_NATIVE_HOOK_CONTRACT, hooks: hooks.definitions,
            stopHookContinuationLimit: hooks.stopContinuationLimit } : {}),
          ...(children ? { childContract: STUDIO_NATIVE_CHILD_CONTRACT, childRoles: roles } : {}),
          ...(memoryHost ? { memoryHostContract: memoryHost.contract,
            memoryHostBinding: memoryHost.hostBindingDigest, memoryVerification: memoryHost.verificationDigest } : {}),
          ...(cloudMemory ? { cloudMemoryTurn: cloudMemory.binding } : {}),
          toolArgumentEncoding: binding.nativeTools.argumentEncoding ?? null,
          toolPermissionContract: binding.nativeTools.permissionContract ?? null,
          ...(binding.nativeTools.workspaceSyntax ? { workspaceSyntax: binding.nativeTools.workspaceSyntax } : {}),
          ...(binding.nativeTools.workspaceMutationContract ? { workspaceMutationContract: binding.nativeTools.workspaceMutationContract } : {}),
          ...(commandBinding ? { commandBinding } : {}),
          ...(binding.nativeTools.codeBinding ? { codeBinding: binding.nativeTools.codeBinding } : {}),
          ...(componentBinding ? { componentBinding } : {}),
          ...(binding.nativeTools.webBinding ? { webBinding: binding.nativeTools.webBinding } : {}),
          ...(binding.nativeTools.a2aBinding ? { a2aBinding: binding.nativeTools.a2aBinding } : {}),
          ...(binding.nativeTools.remoteSkillBinding ? { remoteSkillBinding: binding.nativeTools.remoteSkillBinding } : {}),
          ...(binding.nativeTools.skillManagementBinding ? { skillManagementBinding: binding.nativeTools.skillManagementBinding } : {}),
          ...(binding.nativeTools.knowledgeBinding ? { knowledgeBinding: binding.nativeTools.knowledgeBinding } : {}),
          ...(binding.nativeTools.legacyMemoryBinding ? { legacyMemoryBinding: binding.nativeTools.legacyMemoryBinding } : {}),
          ...(vision ? { visionBinding: vision.binding } : {}),
          mcpResultContract: binding.nativeTools.mcpResultContract ?? null,
          ...(binding.nativeTools.skillDisclosureBindingDigest ? { skillDisclosureBindingDigest: binding.nativeTools.skillDisclosureBindingDigest } : {}),
          mcpJsonCodec: binding.nativeTools.mcpJsonCodec ?? null,
          mcpSchemaContract: binding.nativeTools.mcpSchemaContract ?? null,
          mcpBindingDigest: binding.nativeTools.mcpBindingDigest ?? null,
          taskPolicyContract: STUDIO_NATIVE_TASK_POLICY_CONTRACT, taskPolicy,
          verificationContract: STUDIO_NATIVE_VERIFICATION_CONTRACT }),
        contextPolicy: context.policy, guidancePolicy: 'boundary-guide/v1',
        ...(children ? { childLifecyclePolicy: 'owned-background/v2', childApprovalPolicy: 'owned-child-approval/v1',
          childPromotionPolicy: 'owned-child-promotion/v1', childInputPolicy: 'owned-child-input/v1' } : {}),
        workspaceObservationPolicy: taskPolicy.workspaceObservationPolicy,
        ...(commandBinding ? { backgroundNotificationPolicy: 'completed-before-model/v1' } : {}),
        contract: extendNativeMemoryGoal(admission.objective,
          nativeGoalContract({ sessionId, goal: admission.objective }), { providerRef: memoryProviderRef }),
        instructions, inputMessages: admission.messages,
        tools, limits: { ...taskPolicy.limits, effectTimeoutMs: Math.max(120000, description.requestTimeoutMs + 10000,
          ...(visionDescription ? [description.requestTimeoutMs + visionDescription.requestTimeoutMs + 10000,
            ...tools.filter(tool => tool.name === 'browser_inspect_workspace').map(tool => tool.timeoutMs + visionDescription.requestTimeoutMs + 10000)] : []),
          (hooks?.requiredEffectTimeoutMs ?? 0) + 1,
          ...roles.map(role => role.timeoutSeconds * 1000 + 15000), ...tools.map(tool => tool.timeoutMs + 10000)) } },
        ports: { ...toolPorts, ...(recoveryPolicies.artifactPolicy ? { artifacts: await artifactFactory(scope) } : {}),
          ...(hooks ? { hooks } : {}),
          ...(children ? { children: children.owner } : {}), verification: memoryVerification ?? verification,
          context: { ...context.port, ...(contextSources.length ? { readSource: readContextSource } : {}) }, input: { prepare: async request => {
          request.signal.throwIfAborted();
          if (workspaceContext) await ensureNativeWorkspaceContext({ binding: workspaceContext,
            directory: workspaceContextPort.directory, signal: request.signal });
          const instructionEvidence = store.workspaceTouchEvidence
            ? store.workspaceTouchEvidence(scope, request.runId) : store.load(scope, request.runId);
          const instructionPaths = binding.nativeTools.instructionTouches?.(agent, instructionEvidence) ?? [];
          const instructionInput = workspaceInstructions ? { instructionScopes: await workspaceInstructions.scopes(
            instructionEvidence.instructionScopes ?? instructionEvidence.snapshot?.context.instructionScopes,
            instructionPaths, request.signal) } : {};
          if (!workspaceInstructions && instructionPaths.length) {
            invariant(typeof agentEvents === 'function', 'studio_native_instruction_dispatch_unavailable');
            agentEvents(ctx, agent).emit('agent-instructions/touch', { paths: instructionPaths });
          }
          const next = await prepareInput(request.step);
          request.signal.throwIfAborted();
          invariant(next && ['enter', 'reject'].includes(next.kind), 'studio_native_prepared_input_invalid');
          if (next.kind === 'reject') return { status: 'rejected', messages: [] };
          // A changing model/tool series needs an explicit Native rebind, not
          // an unlogged change to the frozen execution contract.
          invariant(next.startsRequestSeries !== true, 'studio_native_request_series_rebind_required');
          const nextSelection = admittedModelSelection({ options: inputSelection }, next.assembly);
          invariant(nextSelection.provider === inputSelection.provider && nextSelection.model === inputSelection.model,
            'studio_native_input_model_binding_changed');
          invariant(renderPrompt(promptAssembly(original ? recoveredPromptAssembly(next.assembly, source) : next.assembly)) === systemPrompt,
            'studio_native_input_prompt_binding_changed');
          invariant(canonical(binding.nativeTools.definitions(agent, next.assembly.tools, toolOptions)) === canonical(boundToolDefinitions),
            'studio_native_input_tool_binding_changed');
          invariant(Array.isArray(next.messages), 'studio_native_prepared_input_invalid');
          // The post-candidate drain must still catch real queued work. SDK
          // step preparation also samples clock/runtime snapshots even when
          // no work arrived; treating those refreshers as new work would
          // discard every final answer and loop until the model budget ends.
          const candidate = (store.authority ? store.authority(scope, request.runId) : store.load(scope, request.runId)).snapshot.candidate;
          const modeInput = planModePolicy ? { planMode: currentPlanActive() } : {};
          const nextRows = nativeHostInputRows(next.messages, inputContextPolicy);
          if (candidate && nativeHostInputIsRefresh(nextRows, inputContextPolicy))
            return { status: 'admitted', messages: [], ...modeInput, ...instructionInput };
          const messages = [], images = new Map();
          for (const { message } of nextRows) {
            invariant(message?.role === 'user' && Array.isArray(message.content), 'studio_native_prepared_input_invalid');
            const context = await projectNativeDshContent(message.content, { ...inputServices, signal: request.signal }, images);
            if (message.source !== undefined) context.presentation.source = structuredClone(message.source);
            messages.push({ ...context, retention: !message.source || ['user', 'schedule'].includes(message.source.kind) ? 'persistent' : 'normal' });
          }
          request.signal.throwIfAborted();
          return { status: 'admitted', messages, ...modeInput, ...instructionInput };
        } }, model: parentModel.model },
      };
      if (cloudMemory) {
        const localConsume = resolved.consumeCompletedTurn;
        resolved.consumeCompletedTurn = (snapshot, { signal } = {}) => Promise.allSettled([
          Promise.resolve().then(() => localConsume?.(snapshot, { signal })),
          cloudMemory.consume(snapshot, { signal, hostBindingDigest: resolved.configuration.hostBindingDigest }).catch(error => {
            console.warn('[agentkit-studio] Native cloud Memory completion failed:', error?.code ?? 'MEMORY_WRITE_FAILED'); throw error;
          }),
        ]);
      }
      transferred = true; return resolved;
      } catch (error) { cloudMemory?.close(); vision?.close(); visionDispose?.(); registeredContext?.close(); memoryDispose?.(); memoryHost?.close(); throw error; }
      } catch (error) { visionDispose?.(); throw error; }
      } finally { if (!transferred) releaseBinding(); }
  };
  const resolveRestoredBinding = async (payload, original, execution) => {
    invariant(typeof agentEvents === 'function' && typeof assembleContextFor === 'function', 'studio_native_recovery_dispatch_unavailable');
    const capsule = readNativeRecoveryBinding({ configuration: original.configuration,
      snapshot: { ...original.identity, configDigest: original.configDigest } }, {
      agentId: original.identity.scope.agentId, sessionId: original.identity.sessionId, runId: original.identity.runId });
    invariant(canonical(capsule.messages) === canonical(original.messages)
      && canonical(capsule.source) === canonical(original.source), 'studio_native_recovery_admission_mismatch');
    const binding = await agentEvents(ctx, payload.agent).serial('agentkit/native-recovery-binding', {});
    payload.signal.throwIfAborted();
    assertNativeRecoveryPreset(capsule, binding);
    const pendingSelection = projections.stateOf(payload.agent.session, 'modelSelection')?.pending;
    invariant(!pendingSelection || pendingSelection.provider === capsule.source.provider && pendingSelection.model === capsule.source.model,
      'studio_native_recovery_model_selection_changed');
    const prompt = ctx.get('systemPrompt');
    invariant(typeof prompt?.assemble === 'function', 'studio_native_recovery_prompt_unavailable');
    const assembly = await prompt.assemble(assembleContextFor(payload.agent, payload.signal));
    payload.signal.throwIfAborted();
    return resolveBinding({ ...payload, binding, input: { ...payload.input, assembly } }, { ...original, capsule }, execution);
  };
  const resolveBackgroundBinding = createStudioNativeBackgroundBinding({ store, resolveRestoredBinding });
  const execute = createNativeDshTurnExecutor({ store, projections, durableOwnership: true, flush: session => sessions.flush(session),
    publishStreamFrame, streamRevisions, onIdle: createNativeHostInteraction({ ctx, store }),
    onCheckpoint: (_payload, snapshot) => { traceProjection?.checkpoint(snapshot); },
    onActive: installControl,
    onDriverError: diagnostic => console.error('[agentkit-studio] Native driver stopped:', JSON.stringify(diagnostic)),
    resolveTurn: payload => resolveBinding(payload),
    resolveRecoveryTurn: resolveRestoredBinding,
    resolveBackgroundTurn: resolveBackgroundBinding,
  });
  const memoryExtraction = createStudioNativeMemoryExtractionBinding({ store, storeDir, workspaceId, lifetime, builds, agents, models, fetchImpl });
  memoryExtraction.recover();
  const workspaceStatus = createWorkspaceGitStatus({ workspaceRoot, lifetimeSignal: lifetime.signal });
  const recovery = createStudioNativeRecovery({ ctx, store, workspaceId, workspaceRoot, lifetime, active, controls, controlKey, execute, agentEvents,
    commandProgressStatus: record => commandProgress.read(record),
    workspaceStatus: signal => workspaceStatus.read(signal),
    cloudMemoryStatus: record => readStudioNativeCloudMemoryTurn({ record, store, storeDir }),
    memoryExtractionStatus: record => record.snapshot.scope.tenantId === 'local'
      && record.snapshot.scope.workspaceId === workspaceId && record.snapshot.scope.userId === 'local-user'
      ? memoryExtraction.status({ scope: record.snapshot.scope, sessionId: record.snapshot.sessionId }) : undefined });
  const commandOutput = createStudioNativeCommandOutput({ ctx, store, recovery, agentEvents, lifetime, project: projectOperatorCommandOutput });
  const childFile = createStudioNativeChildFile({ workspaceRoot, stateDir: join(storeDir, 'native-harness'),
    isClosed: () => closed, resolveOwnedChild: async (request, signal) => {
      const query = Object.fromEntries(['agentId', 'sessionId', 'runId', 'childRunId'].map(key => [key, request[key]]));
      const inspected = await recovery.inspect({ agentId: query.agentId, sessionId: query.sessionId, runId: query.runId }, signal);
      invariant(!inspected.managed && inspected.record && inspected.agent?.session?.id === query.sessionId,
        'studio_native_child_file_owner_unavailable');
      const parent = inspected.record, capsule = readNativeRecoveryBinding(parent, query);
      const binding = await agentEvents(ctx, inspected.agent).serial('agentkit/native-recovery-binding', {});
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted(); assertNativeRecoveryPreset(capsule, binding);
      const record = childHistory(query).record(query), identity = canonical(record.configuration);
      const assertCurrent = () => {
        signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
        invariant(!closed && canonical(childHistory(query).record(query).configuration) === identity,
          'studio_native_child_file_owner_changed');
        binding.nativeTools?.assertConversationWorkspaceSettled?.(inspected.agent);
        return true;
      };
      assertCurrent(); return { record, assertCurrent };
    } });
  const conversation = createStudioNativeConversation({ ctx, store, workspaceId, lifetime, agentEvents,
    activeControl: request => controls.get(controlKey(request.agentId, request.sessionId)) });
  const controlA2aTask = createStudioNativeA2aControl({ ctx, store, workspaceId, lifetime, active, agentEvents,
    childRecord: request => childHistory(request).record(request) });
  const managedScopeControl = createStudioNativeManagedScopeControl({ ctx, workspaceId, lifetime, active, agentEvents, readChildren });
  const notifyBackgroundCompletion = createStudioNativeBackgroundAdmission({ ctx, store, workspaceId, lifetime, active, execute, agentEvents,
    isRewinding: conversation.isRewinding });
  const dispatchBackgroundCompletion = createStudioNativeBackgroundDispatcher({ ctx, store, workspaceId, lifetime, active, notify: notifyBackgroundCompletion });
  const startWaitRecovery = ({ signal } = {}) => {
    invariant(signal === undefined || signal instanceof AbortSignal, 'studio_native_recovery_signal_invalid');
    const starting = waitRecoveryStart.then(async () => {
      lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
      await waitRecoveryOwner?.close();
      const { createNativeWaitRecoveryWorker } = await import('./native-wait-recovery-worker.mjs');
      const controller = new AbortController();
      const workerSignal = AbortSignal.any([lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
      workerSignal.throwIfAborted();
      // Terminal heads need one ownership inspection per dependency generation:
      // the question cursor alone cannot prove the DSH turn/end was durable.
      const settledHeads = new Set();
      const checkpointKey = snapshot => canonical({ scope: snapshot.scope, runId: snapshot.runId, revision: snapshot.revision });
      const worker = createNativeWaitRecoveryWorker({ signal: workerSignal,
        listCandidates: async scanSignal => {
          scanSignal.throwIfAborted();
          const principal = { tenantId: 'local', workspaceId, userId: 'local-user' };
          const scopes = typeof store.listScopes === 'function' ? store.listScopes(principal)
            : (await agents.list({ includeTeamRoles: true })).filter(row => row.metadata?.local === true)
              .map(row => ({ ...principal, agentId: row.metadata.id }));
          scanSignal.throwIfAborted();
          const candidates = [];
          for (const scope of scopes) for (const snapshot of typeof store.listHeads === 'function' ? store.listHeads(scope) : store.list(scope)) {
            scanSignal.throwIfAborted();
            if (!['awaiting_reconciliation', 'preparing_context', 'executing_tools', 'verifying', 'completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)) continue;
            if (settledHeads.has(checkpointKey(snapshot))) continue;
            if (snapshot.lease && snapshot.lease.expiresAt > Date.now()) continue;
            const record = store.load(scope, snapshot.runId);
            if (record.configuration.childOwnerBinding || record.lease && record.lease.expiresAt > Date.now()) continue;
            const waiting = nativeA2aReceiptWaitSource(record) || nativeChildA2aWaitSource({ store, record })
              || canCloseNativeReadInterruption(record);
            const cleanup = !waiting && ['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)
              && ((record.projections[NATIVE_A2A_QUESTION_CLEANUP] ?? 0) < snapshot.eventSeq
                || snapshot.phase !== 'interrupted' && store.sessionHead(scope, snapshot.sessionId)?.runId === snapshot.runId)
              && record.intents.some(intent => intent.kind === 'tool' && intent.payload.calls?.some(call => call.name === 'call_a2a_agent'));
            if (waiting || cleanup) candidates.push({ scope, sessionId: snapshot.sessionId, runId: snapshot.runId });
            else {
              settledHeads.add(checkpointKey(snapshot));
              if (settledHeads.size > 4096) settledHeads.delete(settledHeads.values().next().value);
            }
          }
          return candidates;
        },
        restore: async (candidate, scanSignal) => {
          const outcome = await recovery.automatic({ agentId: candidate.scope.agentId,
            sessionId: candidate.sessionId, runId: candidate.runId }, scanSignal);
          scanSignal.throwIfAborted();
          if (['settled', 'cleaned'].includes(outcome.status))
            settledHeads.add(checkpointKey(store.load(candidate.scope, candidate.runId).snapshot));
          if (settledHeads.size > 4096) settledHeads.delete(settledHeads.values().next().value);
          return outcome;
        },
        onError: error => console.error('[agentkit-studio] Native wait recovery:', error.code),
      });
      let stopped;
      const owner = { status: () => worker.status(), close() {
        if (stopped) return stopped;
        controller.abort(new Error('Studio wait recovery discovery retired'));
        return stopped = worker.close().finally(() => { if (waitRecoveryOwner === owner) waitRecoveryOwner = undefined; });
      } };
      waitRecoveryOwner = owner;
      try { await worker.start(); workerSignal.throwIfAborted(); return owner; }
      catch (error) { await owner.close(); throw error; }
    });
    waitRecoveryStart = starting.then(() => {}, () => {});
    return starting;
  };
  const startBackgroundWatcher = ({ signal } = {}) => {
    invariant(signal === undefined || signal instanceof AbortSignal, 'studio_native_background_signal_invalid');
    const starting = backgroundStart.then(async () => {
      invariant(!closed, 'studio_native_host_closed');
      signal?.throwIfAborted();
      await backgroundOwner?.close();
      const [{ createNativeBackgroundWatchStore }, { createStudioNativeBackgroundWatcher }] = await Promise.all([
        import('./native-background-watch-store.mjs'), import('./native-background-watcher.mjs'),
      ]);
      invariant(!closed, 'studio_native_host_closed');
      signal?.throwIfAborted();
      // The configured home is a trusted root and may use a platform alias
      // (macOS /var -> /private/var). Canonicalize only that root; the registry
      // still rejects symlinks in every owned descendant and state file.
      const backgroundRoot = await realpath(storeDir);
      invariant(!closed, 'studio_native_host_closed');
      signal?.throwIfAborted();
      backgroundRegistry ??= createNativeBackgroundWatchStore(join(backgroundRoot, 'native-harness', 'background-watches', 'registry.sqlite'));
      const controller = new AbortController();
      const watcher = createStudioNativeBackgroundWatcher({ store, watches: backgroundRegistry,
        signal: AbortSignal.any([lifetime.signal, controller.signal, ...(signal ? [signal] : [])]),
        listScopes: async () => {
          if (typeof store.listScopes === 'function') return store.listScopes({ tenantId: 'local', workspaceId, userId: 'local-user' });
          // Injected test/custom stores without the Host discovery extension
          // can enumerate current local Agents; production SQLite uses durable
          // ledger identities, including deleted Agent drafts and team roles.
          const rows = await agents.list({ includeTeamRoles: true });
          invariant(Array.isArray(rows), 'studio_native_background_agent_list_invalid');
          const ids = rows.filter(row => row.metadata?.local === true).map(row => row.metadata.id);
          invariant(ids.every(id => typeof id === 'string' && id.trim() && id.length <= 256),
            'studio_native_background_agent_list_invalid');
          return [...new Set(ids)].map(agentId => ({ tenantId: 'local', workspaceId, userId: 'local-user', agentId }));
        },
        dispatch: dispatchBackgroundCompletion,
        onError: error => console.error('[agentkit-studio] Native background watcher:', error.code),
      });
      let stopped;
      const owner = { status: () => watcher.status(), close() {
        if (stopped) return stopped;
        controller.abort(new Error('Studio background watcher retired'));
        return stopped = Promise.resolve().then(() => watcher.close()).finally(() => {
          if (backgroundOwner === owner) backgroundOwner = undefined;
        });
      } };
      backgroundOwner = owner;
      try {
        await watcher.start();
        lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
        return owner;
      }
      catch (error) { await owner.close(); throw error; }
    });
    backgroundStart = starting.then(() => {}, () => {});
    return starting;
  };
  return {
    injectSession: sessionInjection.inject,
    resolveInjectionScope: sessionInjection.resolveScope,
    async resolveManagedBinding(payload, { store: managedStore, admission, runId, target, principal }) {
      invariant(!closed && typeof managedStore?.load === 'function'
        && typeof runId === 'string' && runId && typeof principal?.userId === 'string' && principal.userId.trim(),
      'NATIVE_MANAGED_STUDIO_BINDING_INVALID');
      invariant(typeof agentEvents === 'function' && typeof assembleContextFor === 'function', 'studio_native_recovery_dispatch_unavailable');
      const scope = { tenantId: target.tenantId, workspaceId, userId: principal.userId, agentId: target.agentInstanceId };
      const execution = { store: managedStore, scope };
      let resolved, input = payload.input;
      if (admission) {
        invariant(canonical(admission.scope) === canonical(scope), 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
        const configuration = admission.configuration;
        const identity = { scope, runId, sessionId: payload.agent.session.id,
          buildId: admission.buildId, turnId: input.messages[0].id, parentRunId: null, taskChainId: runId };
        const capsule = readNativeRecoveryBinding({ configuration, snapshot: { ...identity, configDigest: hash(configuration) } },
          { agentId: scope.agentId, sessionId: identity.sessionId, runId });
        input = { kind: 'enter', messages: copy(capsule.messages) };
        resolved = await resolveRestoredBinding({ ...payload, input }, { identity, configuration,
          configDigest: hash(configuration), messages: capsule.messages, source: capsule.source }, execution);
      } else {
        const binding = await agentEvents(ctx, payload.agent).serial('agentkit/native-recovery-binding', {});
        payload.signal.throwIfAborted();
        invariant(binding?.agentId === scope.agentId, 'NATIVE_MANAGED_STUDIO_TARGET_CHANGED');
        const prompt = ctx.get('systemPrompt');
        invariant(typeof prompt?.assemble === 'function', 'studio_native_recovery_prompt_unavailable');
        const assembly = await prompt.assemble(assembleContextFor(payload.agent, payload.signal));
        payload.signal.throwIfAborted();
        resolved = await resolveBinding({ ...payload, input: { ...input, assembly }, binding }, undefined, execution);
      }
      try {
        invariant(resolved, 'NATIVE_MANAGED_STUDIO_BINDING_INVALID');
        const configuration = freezeNativeDshConfiguration(resolved, input, admission?.configuration.contract);
        invariant(!admission || resolved.buildId === admission.buildId
          && canonical(configuration) === canonical(admission.configuration), 'native_dsh_recovery_configuration_changed');
        return { ...resolved, configuration,
          onIdle: (snapshot, { signal, assertCurrent }) => {
            if (!nativeA2aReceiptWaitSource(managedStore.load(scope, runId))) return null;
            const control = controlFor({ agentId: scope.agentId, sessionId: payload.agent.session.id, runId });
            invariant(control.store === managedStore, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
            return createNativeHostInteraction({ ctx, store: managedStore })({ agent: payload.agent, signal, assertCurrent }, snapshot,
              { waitForToolReceipt: resolved.ports.tools.waitForReceipt });
          },
          bindControls: ({ ownership, signal }, control) => {
            const owned = readNativeDshManagedOwnership(ownership, { sessionId: payload.agent.session.id });
            invariant(control.runId === runId && control.sessionId === payload.agent.session.id
              && canonical(control.scope) === canonical(scope) && owned.identity.runId === runId
              && canonical(owned.identity.scope) === canonical(scope) && owned.configDigest === hash(configuration),
            'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
            const session = payload.agent.session, expectedOwner = canonical(ownership);
            const assertCurrent = () => {
              signal.throwIfAborted(); lifetime.signal.throwIfAborted();
              invariant(!closed && payload.agent.session === session
                && canonical(payload.agent.externalTurns?.pending() ?? null) === expectedOwner
                && managedStore.load(scope, runId).snapshot.configDigest === owned.configDigest,
              'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
              const snapshot = managedStore.load(scope, runId).snapshot;
              invariant(['runId', 'sessionId', 'turnId', 'buildId', 'parentRunId', 'taskChainId']
                .every(key => snapshot[key] === owned.identity[key]), 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
            };
            assertCurrent();
            return installControl(payload, { ...control, store: managedStore, assertCurrent });
          },
          createLiveStream: ({ turn, beginStep }) => nativeLiveStream({ agent: payload.agent, runId, turn,
            beginStep, revisions: streamRevisions, configuration,
            publish: publishStreamFrame ? frame => publishStreamFrame(payload, frame) : undefined }) };
      } catch (error) {
        await resolved?.releaseResources?.({ scope, sessionId: payload.agent.session.id, runId });
        throw error;
      }
    },
    startWaitRecovery,
    waitRecoveryStatus: () => waitRecoveryOwner?.status() ?? { running: false, started: false },
    startBackgroundWatcher,
    backgroundStatus: () => backgroundOwner?.status() ?? { running: false, started: false },
    notifyBackgroundCompletion,
    dispatchBackgroundCompletion,
    recoveryStatus: recovery.status,
    resumeTurn: recovery.resume,
    reviewBackgroundInterruption: recovery.reviewBackground,
    retireResources: recovery.retireResources,
    reconcileTool: recovery.reconcile,
    repairWorkspace: recovery.repairWorkspace,
    conversationStatus: conversation.status,
    rewindConversation: conversation.rewind,
    previewConversationWorkspace: conversation.previewWorkspace,
    controlA2aTask,
    managedScopeControl,
    childHistory(request, signal) { return readChildren(request, signal); },
    childResult(request, signal) { return readChildren(request, signal, true); },
    childFile(request, signal) { return childFile.read(request,
      signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal); },
    commandOutput(request, signal) { return commandOutput(request, signal); },
    childTasks(request) {
      const { kernel, scope, runId } = controlFor(request);
      return { contract: 'agentkit.studio-native-child-control/v1', runId, tasks: kernel.childTasks(scope, runId) };
    },
    promoteChild(request) {
      invariant(typeof request?.runId === 'string' && request.runId.trim(), 'studio_native_child_control_invalid');
      return childCommand(request, { commandId: request.commandId, kind: 'promote_child', payload: { childRunId: request.childRunId } },
        ({ kernel, scope, runId, wake }) => {
          const receipt = kernel.promoteChild(scope, runId, request.childRunId, request.commandId);
          if (receipt.status === 'accepted') wake(); return receipt;
        });
    },
    sendChildInput(request) {
      return childCommand(request, { commandId: request.commandId, kind: 'message_child', payload: {
        childRunId: request.childRunId, text: request.text, expectedGoalRevision: request.expectedGoalRevision } }, control => {
        const receipt = control.kernel.sendChildInput(control.scope, control.runId, request.childRunId,
          request.text, request.expectedGoalRevision, request.commandId);
        if (receipt.status === 'accepted') control.wake(); return receipt;
      });
    },
    cancelChild(request) {
      return childCommand(request, { commandId: request.commandId, kind: 'cancel_child', payload: { childRunId: request.childRunId } }, control => {
        const receipt = control.kernel.cancelChild(control.scope, control.runId, request.childRunId, request.commandId);
        if (receipt.status === 'accepted') control.wake(); return receipt;
      });
    },
    executeTurn(input) {
      invariant(!closed, 'studio_native_host_closed');
      const promise = execute({ ...input, signal: AbortSignal.any([input.signal, lifetime.signal]) });
      active.add(promise); void promise.finally(() => active.delete(promise)).catch(() => {});
      return promise;
    },
    executeBackgroundTurn(input) {
      invariant(!closed, 'studio_native_host_closed');
      const promise = execute.background({ ...input, signal: AbortSignal.any([input.signal, lifetime.signal]) });
      active.add(promise); void promise.finally(() => active.delete(promise)).catch(() => {});
      return promise;
    },
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort(new Error('Studio Native host closed'));
      return closing = (async () => {
        await Promise.all([backgroundStart, waitRecoveryStart]);
        const background = await Promise.allSettled([backgroundOwner?.close(), waitRecoveryOwner?.close(), memoryExtraction.close()]);
        await Promise.allSettled([...active]);
        const children = await Promise.allSettled([...childOwners].flatMap(item => [...item.runIds]
          .map(runId => item.owner.releaseRun({ scope: item.scope, runId }))));
        childOwners.clear();
        childObservations.clear();
        commandProgress.close();
        try { backgroundRegistry?.close(); }
        finally { try { unregister(); } finally { if (!ledger) store.close(); } }
        const failures = [...background, ...children].filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Studio Native cleanup requires recovery');
      })();
    },
  };
}
