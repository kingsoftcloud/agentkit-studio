import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { canonical, invariant } from '../../../packages/agentkit-harness-core/dist/index.mjs';
import { selectedNativeBuildContract } from '../../build-engine.mjs';
import { SqliteRunStore } from '../../../packages/agentkit-harness/src/native/sqlite-store.mjs';
import { createNativeModelPort } from '../../../packages/agentkit-harness/src/native/model-port.mjs';
import { createNativeDshTurnExecutor, NATIVE_DSH_TURN_CONTRACT } from '../../../packages/agentkit-harness/src/native/dsh-turn-runtime.mjs';
import { nativeDeliveryProjection } from '../../../packages/agentkit-harness/src/native/session-delivery.mjs';
import { createNativeChildHistory } from '../../../packages/agentkit-harness/src/native/child-history.mjs';
import { projectNativeDshInput, projectNativeDshContent } from '../../providers/native-input.mjs';
import { bindNativeContext } from '../../providers/native-context.mjs';
import { bindNativeTaskPolicy, STUDIO_NATIVE_TASK_POLICY_CONTRACT } from '../../providers/native-task-policy.mjs';
import { createNativeVerification, nativeGoalContract, STUDIO_NATIVE_VERIFICATION_CONTRACT } from '../../providers/native-verification.mjs';
import { dshModelRoute } from '../../agent-preset-admission.mjs';
import { prepareLocalResourceContext } from '../../local-runtime.mjs';
import { createNativeHostInteraction, STUDIO_NATIVE_INTERACTION_CONTRACT } from '../../providers/native-host-interaction.mjs';
import { createStudioNativeChildren, nativeChildRoles, STUDIO_NATIVE_CHILD_CONTRACT } from '../../providers/native-subagents.mjs';
import { modelInput } from '../../model-service.mjs';
import { nativeRecoveryBinding } from '../../providers/native-recovery-binding.mjs';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const profileDescription = profile => ({ id: profile.id, provider: profile.provider, modelName: profile.modelName,
  baseUrl: profile.baseUrl, protocol: profile.protocol || (profile.provider === 'anthropic' ? 'anthropic-messages' : 'openai-chat'),
  contextWindow: profile.contextWindow ?? 128000, maxOutputTokens: profile.maxOutputTokens ?? 8192,
  parameters: profile.parameters ?? {}, requestTimeoutMs: profile.requestTimeoutMs ?? 110000, input: modelInput(profile) });
const profileIds = record => {
  const bindings = record.spec?.bindings ?? {};
  return [...new Set([bindings.modelProfileId, ...(bindings.modelProfileIds ?? []).map(value => typeof value === 'string' ? value : value?.resourceId)].filter(Boolean))];
};
// SessionController selections are applied by the public prompt assembly;
// Agent.options retains the creation default and can be stale at this boundary.
const admittedModelSelection = (agent, assembly) => {
  const selection = { ...agent.options };
  for (const key of ['provider', 'model']) {
    const value = assembly?.variables?.[key];
    invariant(value === undefined || typeof value === 'string' && value.trim(), 'studio_native_model_selection_invalid');
    if (value !== undefined) selection[key] = value;
  }
  return selection;
};

/** Host services and credentials stay outside the serializable Native core. */
export async function createStudioNativeHarness({ ctx, storeDir, workspaceRoot, agents, builds, models, resources,
  fetchImpl, renderPrompt, publishStreamFrame, ledger } = {}) {
  const sessions = ctx.get('sessions'), projections = ctx.get('sessionProjections'), llm = ctx.get('llm');
  invariant(typeof sessions?.flush === 'function' && typeof projections?.register === 'function'
    && typeof renderPrompt === 'function', 'studio_native_host_services_unavailable');
  const store = ledger ?? new SqliteRunStore(join(storeDir, 'native-harness', 'runs.sqlite'));
  let unregister;
  try { unregister = projections.register(nativeDeliveryProjection()); }
  catch (error) { if (!ledger) store.close(); throw error; }
  const lifetime = new AbortController(), active = new Set(), childOwners = new Set(), controls = new Map();
  let closed = false, closing;
  const workspaceId = hash(resolve(workspaceRoot));
  const controlKey = (agentId, sessionId) => canonical({ agentId, sessionId });
  const controlFor = request => {
    invariant(!closed && typeof request?.agentId === 'string' && request.agentId.trim()
      && typeof request.sessionId === 'string' && request.sessionId.trim(), 'studio_native_child_control_invalid');
    const control = controls.get(controlKey(request.agentId, request.sessionId));
    invariant(control && (request.runId === undefined || request.runId === control.runId), 'studio_native_child_control_run_unavailable');
    return control;
  };
  const childHistory = request => {
    invariant(!closed && typeof request?.agentId === 'string' && request.agentId.trim()
      && request.agentId.length <= 256, 'studio_native_child_history_invalid');
    const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: request.agentId };
    return createNativeChildHistory({ scope, store, liveTasks: runId => {
      const control = controls.get(controlKey(request.agentId, request.sessionId));
      return control?.runId === runId && store.load(scope, runId).configuration.childLifecyclePolicy === 'owned-background/v2'
        ? control.kernel.childTasks(scope, runId) : [];
    } });
  };
  const execute = createNativeDshTurnExecutor({ store, projections, durableOwnership: true, flush: session => sessions.flush(session),
    publishStreamFrame, onIdle: createNativeHostInteraction({ ctx, store }),
    onActive: (_payload, control) => {
      const key = controlKey(control.scope.agentId, control.sessionId);
      invariant(!controls.has(key), 'studio_native_child_control_already_active');
      controls.set(key, control);
      return () => { if (controls.get(key) === control) controls.delete(key); };
    },
    resolveTurn: async ({ agent, input, binding, signal, prepareInput }) => {
      if (binding?.runtime !== 'harness' || binding.local !== true) return null;
      invariant(binding.nativeEngineContract === NATIVE_DSH_TURN_CONTRACT, 'studio_native_engine_contract_unsupported');
      invariant(typeof prepareInput === 'function', 'studio_native_whole_turn_host_required');
      invariant(binding.agentId && Number.isSafeInteger(binding.agentRevision) && binding.agentRevision > 0
        && binding.nativeTools, 'studio_native_revision_binding_missing');
      invariant(!binding.buildId || typeof builds?.resolve === 'function', 'studio_native_build_service_unavailable');
      const record = binding.buildId ? await builds.resolve(binding.agentId, binding.buildId)
        : await agents.getRevision(binding.agentId, binding.agentRevision);
      signal.throwIfAborted();
      invariant(record?.metadata?.id === binding.agentId && record.metadata.local === true
        && record.metadata.revision === binding.agentRevision && record.spec?.runtime?.type === 'harness', 'studio_native_revision_binding_changed');
      if (binding.buildId) invariant(selectedNativeBuildContract({ ...record, buildId: binding.buildId }) === NATIVE_DSH_TURN_CONTRACT,
        'studio_native_build_engine_mismatch');
      const ids = profileIds(record), profiles = await Promise.all((ids.length ? ids : ['']).map(id => models.profile(id)));
      signal.throwIfAborted();
      const selection = admittedModelSelection(agent, input.assembly);
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
      const context = bindNativeContext({ description, context: record.spec.context, maxTokens: selection.maxTokens });
      const source = { provider: selection.provider || dshModelRoute(selected), model: selected.modelName };
      const inputServices = { attachments: () => ctx.get('attachments'),
        fileRequestText: typeof llm?.fileRequestText === 'function' ? ref => llm.fileRequestText(ref) : undefined };
      const admission = await projectNativeDshInput(input.messages, { ...inputServices, signal });
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
      const tools = binding.nativeTools.definitions(agent, input.assembly.tools);
      const taskPolicy = bindNativeTaskPolicy({ tools, nativeLimits: record.spec.execution?.nativeLimits });
      const materialized = await prepareLocalResourceContext({ record, input: admission.objective, resourceAdapter: resources,
        toolAdapter: {}, agent, agentId: binding.agentId, userId: 'local-user', resourceMode: 'context-only' });
      // A memory write is an external effect and must get its own Native intent.
      // Refuse that composition until its durable port is installed.
      invariant(!materialized.memoryWrite, 'studio_native_memory_write_port_unavailable');
      const systemPrompt = renderPrompt(input.assembly);
      const instructions = [systemPrompt, materialized.resourceContext].filter(Boolean).join('\n\n');
      const buildId = binding.buildId || `revision-${hash({ agentId: binding.agentId, revision: binding.agentRevision, spec: record.spec })}`;
      const scope = { tenantId: 'local', workspaceId, userId: 'local-user', agentId: binding.agentId };
      const verification = await createNativeVerification({ scope, sessionId: String(agent.session.id), workspaceRoot,
        evidenceDirectory: join(storeDir, 'native-harness', 'verification-evidence'),
        verifyBrowserPage: taskPolicy.workspaceObservationPolicy && typeof binding.nativeTools.verifyBrowserPage === 'function'
          ? request => binding.nativeTools.verifyBrowserPage(agent, request) : undefined });
      const modelBinding = (profile, id, boundContext) => {
        const desc = profileDescription(profile), digest = hash(desc);
        const planned = boundContext ?? bindNativeContext({ description: desc, context: record.spec.context });
        return { supportsImages: desc.input.includes('image'), profile: { profileId: profile.id || id || 'default', profileVersion: digest, providerFamily: desc.protocol,
          compatibilityDigest: digest, ...planned.profile, requestTimeoutMs: desc.requestTimeoutMs,
          providerReplayMode: desc.protocol === 'anthropic-messages' ? 'anthropic_content' : 'reasoning_content' },
        context: planned.port, contextPolicy: planned.policy, model: createNativeModelPort({ fetchImpl,
          resolveProfile: async () => {
            const current = { ...await models.profile(id), modelName: profile.modelName };
            invariant(hash(profileDescription(current)) === digest, 'studio_native_model_binding_changed');
            return { protocol: desc.protocol, baseUrl: current.baseUrl, apiKey: current.apiKey,
              model: profile.modelName, parameters: desc.parameters };
          } }) };
      };
      const parentModel = modelBinding(selected, selectedId, context), roles = nativeChildRoles(record.spec);
      invariant(!roles.length || canonical(binding.nativeTools.childBinding?.roles) === canonical(roles), 'studio_native_child_revision_binding_changed');
      const children = await createStudioNativeChildren({ roles, scope, store, tools, mediaSources: childMediaSources,
        hasSkills: Boolean(record.spec.bindings?.skills?.length || binding.nativeTools.childCapabilities?.skills),
        hasMcp: Boolean(record.spec.bindings?.mcpServers?.length || binding.nativeTools.childCapabilities?.mcp),
        resolveModel: async id => {
          if (id === null) return parentModel;
          const index = ids.indexOf(id);
          invariant(index >= 0, 'studio_native_child_model_unbound');
          return modelBinding(profiles[index], id);
        },
        bindTools: authority => binding.nativeTools.forChild(agent, authority),
        verificationFactory: child => createNativeVerification({ ...child, workspaceRoot,
          evidenceDirectory: join(storeDir, 'native-harness', 'verification-evidence') }),
      });
      const ownedChildren = children && { scope, owner: children.owner, runIds: new Set() };
      if (ownedChildren) childOwners.add(ownedChildren);
      signal.throwIfAborted();
      return { scope, buildId, source,
        releaseResources: async request => {
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
        },
        taskContractFactory: facts => nativeGoalContract({ sessionId: facts.sessionId, parentRunId: facts.parentRunId, goal: facts.goal }),
        configuration: { profile: parentModel.profile,
        hostRecoveryBinding: nativeRecoveryBinding({ binding, input, source, selection, systemPrompt }),
        hostBindingDigest: hash({ agentId: binding.agentId, revision: binding.agentRevision, buildId, source, tools, workspaceId,
          inputContract: 'agentkit.native-host-input/v1', contextPolicy: context.policy,
          interactionContract: STUDIO_NATIVE_INTERACTION_CONTRACT,
          ...(children ? { childContract: STUDIO_NATIVE_CHILD_CONTRACT, childRoles: roles } : {}),
          toolArgumentEncoding: binding.nativeTools.argumentEncoding ?? null,
          toolPermissionContract: binding.nativeTools.permissionContract ?? null,
          ...(binding.nativeTools.workspaceSyntax ? { workspaceSyntax: binding.nativeTools.workspaceSyntax } : {}),
          ...(binding.nativeTools.commandBinding ? { commandBinding: binding.nativeTools.commandBinding } : {}),
          mcpResultContract: binding.nativeTools.mcpResultContract ?? null,
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
        contract: nativeGoalContract({ sessionId: String(agent.session.id), goal: admission.objective }), instructions, inputMessages: admission.messages,
        tools, limits: { ...taskPolicy.limits, effectTimeoutMs: Math.max(120000, description.requestTimeoutMs + 10000,
          ...roles.map(role => role.timeoutSeconds * 1000 + 15000), ...tools.map(tool => tool.timeoutMs + 10000)) } },
        ports: { ...binding.nativeTools.forAgent(agent, { scope, store, ...(children ? { children } : {}) }),
          ...(children ? { children: children.owner } : {}), verification, context: context.port, input: { prepare: async request => {
          request.signal.throwIfAborted();
          const next = await prepareInput(request.step);
          request.signal.throwIfAborted();
          invariant(next && ['enter', 'reject'].includes(next.kind), 'studio_native_prepared_input_invalid');
          if (next.kind === 'reject') return { status: 'rejected', messages: [] };
          // A changing model/tool series needs an explicit Native rebind, not
          // an unlogged change to the frozen execution contract.
          invariant(next.startsRequestSeries !== true, 'studio_native_request_series_rebind_required');
          const nextSelection = admittedModelSelection(agent, next.assembly);
          invariant(nextSelection.provider === selection.provider && nextSelection.model === selection.model,
            'studio_native_input_binding_changed');
          invariant(renderPrompt(next.assembly) === systemPrompt
            && canonical(binding.nativeTools.definitions(agent, next.assembly.tools)) === canonical(tools),
          'studio_native_input_binding_changed');
          invariant(Array.isArray(next.messages), 'studio_native_prepared_input_invalid');
          const messages = [], images = new Map();
          for (const message of next.messages) {
            invariant(message?.role === 'user' && Array.isArray(message.content), 'studio_native_prepared_input_invalid');
            const context = await projectNativeDshContent(message.content, { ...inputServices, signal: request.signal }, images);
            if (message.source !== undefined) context.presentation.source = structuredClone(message.source);
            messages.push({ ...context, retention: !message.source || ['user', 'schedule'].includes(message.source.kind) ? 'persistent' : 'normal' });
          }
          request.signal.throwIfAborted();
          return { status: 'admitted', messages };
        } }, model: parentModel.model },
      };
    },
  });
  return {
    childHistory(request) { return childHistory(request).list(request); },
    childResult(request) { return childHistory(request).result(request); },
    childTasks(request) {
      const { kernel, scope, runId } = controlFor(request);
      return { contract: 'agentkit.studio-native-child-control/v1', runId, tasks: kernel.childTasks(scope, runId) };
    },
    promoteChild(request) {
      invariant(typeof request?.runId === 'string' && request.runId.trim(), 'studio_native_child_control_invalid');
      const { kernel, scope, runId } = controlFor(request);
      return kernel.promoteChild(scope, runId, request.childRunId, request.commandId);
    },
    sendChildInput(request) {
      const control = controlFor(request);
      invariant(request.runId === control.runId, 'studio_native_child_control_run_unavailable');
      const receipt = control.kernel.sendChildInput(control.scope, control.runId, request.childRunId,
        request.text, request.expectedGoalRevision, request.commandId);
      if (receipt.status === 'accepted') control.wake();
      return receipt;
    },
    cancelChild(request) {
      const control = controlFor(request);
      invariant(request.runId === control.runId, 'studio_native_child_control_run_unavailable');
      const receipt = control.kernel.cancelChild(control.scope, control.runId, request.childRunId, request.commandId);
      if (receipt.status === 'accepted') control.wake();
      return receipt;
    },
    executeTurn(input) {
      invariant(!closed, 'studio_native_host_closed');
      const promise = execute({ ...input, signal: AbortSignal.any([input.signal, lifetime.signal]) });
      active.add(promise); void promise.finally(() => active.delete(promise)).catch(() => {});
      return promise;
    },
    close() {
      if (closing) return closing;
      closed = true; lifetime.abort(new Error('Studio Native host closed'));
      return closing = (async () => {
        await Promise.allSettled([...active]);
        const children = await Promise.allSettled([...childOwners].flatMap(item => [...item.runIds]
          .map(runId => item.owner.releaseRun({ scope: item.scope, runId }))));
        childOwners.clear();
        try { unregister(); } finally { if (!ledger) store.close(); }
        const failures = children.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Studio child cleanup requires recovery');
      })();
    },
  };
}
