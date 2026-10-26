import { createNativeTraceProjection } from '../../providers/native-trace-projection.mjs';
import { bindStudioNativeCloudMemoryTurn, readStudioNativeCloudMemoryTurn } from '../../providers/native-cloud-memory-turn.mjs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonical, copy, invariant, normalizeDeliveryReviewPolicy, artifactToolDefinitions, toolDiscoveryDefinitions, todoToolDefinitions, planModeToolDefinitions } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { createNativeArtifactStore } from '../../../packages/agentkit-harness/src/native/artifact-store.mjs';
import { selectedNativeBuildContract } from '../../build-engine.mjs';
import { SqliteRunStore } from '../../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeModelPort, nativeModelRecoveryPolicy } from '../../../packages/agentkit-harness/src/native/model-port.mjs';
import { createNativeDshTurnExecutor, freezeNativeDshConfiguration, NATIVE_DSH_TURN_CONTRACT } from '../../../packages/agentkit-harness/src/native/dsh-turn-runtime.mjs';
import { nativeDeliveryProjection } from '../../../packages/agentkit-harness/src/native/session-delivery.mjs';
import { nativeLiveStream } from '../../../packages/agentkit-harness/src/native/assistant-stream.mjs';
import { createNativeChildHistory, mergeNativeChildHistory } from '../../../packages/agentkit-harness/src/native/child-history.mjs';
import { projectNativeDshInput, projectNativeDshContent } from '../../providers/native-input.mjs';
import { nativeConversationForkSeed } from '../../providers/native-conversation-fork.mjs';
import { bindNativeContext } from '../../providers/native-context.mjs';
import { bindStudioNativeMemoryRecall } from '../../providers/native-memory-recall.mjs';
import { bindNativeDeadlinePolicy, bindNativeTaskPolicy, STUDIO_NATIVE_TASK_POLICY_CONTRACT } from '../../providers/native-task-policy.mjs';
import { createNativeVerification, nativeGoalContract, STUDIO_NATIVE_VERIFICATION_CONTRACT } from '../../providers/native-verification.mjs';
import { dshModelRoute } from '../../agent-preset-admission.mjs';
import { prepareLocalResourceContext } from '../../local-runtime.mjs';
import { createNativeHostInteraction, STUDIO_NATIVE_INTERACTION_CONTRACT } from '../../providers/native-host-interaction.mjs';
import { createStudioNativeChildren, nativeChildRoles, STUDIO_NATIVE_CHILD_CONTRACT } from '../../providers/native-subagents.mjs';
import { createStudioNativeChildWorkspaces } from '../../providers/native-child-workspace-host.mjs';
import { nativeRecoveryBinding, readNativeRecoveryBinding, assertNativeRecoveryPreset } from '../../providers/native-recovery-binding.mjs';
import { createStudioNativeRecovery } from './native-recovery.mjs';
import { hash, profileDescription, profileIds, admittedModelSelection, recoveredPromptAssembly, nativePlanAssembly, createStudioNativeBackgroundBinding, createStudioNativeMemoryExtractionBinding } from './native-harness-bindings.mjs';
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
import { readNativeDshManagedOwnership } from '../../../packages/agentkit-harness/src/native/dsh-managed-ownership.mjs';
import { admitInlineReasoningPolicy } from '../../../packages/agentkit-harness/src/native/model-inline-reasoning.mjs';
import { admitAnthropicPolicies, admitProviderCompatibilityPolicy, resolveProviderCompatibility } from '../../../packages/agentkit-harness/src/native/model-provider-compat.mjs';
import { admitProviderToolSearchPolicy } from '../../../packages/agentkit-harness/src/native/model-tool-search-policy.mjs';
/** Host services and credentials stay outside the serializable Native core. */
export async function createStudioNativeHarness({ ctx, storeDir, workspaceRoot, agents, builds, models, resources,
  fetchImpl, renderPrompt, publishStreamFrame, ledger, agentEvents, assembleContextFor, hookRegistry, contextSourceRegistry, observability,
  modelCompatibilityRule } = {}) {
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
  const workspaceId = hash(resolve(workspaceRoot));
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
  const childCommand = (request, command, invoke) => {
    const current = controls.get(controlKey(request.agentId, request.sessionId));
    if (current?.runId === request.runId) return invoke(controlFor(request));
    // A lost reply may be confirmed after the original turn releases its live
    // ports. Only an exact already-persisted command is a read-only duplicate;
    // history cannot authorize a new child operation or install another driver.
    invariant(!closed && typeof request.runId === 'string' && request.runId.trim(), 'studio_native_child_control_run_unavailable');
    const managed = ctx.get('studioManagedNativeSessionControl');
    let record = managed?.agentId === request.agentId ? managed.inspect({ agentId: request.agentId,
      sessionId: request.sessionId, runId: request.runId, workspaceId })?.record : null;
    if (!record) {
      try { record = localStore.load({ tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId }, request.runId); }
      catch (error) { if (error.code !== 'run_not_found') throw error; }
    }
    invariant(record?.snapshot.sessionId === request.sessionId, 'studio_native_child_control_run_unavailable');
    const existing = record.commands.find(row => row.command.commandId === command.commandId);
    invariant(existing, 'studio_native_child_control_run_unavailable');
    invariant(canonical(existing.command) === canonical(command), 'command_replay_conflict');
    return { commandId: command.commandId, status: 'duplicate', reason: null };
  };
  const liveChildTasks = (request, scope, selectedStore) => runId => {
    const control = controls.get(controlKey(request.agentId, request.sessionId));
    if (!control || control.runId !== runId || canonical(control.scope) !== canonical(scope)
      || (control.store ?? localStore) !== selectedStore) return [];
    control.assertCurrent?.();
    return selectedStore.load(scope, runId).configuration.childLifecyclePolicy === 'owned-background/v2'
      ? control.kernel.childTasks(scope, runId) : [];
  };
  const childHistory = request => {
    invariant(!closed && typeof request?.agentId === 'string' && request.agentId.trim()
      && request.agentId.length <= 256, 'studio_native_child_history_invalid');
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId };
    return createNativeChildHistory({ scope, store, liveTasks: liveChildTasks(request, scope, store) });
  };
  const readChildren = (request, signal, result = false) => {
    signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
    const service = ctx.get('studioManagedNativeSessionControl');
    const managedView = service?.agentId === request.agentId ? service.inspect({ agentId: request.agentId,
      sessionId: request.sessionId, workspaceId, ...(request.runId === undefined ? {} : { runId: request.runId }) }) : null;
    if (!managedView)
      return childHistory(request)[result ? 'result' : 'list'](request);
    if (request.runId !== undefined) {
      // A historical read is not recovery of the current SDK turn. The bound
      // service checks this exact original admission/principal and ancestry,
      // even while a different ordinary/managed turn owns the Session.
      const control = controls.get(controlKey(request.agentId, request.sessionId));
      return service.childHistory({ ...request, workspaceId }, { result,
        liveTasks: control?.store ? liveChildTasks(request, managedView.scope, control.store) : undefined });
    }
    const original = copy(request), bytes = canonical(request);
    return recovery.inspect({ agentId: original.agentId, sessionId: original.sessionId,
      ...(original.runId === undefined ? {} : { runId: original.runId }) }, signal).then(inspected => {
      signal?.throwIfAborted(); lifetime.signal.throwIfAborted();
      invariant(canonical(request) === bytes, 'studio_native_child_history_invalid');
      const control = controls.get(controlKey(original.agentId, original.sessionId));
      const managed = inspected.managedControl ?? service;
      invariant(ctx.get('studioManagedNativeSessionControl') === managed, 'NATIVE_MANAGED_STATUS_IDENTITY_MISMATCH');
      const managedOptions = { liveTasks: control?.store ? liveChildTasks(original, managedView.scope, control.store) : undefined };
      // Each history authenticates its own tenant/principal, frozen roles and
      // ancestry. Merge only read models; commands still target the original
      // parent and its existing owner. Explicit runId reads remain owner-local.
      const local = childHistory(original), identity = { sessionId: original.sessionId };
      const localInventory = local.inventory(identity);
      const managedInventory = managed.childHistory({ agentId: original.agentId, sessionId: original.sessionId, workspaceId },
        { ...managedOptions, inventory: true });
      const inventories = inspected.managed ? [managedInventory, localInventory] : [localInventory, managedInventory];
      const page = mergeNativeChildHistory(result ? identity : original, inventories);
      if (!result) return page;
      const matches = inventories.filter(value => value.tasks.some(task => task.childRunId === original.childRunId));
      invariant(matches.length === 1, 'child_history_result_unavailable');
      const task = matches[0].tasks.find(task => task.childRunId === original.childRunId);
      const selected = { ...original, runId: task.parentRunId };
      const detail = matches[0] === localInventory ? local.result(selected)
        : managed.childHistory({ ...selected, workspaceId }, { ...managedOptions, result: true });
      return { ...detail, runId: page.runId };
    });
  };
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
      const description = profileDescription(selected);
      const visionId = nativeVisionProfileId(record);
      const visionProfile = visionId ? structuredClone(await models.profile(visionId)) : null;
      signal.throwIfAborted();
      const visionDescription = visionProfile ? profileDescription(visionProfile) : null;
      invariant(!visionDescription || visionDescription.input.includes('image'), 'studio_native_vision_model_image_input_required');
      // Older TS runs could contain an unconsumed product field. Restore their
      // actual admission, rather than activating a newly supported policy.
      const deadlineExecution = original && !Object.hasOwn(original.configuration, 'wallDeliveryPolicy') ? undefined : record.spec.execution;
      const deadline = bindNativeDeadlinePolicy(deadlineExecution);
      const readWorkingSetDefaults = !original || Object.hasOwn(original.configuration.contextPolicy ?? {}, 'readWorkingSetCount');
      const recentToolBatchDefaults = !original || Object.hasOwn(original.configuration.contextPolicy ?? {}, 'recentToolBatchCount');
      const pruningThresholdDefaults = !original || original.configuration.contextPolicy?.pruneThresholdPolicy === 'zcode-local/v1';
      const pruningSummaryDefaults = !original || original.configuration.contextPolicy?.pruneSummaryPolicy === 'zcode-local/v1';
      const pruningIdleDefaults = !original || original.configuration.contextPolicy?.pruneIdleThresholdMinutes !== undefined;
      const context = bindNativeContext({ description, context: record.spec.context, maxTokens: selection.maxTokens,
        readWorkingSetDefaults, recentToolBatchDefaults, pruningThresholdDefaults, pruningSummaryDefaults, pruningIdleDefaults });
      const source = { provider: selection.provider || dshModelRoute(selected), model: selected.modelName };
      const inputSelection = original ? admittedModelSelection(agent, input.assembly) : { ...selection, ...source };
      const inputServices = { attachments: () => ctx.get('attachments'),
        fileRequestText: typeof llm?.fileRequestText === 'function' ? ref => llm.fileRequestText(ref) : undefined };
      // Replay the already-admitted bytes and resource context. Mutable files,
      // attachments and memory are not a substitute for the original input.
      const admission = original ? { objective: original.configuration.contract.objective,
        messages: structuredClone(original.configuration.inputMessages) }
        : await projectNativeDshInput(input.messages, { ...inputServices, signal });
      // Preserve original content-part indices: a text or omitted image must
      // never shift a model's reference onto a different admitted image.
      let childMediaSources = new Map();
      input.messages.forEach((message, index) => {
        if (admission.messages[index].kind !== 'user_input') return;
        childMediaSources = new Map(); let image = 0;
        message.content.forEach((part, partIndex) => {
          if (part.type === 'image' && part.offloaded !== true) childMediaSources.set(partIndex, admission.messages[index].media?.[image++]);
        });
      });
      const scope = execution?.scope ?? { tenantId: 'local', workspaceId, userId: 'local-user', agentId: binding.agentId };
      const sessionId = String(agent.session.id);
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
        commandBinding: binding.nativeTools.commandBinding ?? null,
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
      const systemPrompt = original ? original.capsule.systemPrompt : renderPrompt(nativePlanAssembly(input.assembly, planModePolicy));
      // New Native runs use the original Studio recovery policies. A cold
      // restore retains the exact older optional configuration and digest.
      const recoveryPolicies = original ? Object.fromEntries(['outputRecoveryPolicy', 'toolErrorRecoveryPolicy', 'toolErrorRecoveryModelCalls', 'deliveryReviewPolicy', 'wallDeliveryPolicy', 'artifactPolicy', 'sourceReadPolicy', 'toolDiscoveryPolicy', 'todoPolicy', 'planModePolicy', 'planModeInitialActive', 'childTaskPolicy', 'childPlanPolicy']
        .filter(key => Object.hasOwn(original.configuration, key)).map(key => [key, original.configuration[key]]))
        : { outputRecoveryPolicy: 'task-or-delivery/v1', toolErrorRecoveryPolicy: 'diagnose-before-repeat/v1', artifactPolicy: 'runtime-artifacts/v1', sourceReadPolicy: 'studio-source-read/v1',
          ...(nativeChildRoles(record.spec).length ? { childTaskPolicy: 'session-controls/v1' } : {}),
          ...(planModePolicy && nativeChildRoles(record.spec).length ? { childPlanPolicy: 'inherit-plan/v1' } : {}),
          ...(planModePolicy ? { planModePolicy, planModeInitialActive: currentPlanActive() } : {}),
          ...(Object.hasOwn(deadline, 'wallDeliveryPolicy') ? { wallDeliveryPolicy: deadline.wallDeliveryPolicy } : {}),
          ...(record.spec.execution?.toolErrorRecoveryModelCalls === undefined ? {}
            : { toolErrorRecoveryModelCalls: record.spec.execution.toolErrorRecoveryModelCalls }),
          ...(record.spec.execution?.deliveryReviewPolicy === undefined ? {} : { deliveryReviewPolicy: record.spec.execution.deliveryReviewPolicy === null
            ? null : normalizeDeliveryReviewPolicy(record.spec.execution.deliveryReviewPolicy) }) };
      if (original) invariant(renderPrompt(nativePlanAssembly(recoveredPromptAssembly(input.assembly, source), planModePolicy)) === systemPrompt,
        'studio_native_recovery_prompt_changed');
      // Seal the Host recovery capsule once per Build. The Memory owner guard
      // compares the CURRENT configuration's capsule to THIS sealed identity
      // (revision, buildId, system prompt, source, messages), so a legitimately
      // advanced/replaced Run or a new owner cannot authorize a stale write.
      const sealedCapsule = nativeRecoveryBinding({ binding, input, source, selection, systemPrompt });
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
      const toolOptions = { ...(toolDiscoveryPolicy ? { toolDiscoveryPolicy } : {}),
        ...(original ? { workspaceCheckpointDefinitions: original.configuration.tools } : {}),
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
      if (!original && toolDiscoveryPolicy && (boundToolDefinitions.some(tool => tool.discovery) || recoveryPolicies.todoPolicy || planModePolicy))
        recoveryPolicies.toolDiscoveryPolicy = toolDiscoveryPolicy;
      const tools = [...boundToolDefinitions, ...(recoveryPolicies.toolDiscoveryPolicy ? toolDiscoveryDefinitions() : []),
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
      const skillInstructions = await binding.nativeTools.skillInstructions?.(signal);
      const instructions = original ? original.configuration.instructions : [systemPrompt, materialized.resourceContext,
        skillInstructions].filter(Boolean).join('\n\n');
      const verification = await createNativeVerification({ scope, sessionId, workspaceRoot,
        evidenceDirectory: join(storeDir, 'native-harness', 'verification-evidence'),
        verifyBrowserPage: taskPolicy.workspaceObservationPolicy && typeof binding.nativeTools.verifyBrowserPage === 'function'
          ? request => binding.nativeTools.verifyBrowserPage(agent, request) : undefined });
      // Combine the baseline delivery verifier with the Memory owner verifier.
      // The wrapper is always present for a local-default Build (fail-closed for
      // explicit Memory tasks) and delegates to the baseline otherwise.
      const memoryVerification = memoryHost ? memoryHost.wrapVerification(verification) : null;
      const modelBinding = (profile, id, boundContext, primary = false) => {
        const desc = profileDescription(profile), digest = hash(desc);
        const inlineReasoningPolicy = original ? original.configuration.profile.inlineReasoningPolicy
          : admitInlineReasoningPolicy(modelCompatibilityRule);
        const providerCompatibilityPolicy = original ? original.configuration.profile.providerCompatibilityPolicy
          : admitProviderCompatibilityPolicy(modelCompatibilityRule);
        const modelOptions = providerCompatibilityPolicy ? Object.fromEntries([
          ['streaming', desc.parameters.stream], ['reasoningEffort', desc.protocol === 'openai-chat' ? desc.parameters.reasoning_effort : undefined],
          ['thinkingMode', desc.protocol === 'openai-chat' ? desc.parameters.thinking?.type : undefined], ['parallelToolCalls', desc.parameters.parallel_tool_calls],
          ['temperature', desc.parameters.temperature], ['topP', desc.parameters.top_p],
        ].filter(([, value]) => value !== undefined)) : {};
        // Presence versions the new display/idle defaults. Restore old Runs
        // without activating them, and let each child use its own parameters.
        const runtimePolicy = !original || Object.hasOwn(original.configuration.profile, 'providerThinkingDisplay');
        const providerThinkingDisplayPolicy = original ? original.configuration.profile.providerThinkingDisplayPolicy : 'provider-visible/v1';
        const controllerReasoningPolicy = original ? original.configuration.profile.controllerReasoningPolicy : 'disclosed-delegate/v1';
        const toolSearchEpoch = !original || Object.hasOwn(original.configuration.profile, 'providerToolSearchPolicy');
        const providerToolSearchPolicy = toolSearchEpoch ? original && primary
          ? original.configuration.profile.providerToolSearchPolicy
          : admitProviderToolSearchPolicy({ protocol: desc.protocol, model: desc.modelName,
            requested: desc.parameters.provider_tool_search, discovery: !!recoveryPolicies.toolDiscoveryPolicy }) : undefined;
        const anthropicKeys = ['anthropicPolicy', 'promptCachePolicy', 'operatorGuidancePolicy', 'toolCatalogPolicy', 'providerReplayProjectionPolicy'];
        const anthropicPolicies = original && primary
          ? Object.fromEntries(anthropicKeys.filter(key => original.configuration.profile[key] !== undefined)
            .map(key => [key, original.configuration.profile[key]]))
          : !original || original.configuration.profile.anthropicPolicy ? admitAnthropicPolicies(desc.protocol, desc.modelName) : {};
        const modelRuntimeOptions = runtimePolicy ? {
          providerThinkingDisplay: desc.parameters.provider_thinking_display ?? (providerThinkingDisplayPolicy === 'provider-visible/v1'),
          ...(providerThinkingDisplayPolicy ? { providerThinkingDisplayPolicy } : {}),
          ...(modelOptions.streaming !== false ? { streamTimeoutPolicy: 'idle/v1' } : {}),
          ...(controllerReasoningPolicy ? { controllerReasoningPolicy } : {}),
          ...(providerToolSearchPolicy ? { providerToolSearchPolicy } : {}),
          ...anthropicPolicies,
        } : {};
        const compat = providerCompatibilityPolicy && resolveProviderCompatibility(providerCompatibilityPolicy,
          { model: desc.modelName, baseUrl: desc.baseUrl });
        invariant(!compat || modelOptions.reasoningEffort === undefined || compat.supportsEffort,
          'native_model_profile_reasoning_effort_unsupported');
        invariant(!compat || modelOptions.thinkingMode === undefined || compat.supportsThinking,
          'native_model_profile_thinking_mode_unsupported');
        const planned = boundContext ?? bindNativeContext({ description: desc, context: record.spec.context,
          readWorkingSetDefaults, recentToolBatchDefaults, pruningThresholdDefaults, pruningSummaryDefaults, pruningIdleDefaults });
        return { supportsImages: desc.input.includes('image'), modelRecoveryPolicy: nativeModelRecoveryPolicy(desc),
        profile: { profileId: profile.id || id || 'default', profileVersion: digest, providerFamily: desc.protocol,
          compatibilityDigest: providerCompatibilityPolicy ? hash({ description: desc, inlineReasoningPolicy, providerCompatibilityPolicy,
            ...(runtimePolicy ? { modelRuntimeOptions } : {}) })
            : inlineReasoningPolicy ? hash({ description: desc, inlineReasoningPolicy }) : digest,
          ...(inlineReasoningPolicy ? { inlineReasoningPolicy } : {}),
          ...(providerCompatibilityPolicy ? { providerCompatibilityPolicy, ...modelOptions } : {}),
          ...modelRuntimeOptions,
          ...planned.profile, requestTimeoutMs: desc.requestTimeoutMs,
          providerReplayMode: desc.protocol === 'anthropic-messages' ? 'anthropic_content' : 'reasoning_content' },
        context: planned.port, contextPolicy: planned.policy, model: createNativeModelPort({ fetchImpl,
          resolveProfile: async () => {
            const current = { ...await models.profile(id), modelName: profile.modelName };
            invariant(hash(profileDescription(current)) === digest, 'studio_native_model_binding_changed');
            return { protocol: desc.protocol, baseUrl: current.baseUrl, apiKey: current.apiKey,
              model: profile.modelName, parameters: desc.parameters };
          } }) };
      };
      const parentModel = modelBinding(selected, selectedId, context, true), roles = nativeChildRoles(record.spec);
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
      invariant(!roles.length || canonical(binding.nativeTools.childBinding?.roles) === canonical(roles), 'studio_native_child_revision_binding_changed');
      const childQuestionPreset = roles.length && binding.nativeTools.a2aBinding
        ? ctx.get('sessionProjections')?.stateOf?.(agent.session, 'agentPreset') : undefined;
      const children = await createStudioNativeChildren({ roles, scope, sessionId, store, tools, mediaSources: childMediaSources,
        ...(recoveryPolicies.childTaskPolicy ? { childTaskPolicy: recoveryPolicies.childTaskPolicy } : {}),
        ...(recoveryPolicies.childPlanPolicy ? { childPlanPolicy: recoveryPolicies.childPlanPolicy } : {}),
        isClosed: () => lifetime.signal.aborted,
        fileWorkspaces: roles.length ? createStudioNativeChildWorkspaces({ workspaceRoot,
          stateDir: join(storeDir, 'native-harness') }) : null,
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
        bindTools: authority => binding.nativeTools.forChild(agent, authority),
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
      const contextSources = [...(memoryRecall ? [memoryRecall.source] : []), ...(registeredContext?.sources ?? [])];
      invariant(new Set(contextSources.map(source => source.sourceId)).size === contextSources.length,
        'studio_native_context_source_collision');
      const readContextSource = request => {
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
        modelName: selected.modelName, workspaceRoot, tools, commandBinding: binding.nativeTools.commandBinding, codeBinding: binding.nativeTools.codeBinding,
        remoteSkillBinding: binding.nativeTools.remoteSkillBinding,
        localMemoryBound: Boolean(memoryHost?.policy.enabled) }) : null;
      const toolPorts = binding.nativeTools.forAgent(agent, { scope, store,
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
              const snapshot = store.load(scope, request.runId).snapshot;
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
              try { phase = store.load(scope, request.runId).snapshot.phase; }
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
        configuration: { profile: parentModel.profile, modelRecoveryPolicy: parentModel.modelRecoveryPolicy, ...recoveryPolicies,
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
          ...(binding.nativeTools.commandBinding ? { commandBinding: binding.nativeTools.commandBinding } : {}),
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
        ...(binding.nativeTools.commandBinding ? { backgroundNotificationPolicy: 'completed-before-model/v1' } : {}),
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
          const instructionPaths = binding.nativeTools.instructionTouches?.(agent, store.load(scope, request.runId)) ?? [];
          if (instructionPaths.length) {
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
          invariant(renderPrompt(nativePlanAssembly(original ? recoveredPromptAssembly(next.assembly, source) : next.assembly, planModePolicy)) === systemPrompt,
            'studio_native_input_prompt_binding_changed');
          invariant(canonical(binding.nativeTools.definitions(agent, next.assembly.tools, toolOptions)) === canonical(boundToolDefinitions),
            'studio_native_input_tool_binding_changed');
          invariant(Array.isArray(next.messages), 'studio_native_prepared_input_invalid');
          // The post-candidate drain must still catch real queued work. SDK
          // step preparation also samples clock/runtime snapshots even when
          // no work arrived; treating those refreshers as new work would
          // discard every final answer and loop until the model budget ends.
          const candidate = store.load(scope, request.runId).snapshot.candidate;
          const modeInput = planModePolicy ? { planMode: currentPlanActive() } : {};
          if (candidate && next.messages.every(message => ['runtime-context', 'time-context'].includes(message?.source?.kind)))
            return { status: 'admitted', messages: [], ...modeInput };
          const messages = [], images = new Map();
          for (const message of next.messages) {
            invariant(message?.role === 'user' && Array.isArray(message.content), 'studio_native_prepared_input_invalid');
            const context = await projectNativeDshContent(message.content, { ...inputServices, signal: request.signal }, images);
            if (message.source !== undefined) context.presentation.source = structuredClone(message.source);
            messages.push({ ...context, retention: !message.source || ['user', 'schedule'].includes(message.source.kind) ? 'persistent' : 'normal' });
          }
          request.signal.throwIfAborted();
          return { status: 'admitted', messages, ...modeInput };
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
    resolveTurn: payload => resolveBinding(payload),
    resolveRecoveryTurn: resolveRestoredBinding,
    resolveBackgroundTurn: resolveBackgroundBinding,
  });
  const memoryExtraction = createStudioNativeMemoryExtractionBinding({ store, storeDir, workspaceId, lifetime, builds, agents, models, fetchImpl });
  memoryExtraction.recover();
  const recovery = createStudioNativeRecovery({ ctx, store, workspaceId, lifetime, active, controls, controlKey, execute, agentEvents,
    cloudMemoryStatus: record => readStudioNativeCloudMemoryTurn({ record, storeDir }),
    memoryExtractionStatus: record => record.snapshot.scope.tenantId === 'local'
      && record.snapshot.scope.workspaceId === workspaceId && record.snapshot.scope.userId === 'local-user'
      ? memoryExtraction.status({ scope: record.snapshot.scope, sessionId: record.snapshot.sessionId }) : undefined });
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
          for (const scope of scopes) for (const snapshot of store.list(scope)) {
            scanSignal.throwIfAborted();
            if (!['awaiting_reconciliation', 'preparing_context', 'executing_tools', 'verifying', 'completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)) continue;
            if (settledHeads.has(checkpointKey(snapshot))) continue;
            const record = store.load(scope, snapshot.runId);
            if (record.configuration.childOwnerBinding || record.lease && record.lease.expiresAt > Date.now()) continue;
            const waiting = nativeA2aReceiptWaitSource(record) || nativeChildA2aWaitSource({ store, record });
            const cleanup = !waiting && ['completed', 'failed', 'canceled', 'interrupted'].includes(snapshot.phase)
              && ((record.projections[NATIVE_A2A_QUESTION_CLEANUP] ?? 0) < snapshot.eventSeq
                || snapshot.phase !== 'interrupted' && store.sessionHead(scope, snapshot.sessionId)?.runId === snapshot.runId)
              && record.intents.some(intent => intent.kind === 'tool' && intent.payload.calls?.some(call => call.name === 'call_a2a_agent'));
            if (waiting || cleanup) candidates.push({ scope, sessionId: snapshot.sessionId, runId: snapshot.runId });
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
            beginStep, revisions: streamRevisions,
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
    reconcileTool: recovery.reconcile,
    repairWorkspace: recovery.repairWorkspace,
    conversationStatus: conversation.status,
    rewindConversation: conversation.rewind,
    previewConversationWorkspace: conversation.previewWorkspace,
    controlA2aTask,
    managedScopeControl,
    childHistory(request, signal) { return readChildren(request, signal); },
    childResult(request, signal) { return readChildren(request, signal, true); },
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
        try { backgroundRegistry?.close(); }
        finally { try { unregister(); } finally { if (!ledger) store.close(); } }
        const failures = [...background, ...children].filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Studio Native cleanup requires recovery');
      })();
    },
  };
}
