import { NativePolicyRegistry } from './policy-registry.mjs';
import type { NativePolicyModule } from './policy-registry.mjs';
import { emptyUsage, terminal } from './contracts.mjs';
import type { CommitBatch, EffectIntent, EffectReceipt, Lease, Message, ModelRequest, ModelResult, ModelStreamEvent, ModelStreamRecord, NativePorts, ObjectValue, PortContext,
  RunCommand, RunConfiguration, RunIdentity, RunScope, RunSnapshot, RunStore, ToolCall, ToolResult, VerificationReport, WorkspaceObservation,
  HookInvocation, HookInvocationResult, ContextPlanningResult } from './contracts.mjs';
import { initialSnapshot } from './configuration.mjs';
import { discoveryAfterCleanup, executeToolDiscovery, TOOL_SEARCH, DEFERRED_TOOL_CALL } from './tool-discovery.mjs';
import { executeArtifactTool, governArtifactResult, isArtifactTool, RUNTIME_ARTIFACT_POLICY } from './artifact-runtime.mjs';
import { coordinatorResponseFacts, executeCoordinatorResponse, isCoordinatorResponse, COORDINATOR_RESPONSE_POLICY } from './coordinator-response.mjs';
import { runnableCommands } from './store.mjs';
import { NativeError, canonical, copy, invariant, runKey } from './values.mjs';
import { executeTimedTool } from './tool-execution.mjs';
import type { ToolDispatchProof, ToolFailureObservation } from './tool-execution.mjs';
import { reduceCommand, transition } from './transitions.mjs';
import { addUsage, modelToolCatalog, modelRoom, objectValue, plan, reduceModel, reduceTools, settle, validateModelResult } from './machine.mjs';
import { browserTaskMessages } from './task-policy.mjs';
import { normalizeToolIdentities, projectSessionHistory } from './history.mjs';
import { prepareSourceReadQuote, sourceReadBudgetFor, SOURCE_READ_POLICY } from './source-read-budget.mjs';
import { quoteArtifactRequestCapacity, quoteSingleArtifactReadAdmission, selectArtifactRequestResults } from './artifact-request-capacity.mjs';
import { reduceVerification, sealCandidate } from './verification.mjs';
import { effectiveRunConfiguration } from './task-contract.mjs';
import { prepareToolReceipt, reduceToolReceipt, toolReceiptRequest, waitingToolReceipt } from './tool-receipt.mjs';
import { prepareWorkspaceRepair, reduceWorkspaceRepair, workspaceRepairRequest } from './workspace-repair.mjs';
import { recoverClaimed } from './recovery.mjs';
import { observedEffectFailure } from './effect-diagnostics.mjs';
import { toolInputRejection } from './tool-input.mjs';
import { contextSourceDigest, modelContextMessages, validateContextMessages } from './context-view.mjs';
import { assertHookFeedbackRetained, deniedByHook, reduceHook, stagePostHooks } from './hook-runtime.mjs';
import { hookBytes, hookResult } from './hook-contract.mjs';
import { planNativeContext, reduceContextModel } from './context-planning.mjs';
import type { ContextCounters } from './context-planning.mjs';
import { collectContextContributions } from './context-contributions.mjs';
import { refreshContextSources } from './context-source-refresh.mjs';
import { outputRestartPayload } from './output-recovery.mjs';
import { reduceTurnInput } from './turn-input.mjs';
import { modelStreamCapture } from './model-stream.mjs';
import { browserRecoveryTransition } from './browser-runtime.mjs';
import { validateBrowserSessionRef } from './browser-contract.mjs';
import type { BrowserRecovery } from './browser-contract.mjs';
import { commandProbe, stageCommandObservations, unavailableCommands } from './background-runtime.mjs';
import { assertGuidanceRetained } from './guidance.mjs';
import { BACKGROUND_COMMAND_CONTRACT } from './background-contract.mjs';
import { admittedToolBudget } from './child-budget.mjs';
import { admitChildPromotion, childLifecycleRequest, childReadyProbe, childUsageFacts, reduceChildLifecycle, stageChildReady, unsettledChildren } from './child-runtime.mjs';
import type { ChildLifecycleResult, ChildTaskControlState } from './child-contract.mjs';
import { childControlDelivery } from './child-control.mjs';
import type { BackgroundCommandRequest } from './background-contract.mjs';
import { toolResourceUsageFacts, unknownToolResourceUsageFacts } from './tool-resource-usage.mjs';
import { deliverySummaryAllowed, deliveryTaskMessages, wallBudgetStop } from './deadline-delivery.mjs';

export interface KernelOptions {
  policyModules?: readonly NativePolicyModule[];
  store: RunStore; ports: NativePorts; owner: string;
  digest: (value: unknown) => string;
  now?: () => number; monotonicNow?: () => number; random?: () => number;
  onStream?: (identity: PortContext, event: ModelStreamEvent, record: ModelStreamRecord) => void;
  /** Await durable event delivery before dispatching another effect. Failure leaves the ledger resumable. */
  onCheckpoint?: (snapshot: RunSnapshot) => Promise<void>;
}
/** Durable, single-owner driver. Host ports receive no writable ledger capability. */
export class NativeKernel {
  readonly store: RunStore;
  private readonly policies: NativePolicyRegistry;
  private readonly ports: NativePorts;
  private readonly owner: string;
  private readonly digest: KernelOptions['digest'];
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly random: () => number;
  private readonly onStream: NonNullable<KernelOptions['onStream']>;
  private readonly onCheckpoint: KernelOptions['onCheckpoint'];
  private readonly active = new Map<string, AbortController>();
  private readonly clockAnchors = new Map<string, number>();
  private readonly childObservers = new Map<string, { controller: AbortController; canPause: boolean }>();
  constructor(options: KernelOptions) {
    invariant(options.owner.trim(), 'worker_identity_missing');
    this.policies = new NativePolicyRegistry(options.policyModules);
    this.store = options.store; this.ports = options.ports; this.owner = options.owner;
    this.digest = options.digest; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.monotonicNow = options.monotonicNow ?? options.now ?? (() => performance.now());
    this.onStream = options.onStream ?? (() => {});
    this.onCheckpoint = options.onCheckpoint;
  }
  start(identity: RunIdentity, configuration: RunConfiguration,
    options: { expectedParentRunId?: string | null } = {}): RunSnapshot {
    invariant(!configuration.coordinatorResponsePolicy || configuration.childOwnerBinding, 'coordinator_response_parent_unavailable');
    this.policies.bindings(configuration);
    const configDigest = this.digest(configuration);
    let existing: RunSnapshot | null = null;
    try { existing = this.store.load(identity.scope, identity.runId).snapshot; }
    catch (error) { if (!(error instanceof NativeError && error.code === 'run_not_found')) throw error; }
    if (existing) {
      invariant(identity.parentRunId === null || identity.parentRunId === existing.parentRunId, 'session_head_conflict');
      return this.store.create(configuration, initialSnapshot({ ...identity, parentRunId: existing.parentRunId }, configuration, configDigest));
    }
    const head = this.store.sessionHead(identity.scope, identity.sessionId);
    if (Object.hasOwn(options, 'expectedParentRunId')) {
      invariant((head?.runId ?? null) === options.expectedParentRunId, 'session_head_conflict');
    }
    invariant(!head || terminal(head.phase), 'session_already_active');
    invariant(identity.parentRunId === null || identity.parentRunId === head?.runId, 'session_head_conflict');
    const parent = head ? this.store.load(identity.scope, head.runId) : null;
    const rewind = configuration.conversationRewind;
    invariant(!rewind || head && rewind.expectedHeadRunId === head.runId
      && rewind.generation > (head.conversationBranch?.generation ?? 0), 'conversation_rewind_head_conflict');
    invariant(!parent || configuration.conversationSeed === undefined || rewind, 'conversation_seed_requires_new_session');
    invariant(!rewind?.retainedBackgroundCommands?.some(row => !head?.backgroundCommands.some(original => canonical(original) === canonical(row))),
      'conversation_rewind_command_not_owned');
    const initial = initialSnapshot({ ...identity, parentRunId: head?.runId ?? null }, configuration, configDigest);
    const inherited = rewind ? null : parent;
    const branch = rewind ? { commandId: rewind.commandId, generation: rewind.generation } : head?.conversationBranch;
    if (branch) initial.conversationBranch = copy(branch);
    if (initial.planMode && inherited?.snapshot.planMode) initial.planMode = { ...copy(inherited.snapshot.planMode),
      active: initial.planMode.active, revision: inherited.snapshot.planMode.revision + (initial.planMode.active === inherited.snapshot.planMode.active ? 0 : 1) };
    if (initial.planMode && !configuration.contextPolicy) initial.messages.push({ role: 'user', kind: 'plan_mode',
      content: canonical({ authority: 'host_record', planMode: initial.planMode, instructions: this.policies.forRun(configuration).planning.planModeGuidance(initial, configuration) }) });
    if (initial.todos && inherited?.snapshot.todos) {
      initial.todos = copy(inherited.snapshot.todos);
      if (initial.todos.revision > 0 && !configuration.contextPolicy) initial.messages.splice(1, 0, { role: 'user', kind: 'todo_state',
        content: canonical({ authority: 'session_task_state', todos: initial.todos.items, revision: initial.todos.revision }) });
    }
    if (initial.toolDiscovery && inherited?.snapshot.toolDiscovery) {
      const names = inherited.snapshot.toolDiscovery.discovered.filter(name => configuration.tools.some(tool => tool.name === name && tool.discovery)
        && (configuration.contract.allowedToolNames === null || configuration.contract.allowedToolNames.includes(name)));
      initial.toolDiscovery = { discovered: names, promoted: [...names] };
    }
    const history = projectSessionHistory(inherited, configuration, this.digest);
    const snapshot: RunSnapshot = { ...initial,
      messages: [...initial.messages.filter(message => message.role === 'system'), ...history,
        ...initial.messages.filter(message => message.role !== 'system')],
      workspaceRevision: head?.workspaceRevision ?? null,
      workspaceModifiedPaths: copy(head?.workspaceModifiedPaths ?? []), artifactRefs: copy(inherited?.snapshot.artifactRefs ?? []),
      backgroundCommands: copy(rewind ? rewind.retainedBackgroundCommands ?? [] : inherited?.snapshot.backgroundCommands ?? []),
    };
    return this.store.create(configuration, snapshot);
  }
  attach(scope: RunScope, runId: string, configuration?: RunConfiguration): RunSnapshot {
    const record = this.store.load(scope, runId);
    invariant(!configuration || this.digest(configuration) === record.snapshot.configDigest, 'configuration_mismatch');
    invariant(this.digest(record.configuration) === record.snapshot.configDigest, 'stored_configuration_mismatch');
    this.policies.bindings(effectiveRunConfiguration(record.snapshot, record.configuration, this.digest));
    return record.snapshot;
  }
  submit(scope: RunScope, runId: string, command: RunCommand) {
    const result = this.store.enqueue(scope, runId, command);
    if (result.status !== 'rejected' && ['cancel', 'policy_revoked'].includes(command.kind)) {
      this.active.get(runKey(scope, runId))?.abort(new NativeError('command_interrupt'));
    }
    if (result.status === 'accepted' && ['pause', 'promote_child', 'message_child', 'cancel_child'].includes(command.kind)) {
      const observer = this.childObservers.get(runKey(scope, runId));
      if (observer && (command.kind !== 'pause' || observer.canPause)) observer.controller.abort(
        new NativeError(command.kind === 'pause' ? 'child_observation_paused' : 'child_observation_promoted'));
    }
    return result;
  }
  reconcileTool(scope: RunScope, runId: string, originalOperationKey: string, commandId: string) {
    return this.submit(scope, runId, { commandId, kind: 'reconcile_tool', payload: { originalOperationKey } });
  }
  childTasks(scope: RunScope, runId: string): ChildTaskControlState[] {
    const record = this.store.load(scope, runId);
    invariant(record.configuration.childLifecyclePolicy === 'owned-background/v2' && this.ports.children?.tasks, 'child_controls_unavailable');
    return this.childTaskStates(record.snapshot);
  }
  promoteChild(scope: RunScope, runId: string, childRunId: string, commandId: string) {
    invariant(this.store.load(scope, runId).configuration.childPromotionPolicy === 'owned-child-promotion/v1', 'child_promotion_unavailable');
    return this.submit(scope, runId, { commandId, kind: 'promote_child', payload: { childRunId } });
  }
  sendChildInput(scope: RunScope, runId: string, childRunId: string, text: string, expectedGoalRevision: number, commandId: string) {
    return this.submitChildControl(scope, runId, { commandId, kind: 'message_child', payload: { childRunId, text, expectedGoalRevision } });
  }
  cancelChild(scope: RunScope, runId: string, childRunId: string, commandId: string) {
    return this.submitChildControl(scope, runId, { commandId, kind: 'cancel_child', payload: { childRunId } });
  }
  private submitChildControl(scope: RunScope, runId: string, command: RunCommand) {
    const record = this.store.load(scope, runId), send = command.kind === 'message_child';
    // Stable retries retain the original target, even after it becomes terminal.
    if (record.commands.some(row => row.command.commandId === command.commandId)) return this.submit(scope, runId, command);
    invariant(record.configuration.childLifecyclePolicy === 'owned-background/v2' && this.ports.children?.controlTarget
      && this.ports.children.wakeControl && (!send || record.configuration.childInputPolicy === 'owned-child-input/v1'), 'child_controls_unavailable');
    const target = this.ports.children.controlTarget(record.snapshot, String(command.payload.childRunId));
    invariant(target, 'child_control_not_owned');
    childControlDelivery(record.snapshot, command, target);
    const task = this.childTaskStates(record.snapshot).find(task => task.childRunId === target.runId);
    invariant(task && (send ? task.canSendInput : task.canCancel), 'child_control_unavailable');
    return this.submit(scope, runId, command);
  }
  private childTaskStates(snapshot: RunSnapshot): ChildTaskControlState[] {
    const config = this.store.load(snapshot.scope, snapshot.runId).configuration;
    const controls = Boolean(this.ports.children?.controlTarget && this.ports.children.wakeControl);
    return copy(this.ports.children?.tasks?.({ scope: copy(snapshot.scope), runId: snapshot.runId, sessionId: snapshot.sessionId,
      turnId: snapshot.turnId, buildId: snapshot.buildId, parentRunId: snapshot.parentRunId, taskChainId: snapshot.taskChainId }) ?? [])
      .map(task => ({ ...task, canCancel: task.canCancel && controls,
        canSendInput: task.canSendInput && controls && config.childInputPolicy === 'owned-child-input/v1' }));
  }
  private async consumeChildControl(snapshot: RunSnapshot, config: RunConfiguration, command: RunCommand, lease: Lease): Promise<void> {
    const port = this.ports.children, id = String(command.payload.childRunId), send = command.kind === 'message_child';
    let batch: CommitBatch;
    try {
      invariant(config.childLifecyclePolicy === 'owned-background/v2' && port?.controlTarget && port.wakeControl
        && (!send || config.childInputPolicy === 'owned-child-input/v1'), 'child_controls_unavailable');
      const target = port.controlTarget(snapshot, id);
      invariant(target, 'child_control_not_owned');
      const delivery = childControlDelivery(snapshot, command, target), changes: Partial<RunSnapshot> = { childLifecycleCursor: null };
      const facts: { kind: string; payload: ObjectValue }[] = [{ kind: send ? 'child.input_queued' : 'child.cancel_requested',
        payload: { childRunId: id, commandId: command.commandId } }];
      if (!send && snapshot.childApproval?.childRunId === id) {
        facts.push({ kind: 'approval.resolved', payload: { interactionId: snapshot.pendingInteraction?.interactionId ?? '',
          callId: snapshot.childApproval.toolCall.callId, decision: 'canceled', reason: 'child_cancel_requested' } });
        Object.assign(changes, { childApproval: null, pendingInteraction: null, interaction: null,
          ...(snapshot.phase === 'awaiting_interaction' ? { phase: snapshot.resumePhase ?? 'preparing_context', resumePhase: null }
            : snapshot.phase === 'paused' && snapshot.resumePhase === 'awaiting_interaction' ? { resumePhase: 'preparing_context' } : {}) });
      }
      facts.push({ kind: 'command.applied', payload: { kind: command.kind, commandId: command.commandId, reason: 'queued' } });
      batch = { ...transition(snapshot, changes, facts, { commandId: command.commandId, requireNoPendingCommands: false }), childControlDelivery: delivery };
      this.commit(snapshot, lease, batch);
    } catch (error) {
      const code = error instanceof NativeError ? error.code : '';
      if (!['child_controls_unavailable', 'child_control_not_owned', 'invalid_child_control', 'child_control_unavailable',
        'child_control_origin_changed', 'child_control_delivery_changed', 'child_control_result_unknown',
        'parent_control_preempts_child_control', 'child_control_preempts_input', 'stale_child_goal_revision'].includes(code)) throw error;
      this.commit(snapshot, lease, transition(snapshot, {}, [{ kind: 'command.applied', payload: {
        kind: command.kind, commandId: command.commandId, reason: code } }], { commandId: command.commandId, requireNoPendingCommands: false }));
      return;
    }
    // The child inbox is already durable. A failed wake leaves it for the
    // original owner's ordinary recovery/collection path; never re-enqueue it.
    await port!.wakeControl!(this.store.load(snapshot.scope, snapshot.runId).snapshot, batch.childControlDelivery!);
  }
  private startupPromotion(snapshot: RunSnapshot, config: RunConfiguration, results: ToolResult[], changes: Partial<RunSnapshot>) {
    const command = runnableCommands(this.store.load(snapshot.scope, snapshot.runId))[0];
    if (command?.kind !== 'promote_child' || results.length !== 1 || results[0]?.childBudgetSettlement
      || results[0]?.childBudgetReservation?.deliveryMode !== 'foreground') return null;
    const promotion = admitChildPromotion({ ...snapshot, ...changes }, config, command, this.childTaskStates(snapshot));
    return promotion.reason === 'applied' ? { ...promotion, commandId: command.commandId } : null;
  }
  async runUntilIdle(scope: RunScope, runId: string, { signal, waitForRetry = true }: { signal?: AbortSignal; waitForRetry?: boolean } = {}): Promise<RunSnapshot> {
    const initial = this.store.load(scope, runId);
    invariant(this.digest(initial.configuration) === initial.snapshot.configDigest, 'stored_configuration_mismatch');
    this.policies.bindings(effectiveRunConfiguration(initial.snapshot, initial.configuration, this.digest));
    if (terminal(initial.snapshot.phase)) {
      await this.onCheckpoint?.(copy(initial.snapshot));
      return initial.snapshot;
    }
    const key = runKey(scope, runId);
    invariant(!this.active.has(key), 'worker_already_driving');
    let controller = new AbortController();
    this.active.set(key, controller);
    let lease: Lease;
    try { lease = this.store.acquire(scope, runId, this.owner, this.now(), initial.configuration.limits.leaseMs); }
    catch (error) { this.active.delete(key); throw error; }
    if (!['paused', 'awaiting_interaction', 'awaiting_reconciliation'].includes(initial.snapshot.phase)) this.clockAnchors.set(key, this.monotonicNow());
    const externalAbort = () => this.submit(scope, runId, { commandId: `${key}:signal-cancel`, kind: 'cancel', payload: {} });
    if (signal?.aborted) externalAbort();
    signal?.addEventListener('abort', externalAbort, { once: true });
    let leaseError: unknown;
    const heartbeat = setInterval(() => {
      try {
        lease = this.store.renew(scope, runId, lease, this.now(), initial.configuration.limits.leaseMs);
        const commands = this.store.pendingCommands?.(scope, runId)
          ?? runnableCommands(this.store.load(scope, runId));
        if (commands.some(command => ['cancel', 'policy_revoked'].includes(command.kind)))
          controller.abort(new NativeError('command_interrupt'));
      } catch (error) { leaseError = error; controller.abort(new NativeError('lease_lost')); }
    }, Math.max(10, Math.floor(initial.configuration.limits.leaseMs / 3)));
    let deliveredRevision = -1;
    let browserChecked = !(initial.snapshot.browserSessionRefs?.length || initial.snapshot.lastBrowserObservation);
    try {
      while (true) {
        if (leaseError) throw leaseError;
        if (this.onCheckpoint) {
          const checkpoint = this.store.load(scope, runId).snapshot;
          if (checkpoint.revision !== deliveredRevision) {
            await this.onCheckpoint(copy(checkpoint));
            deliveredRevision = checkpoint.revision;
          }
          if (leaseError) throw leaseError;
        }
        const record = this.store.load(scope, runId), snapshot = record.snapshot;
        const config = effectiveRunConfiguration(snapshot, record.configuration, this.digest);
        this.policies.bindings(config);
        if (terminal(snapshot.phase)) return snapshot;
        const commands = runnableCommands(record);
        const command = commands[0];
        if (command) {
          if (command.kind === 'reconcile_tool' || command.kind === 'repair_workspace') {
            this.commit(snapshot, lease, command.kind === 'repair_workspace'
              ? prepareWorkspaceRepair(record, command) : prepareToolReceipt(record, command));
            continue;
          }
          if (['message_child', 'cancel_child'].includes(command.kind)) {
            await this.consumeChildControl(snapshot, config, command, lease);
            continue;
          }
          const intent = record.intents.find(item => item.operationKey === snapshot.pendingIntent) ?? null;
          // A lost claim must be classified before steering can invalidate any
          // request. An undispatched intent can instead be retired definitively.
          if (intent?.status === 'running' && (command.kind === 'steer'
            || command.kind === 'guide' && (command.payload.expectedGoalRevision === undefined || command.payload.expectedGoalRevision === snapshot.goalRevision)
            || ['cancel', 'policy_revoked'].includes(command.kind) && config.childLifecyclePolicy === 'owned-background/v2' && unsettledChildren(snapshot).length)) {
            this.commit(snapshot, lease, await this.recoverEffect(snapshot, config, intent));
            continue;
          }
          const reduced = reduceCommand(snapshot, command, intent, { configuration: config, digest: this.digest,
            ...(command.kind === 'promote_child' ? { childTasks: this.childTaskStates(snapshot) } : {}) });
          this.commit(snapshot, lease, reduced);
          if (reduced.snapshot.childTerminalPhase && controller.signal.aborted) {
            controller = new AbortController(); this.active.set(key, controller);
          }
          continue;
        }
        if (!browserChecked) {
          const pending = record.intents.find(item => item.operationKey === snapshot.pendingIntent) ?? null;
          // Resource loss must not conceal an already claimed effect. Classify
          // its uncertainty before any continuity report can stop the run.
          if (pending?.status === 'running') {
            this.commit(snapshot, lease, await this.recoverEffect(snapshot, config, pending));
            continue;
          }
          const probeStarted = this.monotonicNow();
          const reports = await this.inspectBrowserResources(snapshot, config, controller.signal);
          if (leaseError) throw leaseError;
          if (controller.signal.aborted || runnableCommands(this.store.load(scope, runId)).length) continue;
          const batch = browserRecoveryTransition(snapshot, reports, pending, Math.max(0, this.monotonicNow() - probeStarted));
          browserChecked = true;
          if (batch) {
            try { this.commit(snapshot, lease, batch); }
            catch (error) {
              if (error instanceof NativeError && error.code === 'pending_command_conflict') { browserChecked = false; continue; }
              throw error;
            }
            continue;
          }
        }
        if (snapshot.phase === 'paused' || snapshot.phase === 'awaiting_interaction' || snapshot.phase === 'awaiting_reconciliation') return snapshot;
        const wallExpired = config.limits.maxWallMs !== null && this.elapsed(snapshot) >= config.limits.maxWallMs;
        if (wallExpired && snapshot.pendingIntent === null && snapshot.phase !== 'finalizing') {
          this.commit(snapshot, lease, transition(snapshot, { phase: 'finalizing', outcome: 'budget_exhausted', reason: 'execution_budget_exhausted' },
            [{ kind: 'budget.exhausted', payload: { reason: 'wall_time_hard_limit' } }]));
          continue;
        }
        if (!wallExpired && snapshot.retryNotBefore > this.now()) {
          if (!waitForRetry) return snapshot;
          await new Promise(resolve => setTimeout(resolve, Math.min(50, snapshot.retryNotBefore - this.now())));
          continue;
        }
        const backgroundIntent = record.intents.find(item => item.operationKey === snapshot.pendingIntent) ?? null;
        const childProbe = childReadyProbe(snapshot, config, backgroundIntent);
        if (childProbe && this.ports.children?.readyChildren) {
          let ready: { childRunIds: string[] };
          try { ready = await this.ports.children.readyChildren({ ...childProbe, signal: controller.signal }); }
          catch (error) {
            if (controller.signal.aborted || runnableCommands(this.store.load(scope, runId)).length) continue;
            throw error;
          }
          if (leaseError) throw leaseError;
          if (controller.signal.aborted || runnableCommands(this.store.load(scope, runId)).length) continue;
          const batch = stageChildReady(snapshot, config, backgroundIntent!, childProbe, ready.childRunIds);
          if (batch) {
            try { this.commit(snapshot, lease, batch); }
            catch (error) { if (error instanceof NativeError && error.code === 'pending_command_conflict') continue; throw error; }
            continue;
          }
        }
        const backgroundRequest = commandProbe(snapshot, config, backgroundIntent);
        if (backgroundRequest) {
          const started = this.monotonicNow();
          const observations = await this.inspectBackgroundCommands(backgroundRequest, snapshot, config, controller.signal);
          if (leaseError) throw leaseError;
          if (controller.signal.aborted || runnableCommands(this.store.load(scope, runId)).length) continue;
          const elapsed = Math.max(0, this.monotonicNow() - started);
          let batch: CommitBatch;
          try { batch = stageCommandObservations(snapshot, config, backgroundRequest, observations, backgroundIntent, elapsed); }
          catch { batch = stageCommandObservations(snapshot, config, backgroundRequest, unavailableCommands(backgroundRequest), backgroundIntent, elapsed); }
          try { this.commit(snapshot, lease, batch); }
          catch (error) { if (error instanceof NativeError && error.code === 'pending_command_conflict') continue; throw error; }
          continue;
        }
        const refreshed = refreshContextSources(snapshot, config, backgroundIntent, lease.fence);
        if (refreshed) {
          this.commit(snapshot, lease, refreshed);
          continue;
        }
        if (snapshot.pendingIntent !== null) {
          const intent = record.intents.find(item => item.operationKey === snapshot.pendingIntent);
          invariant(intent, 'pending_intent_missing');
          if (intent.status === 'running') {
            this.commit(snapshot, lease, await this.recoverEffect(snapshot, config, intent));
            continue;
          }
          if (config.limits.maxWallMs !== null && this.elapsed(snapshot) >= config.limits.maxWallMs) {
            this.commit(snapshot, lease, wallBudgetStop(snapshot, intent));
            continue;
          }
          let claimed: EffectIntent;
          try { claimed = this.store.claim(scope, runId, lease, this.now(), intent.operationKey); }
          catch (error) { if (error instanceof NativeError && error.code === 'pending_command_conflict') continue; throw error; }
          const claimedSnapshot = this.store.load(scope, runId).snapshot;
          const batch = await this.execute(claimedSnapshot, config, claimed, controller.signal, lease.fence);
          this.commit(claimedSnapshot, lease, batch);
          continue;
        }
        const next = plan({ ...snapshot, activeElapsedMs: this.elapsed(snapshot) }, config, { context: !!this.ports.context, workspace: !!this.ports.workspace,
          verification: !!this.ports.verification, input: !!this.ports.input }, this.digest, this.policies);
        if (!next) return snapshot;
        try { this.commit(snapshot, lease, next); }
        catch (error) { if (error instanceof NativeError && error.code === 'pending_command_conflict') continue; throw error; }
      }
    } finally {
      clearInterval(heartbeat); this.active.delete(key); this.clockAnchors.delete(key);
      signal?.removeEventListener('abort', externalAbort);
      try { this.store.release(scope, runId, lease); }
      catch (error) { if (!(error instanceof NativeError && error.code === 'stale_fence')) throw error; }
    }
  }
  private async inspectBackgroundCommands(request: BackgroundCommandRequest, snapshot: RunSnapshot, config: RunConfiguration, signal: AbortSignal): Promise<unknown> {
    const remaining = config.limits.maxWallMs === null ? config.limits.effectTimeoutMs
      : Math.min(config.limits.effectTimeoutMs, Math.max(0, config.limits.maxWallMs - this.elapsed(snapshot)));
    if (remaining <= 0) return [];
    if (this.ports.background?.contract !== BACKGROUND_COMMAND_CONTRACT) return unavailableCommands(request);
    const timeout = new AbortController(), probeSignal = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new NativeError('background_command_probe_timeout')), remaining);
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(probeSignal.reason);
      if (probeSignal.aborted) onAbort(); else probeSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([this.ports.background.observe({ ...copy(request), signal: probeSignal }), aborted]);
      probeSignal.throwIfAborted(); return result;
    } catch { return unavailableCommands(request); }
    finally { clearTimeout(timer); probeSignal.removeEventListener('abort', onAbort); }
  }
  private commit(snapshot: RunSnapshot, lease: Lease, batch: CommitBatch): RunSnapshot {
    const now = this.now(), measuredAt = this.monotonicNow(), key = runKey(snapshot.scope, snapshot.runId);
    const elapsed = Math.max(batch.snapshot.activeElapsedMs, this.elapsed(snapshot, measuredAt));
    const accounted = Math.floor(elapsed);
    const committed = this.store.commit(snapshot.scope, snapshot.runId, lease, now, snapshot.revision,
      { ...batch, snapshot: { ...batch.snapshot, activeElapsedMs: accounted } });
    if (this.active.has(key) && !terminal(committed.phase) && !['paused', 'awaiting_interaction', 'awaiting_reconciliation'].includes(committed.phase))
      // Preserve sub-millisecond consumption locally while the ledger and
      // inherited millisecond limits retain their existing integer contract.
      this.clockAnchors.set(key, measuredAt - (elapsed - accounted));
    else this.clockAnchors.delete(key);
    return committed;
  }
  private elapsed(snapshot: RunSnapshot, now = this.monotonicNow()): number {
    const anchor = this.clockAnchors.get(runKey(snapshot.scope, snapshot.runId));
    return snapshot.activeElapsedMs + (anchor === undefined ? 0 : Math.max(0, now - anchor));
  }
  private async inspectBrowserResources(snapshot: RunSnapshot, configuration: RunConfiguration, signal: AbortSignal): Promise<BrowserRecovery[]> {
    const refs = (snapshot.browserSessionRefs ?? []).map(validateBrowserSessionRef);
    invariant(refs.every(ref => canonical(ref.scope) === canonical(snapshot.scope) && ref.runId === snapshot.runId), 'persisted_browser_scope_mismatch');
    if (!refs.length) return [];
    const unavailable = (reason: string): BrowserRecovery[] => refs.map(sessionRef => ({ status: 'lost', sessionRef,
      lastActionSeq: 0, reason, reobserveAvailable: false }));
    if (!this.ports.browser) return unavailable('browser_port_unbound');
    const deadline = new AbortController(), probeSignal = AbortSignal.any([signal, deadline.signal]);
    const remainingWall = configuration.limits.maxWallMs === null ? Infinity : Math.max(1, configuration.limits.maxWallMs - this.elapsed(snapshot));
    const timer = setTimeout(() => deadline.abort(new NativeError('browser_recovery_timeout')), Math.min(configuration.limits.effectTimeoutMs, remainingWall));
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(probeSignal.reason);
      if (probeSignal.aborted) onAbort(); else probeSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const reports = await Promise.race([this.ports.browser.recoverSessions({
        scope: copy(snapshot.scope), runId: snapshot.runId, sessionId: snapshot.sessionId, turnId: snapshot.turnId,
        buildId: snapshot.buildId, parentRunId: snapshot.parentRunId, taskChainId: snapshot.taskChainId,
        operationKey: `${runKey(snapshot.scope, snapshot.runId)}:browser-probe:${snapshot.revision}`, signal: probeSignal, refs: copy(refs),
      }), aborted]);
      probeSignal.throwIfAborted();
      return reports;
    } catch { return unavailable('browser_recovery_probe_failed'); }
    finally { clearTimeout(timer); probeSignal.removeEventListener('abort', onAbort); }
  }
  private async recoverEffect(snapshot: RunSnapshot, config: RunConfiguration, intent: EffectIntent, elapsedMs = 0,
    observedFacts: { kind: string; payload: ObjectValue }[] = []): Promise<CommitBatch> {
    const stagedCalls = intent.payload.calls as unknown as ToolCall[] | undefined;
    if (intent.kind === 'tool' && stagedCalls?.length && stagedCalls.every(call => this.policies.forRun(config).todo.isTodoCall(config, call) || this.policies.forRun(config).planning.isPlanModeCall(config, call) || isCoordinatorResponse(config, call))) {
      // These controls stage pure values. The fenced receipt commit is the only
      // state mutation, so a lost claim cannot have changed external state.
      const results = stagedCalls.map(call => deniedByHook(snapshot, call)
        ? { status: 'error' as const, content: { code: 'pre_tool_hook_denied', executed: false } }
        : isCoordinatorResponse(config, call) ? executeCoordinatorResponse(snapshot, config, call, this.digest)
        : this.policies.forRun(config).planning.isPlanModeCall(config, call)
          ? this.policies.forRun(config).planning.executePlanMode(snapshot, config, call, (intent.payload.interaction ?? null) as ObjectValue | null) : this.policies.forRun(config).todo.executeTodo(snapshot, config, call));
      const changes = stagePostHooks(snapshot, reduceTools(snapshot, results, stagedCalls, intent, config, this.digest, this.policies), config, stagedCalls, results);
      const recoveryPolicy = stagedCalls.some(call => isCoordinatorResponse(config, call)) ? COORDINATOR_RESPONSE_POLICY
        : stagedCalls.some(call => this.policies.forRun(config).planning.isPlanModeCall(config, call)) ? this.policies.forRun(config).planning.PLAN_MODE_POLICY : 'session-todos/v1';
      return settle(snapshot, intent, { operationKey: intent.operationKey, status: 'committed',
        result: { results: results as never, recoveryPolicy } }, changes, elapsedMs,
      [...observedFacts, { kind: 'effect.reconciled', payload: { operationKey: intent.operationKey, policy: recoveryPolicy } },
        ...coordinatorResponseFacts(snapshot, config, stagedCalls, results, this.digest),
        ...stagedCalls.map((call, index) => ({ kind: results[index]!.status === 'approval_required' ? 'approval.requested' : 'tool.completed', payload: { callId: call.callId,
          name: call.name, status: results[index]!.status, content: results[index]!.content,
          ...(results[index]!.status === 'approval_required' ? { interactionId: `${intent.operationKey}:approval` } : {}) } })),
        ...(changes.planMode && changes.planMode.revision !== snapshot.planMode?.revision
          ? [{ kind: 'plan.mode_changed', payload: this.policies.forRun(config).planning.planModeFact({ ...snapshot, ...changes }, changes.messages!.length) }] : []),
        ...(changes.todos && changes.todos.revision !== snapshot.todos?.revision
          ? [{ kind: 'todo.updated', payload: this.policies.forRun(config).todo.todoUpdateFact({ ...snapshot, ...changes }, changes.messages!.length) }] : [])]);
    }
    if (intent.kind === 'child' && config.childLifecyclePolicy === 'owned-background/v2' && this.ports.children?.reconcile) {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
          abort.abort(new NativeError('child_recovery_probe_timeout')); reject(abort.signal.reason);
        }, Math.min(config.limits.effectTimeoutMs, 5000)); });
        const request = childLifecycleRequest(snapshot, intent, abort.signal);
        const result = await Promise.race([this.ports.children.reconcile(request), timeout]);
        if (result !== null) {
          // A lost collector is an observation, not an unfinished child. Seal
          // its known facts first; a fresh fenced collect can wait on those
          // same children without replaying their external effects. Ordinary
          // collect results still require the requested wait/cancel to finish.
          const changes = reduceChildLifecycle(snapshot, config, request, result, this.digest, { observationOnly: true });
          return settle(snapshot, intent, { operationKey: intent.operationKey, status: 'committed',
            result: { ...objectValue(result), recoveryPolicy: 'owned-child-observation/v1' } }, changes, 0,
          [...observedFacts, { kind: 'effect.reconciled', payload: { operationKey: intent.operationKey, policy: 'owned-child-observation/v1' } },
            { kind: 'child.lifecycle_observed', payload: { action: request.action,
              settledChildRunIds: result.results.map(item => item.childBudgetSettlement!.childRunId), pendingChildRunIds: result.pendingChildRunIds } },
            ...childUsageFacts(snapshot, intent.operationKey, result.results)]);
        }
      } catch { /* Unsealed or unavailable facts require explicit recovery, never effect replay. */ }
      finally { clearTimeout(timer); }
    }
    const calls = intent.payload.calls as unknown as ToolCall[] | undefined;
    if (intent.kind === 'tool' && config.childLifecyclePolicy === 'owned-background/v2' && calls?.length === 1
      && ['start/v1', 'delegate/v1'].includes(config.tools.find(tool => tool.name === calls[0]!.name)?.childBudgetPolicy ?? '')
      && this.ports.children?.interruptedReceipts) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NativeError('child_recovery_probe_timeout')),
          Math.min(config.limits.effectTimeoutMs, 5000)); });
        const receipts = await Promise.race([this.ports.children.interruptedReceipts({ scope: copy(snapshot.scope), runId: snapshot.runId,
          parentOperationKey: intent.operationKey }), timeout]);
        if (receipts.length) {
          invariant(receipts.length === 1 && receipts[0]!.parentOperationKey === intent.operationKey
            && receipts[0]!.parentToolCallId === calls[0]!.callId && receipts[0]!.result.childBudgetReservation,
          'child_interrupted_receipt_identity_conflict');
          const results = [copy(receipts[0]!.result)];
          const changes = stagePostHooks(snapshot, reduceTools(snapshot, results, calls, intent, config, this.digest, this.policies), config, calls, results);
          const promotion = this.startupPromotion(snapshot, config, results, changes);
          return { ...settle(snapshot, intent, { operationKey: intent.operationKey, status: 'committed', result: {
            results: results as never, recoveryPolicy: 'owned-child-start/v1' } }, { ...changes, ...promotion?.changes }, elapsedMs,
          [...observedFacts, ...promotion?.facts ?? [], { kind: 'effect.reconciled', payload: { operationKey: intent.operationKey, policy: 'owned-child-start/v1' } },
            ...childUsageFacts(snapshot, intent.operationKey, results), ...toolResourceUsageFacts(intent.operationKey, calls, results),
            ...(promotion ? [{ kind: 'command.applied', payload: { commandId: promotion.commandId, kind: 'promote_child', reason: 'applied' } }] : []),
            { kind: 'tool.completed', payload: { callId: calls[0]!.callId, name: calls[0]!.name, status: results[0]!.status, content: results[0]!.content } }]),
          consumedCommandId: promotion?.commandId ?? null };
        }
      } catch { /* Missing or invalid owner proof remains unknown; no start is repeated. */ }
      finally { clearTimeout(timer); }
    }
    return recoverClaimed(snapshot, config, intent, this.now(), observedFacts);
  }
  private async execute(snapshot: RunSnapshot, configuration: RunConfiguration, intent: EffectIntent, signal: AbortSignal, executionFence: number): Promise<CommitBatch> {
    const started = this.monotonicNow(), abort = new AbortController();
    const effectSignal = AbortSignal.any([signal, abort.signal]);
    const context: PortContext = { scope: copy(snapshot.scope), runId: snapshot.runId, sessionId: snapshot.sessionId,
      turnId: snapshot.turnId, buildId: snapshot.buildId, parentRunId: snapshot.parentRunId, taskChainId: snapshot.taskChainId,
      operationKey: intent.operationKey, signal: effectSignal, executionFence };
    const dispatchProofs = new Map<string, ToolDispatchProof>();
    if (intent.kind === 'tool' && this.ports.tools.executionLifecycle === 'dispatch/v1') {
      for (const call of intent.payload.calls as unknown as ToolCall[])
        if (configuration.tools.find(tool => tool.name === call.name)?.executionTimeoutPolicy === 'dispatch/v2')
          dispatchProofs.set(call.callId, { dispatched: false });
    }
    const idleModel = intent.kind === 'model' && configuration.profile.streaming !== false
      && configuration.profile.streamTimeoutPolicy === 'idle/v1';
    const portTimeout = intent.kind === 'model' && !idleModel ? configuration.profile.requestTimeoutMs : configuration.limits.effectTimeoutMs;
    const wallRemaining = configuration.limits.maxWallMs === null ? Infinity : Math.max(0, configuration.limits.maxWallMs - this.elapsed(snapshot));
    const timeoutMs = Math.min(portTimeout, wallRemaining), wallDeadline = started + wallRemaining;
    let deadline = started + timeoutMs;
    let timeoutCode = wallRemaining <= portTimeout ? 'wall_time_hard_limit' : 'effect_timeout';
    let timer = setTimeout(() => abort.abort(new NativeError(timeoutCode)), timeoutMs);
    const renewActivity = (event: ModelStreamEvent) => {
      if (!idleModel) return;
      const valid = event && typeof event.text === 'string' && (event.kind === 'activity'
        ? event.text === '' && event.metadata === undefined : ['text', 'thinking', 'tool_delta'].includes(event.kind));
      if (!valid) return;
      const now = this.monotonicNow();
      // Late progress cannot revive the expired attempt or its wall allowance.
      if (now >= deadline) { abort.abort(new NativeError(timeoutCode)); return; }
      deadline = Math.min(now + portTimeout, wallDeadline);
      timeoutCode = wallDeadline <= now + portTimeout ? 'wall_time_hard_limit' : 'effect_timeout';
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(new NativeError(timeoutCode)), Math.max(0, deadline - now));
    };
    let abortListener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(effectSignal.reason ?? new NativeError('effect_aborted'));
      if (effectSignal.aborted) abortListener();
      else effectSignal.addEventListener('abort', abortListener, { once: true });
    });
    // A checkpoint command may have canceled this claimed effect before we
    // enter the dispatch race. Observe that rejection immediately; the race
    // below still receives the original rejection and settles it normally.
    void aborted.catch(() => {});
    let raw: ObjectValue, status: EffectReceipt['status'] = 'committed', changes: Partial<RunSnapshot>;
    let consumedCommandId: string | null = null;
    const facts: { kind: string; payload: ObjectValue }[] = [];
    const capture = intent.kind === 'model' && intent.payload.purpose !== 'compaction' && intent.payload.purpose !== 'delivery_review'
      && configuration.contract.finalSubmissionSchema === null
      ? modelStreamCapture(configuration.limits.maxModelStreamBytes ?? 1024 * 1024, this.now,
        (event, record) => this.onStream({ ...context, scope: copy(context.scope) }, event, record)) : null;
    let receiving = true;
    try {
      if (timeoutMs <= 0) abort.abort(new NativeError(timeoutCode));
      effectSignal.throwIfAborted();
      const operation = this.dispatch(context, snapshot, configuration, intent, event => {
        if (!receiving || effectSignal.aborted) return;
        renewActivity(event);
        // Liveness has no transcript, display, or execution authority.
        if (!effectSignal.aborted && event.kind !== 'activity') capture?.emit(event);
      }, dispatchProofs, (call, observation) => {
        if (receiving) facts.push({ kind: 'tool.failure_observed', payload: { contract: 'agentkit.tool-failure/v1',
          operationKey: intent.operationKey, callId: call.callId, name: call.name,
          ...observation, observedAtMs: this.now() } });
      });
      raw = objectValue(await Promise.race([operation, aborted]));
      effectSignal.throwIfAborted();
      invariant(this.monotonicNow() < deadline, timeoutCode);
      switch (intent.kind) {
        case 'child': {
          const request = childLifecycleRequest(snapshot, intent, effectSignal);
          changes = reduceChildLifecycle(snapshot, configuration, request, raw as unknown as ChildLifecycleResult, this.digest);
          facts.push(...childUsageFacts(snapshot, intent.operationKey, (raw as unknown as ChildLifecycleResult).results));
          facts.push({ kind: 'child.lifecycle_observed', payload: { action: request.action,
            settledChildRunIds: (raw as unknown as ChildLifecycleResult).results.map(item => item.childBudgetSettlement!.childRunId),
            pendingChildRunIds: (raw as unknown as ChildLifecycleResult).pendingChildRunIds } });
          if (changes.pendingInteraction && changes.childApproval) facts.push({ kind: 'approval.requested', payload: {
            interactionId: changes.pendingInteraction.interactionId, callId: changes.childApproval.toolCall.callId,
            name: changes.childApproval.toolCall.name, source: 'child_tool', childRunId: changes.childApproval.childRunId,
            arguments: changes.childApproval.toolCall.arguments } });
          break;
        }
        case 'model': {
          if (intent.payload.purpose === 'compaction') {
            const result = validateModelResult(raw as unknown as ModelResult);
            changes = reduceContextModel(snapshot, result, configuration,
              addUsage(snapshot.usage, { ...result.usage, modelCalls: 0, toolCalls: 0 }), this.now(), this.random());
            facts.push({ kind: 'context.summary_completed', payload: { kind: result.kind, usage: objectValue(result.usage),
              messageCursor: snapshot.messages.length, usageReported: result.usageReported !== false,
              proposalAvailable: !!changes.contextState?.compaction?.proposal } });
            break;
          }
          const request = this.taskModelRequest(context, snapshot, configuration, intent);
          const result = normalizeToolIdentities(snapshot, this.policies.forRun(configuration).providerContext.bindAnthropicReplayInput(raw as unknown as ModelResult,
            request.messages, request.tools, request.profile, this.digest), this.digest);
          changes = reduceModel(snapshot, result, configuration, this.now(), this.random(), this.digest, intent.operationKey, this.policies);
          if (configuration.sourceReadPolicy === SOURCE_READ_POLICY) {
            // Counting cannot discard a known model result or trigger a second
            // generation. Cancellation/timeout closes this read-only quote only.
            changes.sourceReadQuote = await Promise.race([prepareSourceReadQuote(snapshot, { ...snapshot, ...changes }, configuration,
              this.taskModelRequest(context, snapshot, configuration, intent), this.ports.context?.tokens, this.digest), aborted]).catch(() => null);
          }
          if (intent.payload.purpose === 'delivery_review') {
            const offset = changes.messages?.slice(snapshot.messages.length).findIndex(message => message.kind === 'delivery_review_source') ?? -1;
            facts.push({ kind: 'completion.delivery_review_completed', payload: { kind: result.kind,
              messageIndex: offset < 0 ? null : snapshot.messages.length + offset,
              messageCursor: changes.messages?.length ?? snapshot.messages.length, text: '',
              toolCalls: offset < 0 ? [] : result.toolCalls.map(objectValue), usage: objectValue(result.usage), usageReported: result.usageReported !== false,
              status: changes.deliveryReview?.status ?? snapshot.deliveryReview!.status } });
            break;
          }
          if (changes.outputRestarts === snapshot.outputRestarts + 1)
            facts.push({ kind: 'output.restarted', payload: outputRestartPayload(snapshot, { ...snapshot, ...changes }) });
          if (changes.candidate) changes.candidate = sealCandidate(changes.candidate, { ...snapshot, ...changes }, configuration, this.digest);
          const rejectedDraft = configuration.contract.finalSubmissionSchema !== null && result.kind === 'final_candidate';
          const appended = changes.messages?.slice(snapshot.messages.length) ?? [];
          const assistantOffset = appended.findIndex(message => message.role === 'assistant');
          if (snapshot.todos && assistantOffset >= 0) {
            const assistantTurns = snapshot.todos.assistantTurns + 1;
            changes.todos = { ...copy(snapshot.todos), assistantTurns,
              ...(result.toolCalls.some(call => call.name === this.policies.forRun(configuration).todo.TODO_WRITE) ? { lastWriteAssistantTurn: assistantTurns } : {}) };
          }
          facts.push({ kind: 'model.completed', payload: { kind: result.kind, text: rejectedDraft ? '' : result.text,
            ...(rejectedDraft ? { candidateStatus: 'rejected' } : {}),
            messageIndex: assistantOffset < 0 ? null : snapshot.messages.length + assistantOffset,
            messageCursor: changes.messages?.length ?? snapshot.messages.length,
            usageReported: result.usageReported !== false,
            toolCalls: result.toolCalls.map(objectValue), usage: objectValue(result.usage) } });
          break;
        }
        case 'input':
          changes = reduceTurnInput(snapshot, raw, configuration);
          if (changes.planMode) facts.push({ kind: 'plan.mode_changed', payload: this.policies.forRun(configuration).planning.planModeFact({ ...snapshot, ...changes }, changes.messages?.length ?? snapshot.messages.length) });
          facts.push({ kind: 'input.completed', payload: { step: intent.payload.step!, status: raw.status!,
            messageCursor: changes.messages?.length ?? snapshot.messages.length } });
          break;
        case 'workspace_repair':
        case 'tool_receipt': {
          const observation = raw as unknown as import('./contracts.mjs').ToolReceiptObservation;
          const record = this.store.load(snapshot.scope, snapshot.runId);
          changes = intent.kind === 'workspace_repair'
            ? reduceWorkspaceRepair(record, intent, raw as unknown as import('./contracts.mjs').WorkspaceRepairResult, this.digest)
            : reduceToolReceipt(record, intent, observation, this.digest);
          facts.push({ kind: intent.kind === 'workspace_repair'
            ? changes.toolReconciliation === null ? 'workspace.repair_completed' : 'workspace.repair_unavailable'
            : changes.toolReconciliation === null ? 'tool.receipt_reconciled' : 'tool.receipt_unavailable',
            payload: { originalOperationKey: intent.payload.originalOperationKey!, callId: intent.payload.callId! } });
          if (changes.toolReconciliation === null) facts.push(...toolResourceUsageFacts(intent.operationKey,
            [snapshot.pendingTools[0]!], [observation.result!]));
          if (changes.toolReconciliation === null) facts.push({ kind: 'tool.completed', payload: {
            callId: intent.payload.callId!, name: snapshot.pendingTools[0]!.name,
            status: observation.result!.status, content: observation.result!.content,
            originalOperationKey: intent.payload.originalOperationKey! } });
          break;
        }
        case 'tool': {
          const calls = intent.payload.calls as unknown as ToolCall[];
          const results = raw.results as unknown as ToolResult[];
          changes = stagePostHooks(snapshot, reduceTools(snapshot, results, calls, intent, configuration, this.digest, this.policies), configuration, calls, results);
          facts.push(...coordinatorResponseFacts(snapshot, configuration, calls, results, this.digest));
          if (changes.todos && changes.todos.revision !== snapshot.todos?.revision)
            facts.push({ kind: 'todo.updated', payload: this.policies.forRun(configuration).todo.todoUpdateFact({ ...snapshot, ...changes }, changes.messages!.length) });
          if (changes.planMode && changes.planMode.revision !== snapshot.planMode?.revision)
            facts.push({ kind: 'plan.mode_changed', payload: this.policies.forRun(configuration).planning.planModeFact({ ...snapshot, ...changes }, changes.messages!.length) });
          const promotion = this.startupPromotion(snapshot, configuration, results, changes);
          if (promotion) {
            Object.assign(changes, promotion.changes); consumedCommandId = promotion.commandId;
            facts.push(...promotion.facts, { kind: 'command.applied', payload: {
              commandId: promotion.commandId, kind: 'promote_child', reason: 'applied' } });
          }
          facts.push(...childUsageFacts(snapshot, intent.operationKey, results), ...toolResourceUsageFacts(intent.operationKey, calls, results));
          for (const [index, result] of results.entries()) facts.push({ kind: result.status === 'approval_required' ? 'approval.requested' : 'tool.completed',
            payload: { callId: calls[index]!.callId, name: calls[index]!.name, status: result.status,
              ...(result.status === 'uncertain' ? {} : { content: result.content }),
              ...(result.interactionId ? { interactionId: `${intent.operationKey}:approval` } : {}) } });
          break;
        }
        case 'workspace': {
          const observation = raw as unknown as WorkspaceObservation;
          invariant(['ok', 'unavailable'].includes(observation.status) && Array.isArray(observation.changedPaths), 'invalid_workspace_observation');
          const revisionChanged = snapshot.usage.toolCalls > 0 && snapshot.workspaceRevision !== null
            && observation.revision !== null && observation.revision !== snapshot.workspaceRevision;
          const browserArtifactOnly = !observation.changedPaths.length
            && snapshot.lastBrowserObservation?.toolCall === snapshot.usage.toolCalls
            && snapshot.lastWorkspaceMutationToolCall !== snapshot.usage.toolCalls;
          changes = { pendingIntent: null, workspaceRevision: observation.revision,
            ...(configuration.deliveryReviewPolicy ? { workspaceObservationStatus: observation.status === 'ok' ? 'captured' as const : 'unavailable' as const } : {}),
            workspaceDirtySinceCheckpoint: snapshot.workspaceDirtySinceCheckpoint || observation.changedPaths.length > 0
              || revisionChanged && !browserArtifactOnly,
            lastWorkspaceMutationToolCall: revisionChanged && !browserArtifactOnly ? snapshot.usage.toolCalls : snapshot.lastWorkspaceMutationToolCall,
            ...(snapshot.workspaceRevision !== observation.revision ? { preparedContext: null } : {}),
            context: { ...snapshot.context, [intent.payload.purpose === 'terminal' ? 'terminalWorkspaceCursor' : 'workspaceCursor']: intent.payload.cursor ?? null },
            workspaceModifiedPaths: [...new Set([...snapshot.workspaceModifiedPaths, ...observation.changedPaths])] };
          if (snapshot.candidate && ['verifying', 'finalizing'].includes(snapshot.phase)
            && (observation.status !== 'ok' || snapshot.candidate.workspaceRevision !== observation.revision)) {
            const repair = snapshot.repairs < configuration.limits.maxRepairs
              && (configuration.limits.maxModelCalls === null
                || modelRoom(snapshot, configuration) > 0);
            changes = { ...changes, phase: repair ? 'preparing_context' : 'finalizing', candidate: null,
              ...(snapshot.deliveryReview ? { deliveryReview: { ...snapshot.deliveryReview, status: 'unavailable' as const, reason: 'review_subject_changed' } } : {}),
              verification: null, outcome: repair ? null : 'unverified', reason: repair ? null : 'candidate_workspace_changed',
              repairs: snapshot.repairs + (repair ? 1 : 0), finalText: repair ? '' : snapshot.candidate.text,
              messages: [...snapshot.messages, { role: 'user', kind: 'verification_feedback',
                content: 'The workspace changed after the candidate was prepared. Recheck actual state before proposing a new final answer.' }] };
          }
          break;
        }
        case 'context':
          if (configuration.contextPolicy) {
            const result = raw as unknown as ContextPlanningResult;
            invariant(['ready', 'compact', 'blocked'].includes(result.action), 'invalid_context_plan');
            changes = { pendingIntent: null, contextState: result.state, preparedContext: null,
              phase: result.action === 'compact' ? 'compacting' : result.action === 'blocked' ? 'finalizing' : 'preparing_context',
              ...(result.action === 'blocked' ? { outcome: 'blocked' as const, reason: result.reason } : {}),
              context: { ...snapshot.context, preparedCursor: intent.payload.cursor ?? null,
                ...(raw.contributions ? { contributions: objectValue(raw.contributions) } : {}) } };
            if (this.policies.forRun(configuration).review.reviewPending(snapshot) && result.action !== 'ready') changes = { ...changes, ...this.policies.forRun(configuration).review.unavailableReview(snapshot, 'review_context_budget_unavailable') };
            if (result.action === 'ready') {
              invariant(result.admission && result.admission.sourceDigest === contextSourceDigest(snapshot, this.digest)
                && result.admission.countedInputTokens + result.admission.maxOutputTokens <= configuration.profile.contextWindow, 'context_admission_invalid');
              changes.preparedContext = { messages: validateContextMessages(result.messages), sourceDigest: result.admission.sourceDigest,
                admission: result.admission,
                ...(result.toolResultPruning ? { toolResultPruning: result.toolResultPruning } : {}),
                ...(configuration.contextSources.length ? { sourceFence: executionFence } : {}) };
              assertHookFeedbackRetained(snapshot, changes.preparedContext.messages);
              assertGuidanceRetained(snapshot, changes.preparedContext.messages);
            }
            if (result.toolResultPruning) facts.push({ kind: 'context.tool_results_pruned',
              payload: result.toolResultPruning as unknown as ObjectValue });
            const discovery = discoveryAfterCleanup(snapshot, result);
            if (discovery) {
              changes.toolDiscovery = discovery;
              changes.preparedContext = null;
              changes.context = { ...changes.context, preparedCursor: null };
              facts.push({ kind: 'tools.discovery_promoted', payload: { names: discovery.promoted } });
            }
            facts.push({ kind: 'context.planned', payload: { action: result.action, reason: result.reason,
              admission: result.admission as unknown as ObjectValue | null, compactions: result.state.compactions,
              ...(raw.contributions ? { contributions: objectValue(raw.contributions) } : {}) } });
            break;
          }
          assertHookFeedbackRetained(snapshot, validateContextMessages(raw.messages));
          assertGuidanceRetained(snapshot, raw.messages as unknown as Message[]);
          changes = { pendingIntent: null, phase: 'preparing_context',
            preparedContext: { messages: validateContextMessages(raw.messages), sourceDigest: contextSourceDigest(snapshot, this.digest) },
            context: { ...snapshot.context, adapter: objectValue(raw.context), preparedCursor: intent.payload.cursor ?? null } };
          facts.push({ kind: 'context.prepared', payload: { sourceDigest: changes.preparedContext!.sourceDigest,
            messageCount: changes.preparedContext!.messages.length, forceCompaction: intent.payload.forceCompaction === true } });
          break;
        case 'verify': changes = reduceVerification(snapshot, raw as unknown as VerificationReport, configuration, this.digest, this.policies); break;
        case 'hook': {
          const result = raw as unknown as HookInvocationResult;
          changes = reduceHook(snapshot, intent, result, configuration);
          if (changes.messages && snapshot.candidate && changes.phase !== 'finalizing' && changes.phase !== 'preparing_context') {
            changes.candidate = sealCandidate(snapshot.candidate, { ...snapshot, ...changes }, configuration, this.digest);
          }
          if (result.status !== 'ok') status = result.status === 'uncertain' ? 'uncertain' : 'failed';
          facts.push({ kind: 'hook.completed', payload: { event: result.event, hookId: result.hookId,
            status: result.status, reason: result.reason, action: result.output?.action ?? null } });
          break;
        }
        default: throw new NativeError('effect_port_not_implemented');
      }
    } catch (error) {
      const code = error instanceof NativeError ? error.code : 'effect_port_error';
      facts.push(observedEffectFailure({ operationKey: intent.operationKey, kind: intent.kind, code,
        nativeError: error instanceof NativeError, signalAborted: effectSignal.aborted,
        elapsedMs: this.monotonicNow() - started, initialTimeoutMs: timeoutMs, observedAtMs: this.now(),
        proofs: [...dispatchProofs.values()] }));
      // Revoke every late callback before reading the live dispatch proofs.
      // v1 and crash recovery keep their original conservative classification.
      if (dispatchProofs.size) abort.abort(error);
      // Cancellation or timeout may win after a child was durably created but
      // before its startup result reached this transaction. Recover that same
      // ownership before a terminal command can discard its budget liability.
      const calls = intent.payload.calls as unknown as ToolCall[] | undefined;
      if (intent.kind === 'tool' && configuration.childLifecyclePolicy === 'owned-background/v2' && calls?.length === 1
        && ['start/v1', 'delegate/v1'].includes(configuration.tools.find(tool => tool.name === calls[0]!.name)?.childBudgetPolicy ?? '')
        && this.ports.children?.interruptedReceipts) {
        return await this.recoverEffect(snapshot, configuration, intent, Math.max(0, this.monotonicNow() - started), facts);
      }
      const preflightOnly = intent.kind === 'tool' && calls!.length > 0
        && calls!.every(call => dispatchProofs.has(call.callId) && !dispatchProofs.get(call.callId)!.dispatched);
      if (preflightOnly) {
        const results: ToolResult[] = calls!.map(() => ({ status: 'error',
          content: { code: 'tool_preflight_aborted', executed: false } }));
        raw = { results: results as never, settlementPolicy: 'dispatch/v2' };
        changes = stagePostHooks(snapshot, reduceTools(snapshot, results, calls!, intent, configuration, this.digest, this.policies), configuration, calls!, results);
        facts.push({ kind: 'tool.preflight_aborted', payload: { operationKey: intent.operationKey, reason: code } },
          ...calls!.map(call => ({ kind: 'tool.completed', payload: { callId: call.callId, name: call.name,
            status: 'error', content: { code: 'tool_preflight_aborted', executed: false } } })));
        if (code === 'wall_time_hard_limit') {
          Object.assign(changes, { phase: 'finalizing', outcome: 'budget_exhausted', reason: code });
          facts.push({ kind: 'budget.exhausted', payload: { reason: code } });
        }
      } else if (intent.kind === 'tool_receipt' || intent.kind === 'workspace_repair') {
        raw = { code }; status = 'failed'; changes = { pendingIntent: null, phase: 'awaiting_reconciliation' };
        facts.push({ kind: intent.kind === 'workspace_repair' ? 'workspace.repair_unavailable' : 'tool.receipt_unavailable',
          payload: { originalOperationKey: intent.payload.originalOperationKey!, reason: code } });
      } else if (intent.kind === 'child') {
        if (['child_observation_paused', 'child_observation_promoted'].includes(code) && configuration.childLifecyclePolicy === 'owned-background/v2'
          && ['poll', 'wait'].includes(String(intent.payload.action)) && (code === 'child_observation_promoted' || !intent.payload.interaction)) {
          raw = { reason: code }; status = 'failed';
          changes = { pendingIntent: null, childLifecycleCursor: null };
          facts.push({ kind: code === 'child_observation_promoted' ? 'child.observation_yielded' : 'child.observation_paused',
            payload: { operationKey: intent.operationKey } });
        } else {
          raw = { code }; status = 'uncertain';
          changes = { pendingIntent: null, phase: 'finalizing', candidate: null, verification: null, finalText: '',
            childLifecycleFailure: intent.payload.action as 'poll' | 'wait' | 'cancel', outcome: 'unverified', reason: 'child_owner_unavailable' };
        }
      } else if (intent.kind === 'context' && configuration.contextPolicy || ['invalid_context_messages', 'invalid_context_tool_pairing', 'context_binding_mismatch', 'context_hook_feedback_missing', 'context_guidance_missing'].includes(code)) {
        raw = { code }; status = 'failed';
        changes = { pendingIntent: null, preparedContext: null, phase: 'finalizing', outcome: 'blocked', reason: code };
        if (this.policies.forRun(configuration).review.reviewPending(snapshot)) changes = this.policies.forRun(configuration).review.unavailableReview(snapshot, code);
      } else if (code === 'wall_time_hard_limit' && intent.kind !== 'tool') {
        raw = { code }; status = 'uncertain';
        changes = { pendingIntent: null, phase: 'finalizing', outcome: 'budget_exhausted', reason: code,
          ...(intent.kind === 'model' ? { diagnostics: { ...snapshot.diagnostics, providerUsageIncomplete: true } } : {}) };
        facts.push({ kind: 'budget.exhausted', payload: { reason: code } });
      } else if (intent.kind === 'model' && !signal.aborted && ['effect_timeout', 'effect_port_error'].includes(code)) {
        const result: ModelResult = { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false,
          failureKind: code === 'effect_timeout' ? 'request_timeout' : 'host_error' };
        raw = objectValue(result);
        changes = intent.payload.purpose === 'compaction' ? reduceContextModel(snapshot, result, configuration,
          addUsage(snapshot.usage, { ...result.usage, modelCalls: 0, toolCalls: 0 }), this.now(), this.random())
          : reduceModel(snapshot, result, configuration, this.now(), this.random(), this.digest, undefined, this.policies);
        status = 'failed';
      } else {
        raw = { code };
        changes = { phase: 'finalizing', pendingIntent: null, outcome: 'unverified', reason: 'effect_outcome_unknown',
          // A claimed tool batch has spent its attempt even when cancellation
          // wins the outer effect race before reduceTools receives results.
          ...(intent.kind === 'tool' ? { usage: { ...snapshot.usage,
            toolCalls: snapshot.usage.toolCalls + (intent.payload.calls as unknown as ToolCall[]).length },
            diagnostics: { ...snapshot.diagnostics, descendantUsageIncomplete: true } } : {}) };
        if (intent.kind === 'tool') {
          changes = waitingToolReceipt(snapshot, configuration, intent) ?? changes;
          facts.push(...unknownToolResourceUsageFacts(intent.operationKey, calls!));
        }
        status = 'uncertain';
      }
    } finally {
      receiving = false;
      clearTimeout(timer); effectSignal.removeEventListener('abort', abortListener);
    }
    if (intent.kind === 'model') {
      if (intent.payload.purpose === 'delivery_review' && !facts.some(fact => fact.kind === 'completion.delivery_review_completed'))
        facts.push({ kind: 'completion.delivery_review_completed', payload: { kind: 'provider_retryable_error', text: '', toolCalls: [],
          messageIndex: null, messageCursor: changes.messages?.length ?? snapshot.messages.length, usage: objectValue(emptyUsage()), usageReported: false,
          status: changes.deliveryReview?.status ?? snapshot.deliveryReview!.status } });
      // Port-supplied display envelopes are never trusted. Only this driver's
      // accepted prefix is bound to the durable effect receipt and event.
      delete raw.displayStream;
      const display = capture?.close();
      if (display) {
        raw.displayStream = objectValue(display);
        const completed = facts.find(fact => fact.kind === 'model.completed');
        if (completed) Object.assign(completed.payload, { operationKey: intent.operationKey, displayStream: objectValue(display) });
        else if (display.records.length || display.truncated || display.discarded) facts.push({ kind: 'model.stream_interrupted', payload: {
          operationKey: intent.operationKey, messageCursor: snapshot.messages.length, displayStream: objectValue(display),
        } });
      }
    }
    return { ...settle(snapshot, intent, { operationKey: intent.operationKey, status, result: raw }, changes, Math.max(0, this.monotonicNow() - started), facts),
      consumedCommandId };
  }
  private taskModelRequest(context: PortContext, snapshot: RunSnapshot, configuration: RunConfiguration, intent: EffectIntent): ModelRequest {
    const review = intent.payload.purpose === 'delivery_review';
    const beforeCall = { ...snapshot, usage: { ...snapshot.usage, modelCalls: snapshot.usage.modelCalls - 1 } };
    return { ...context, profile: copy(configuration.profile), ...(review ? { purpose: 'delivery_review' as const } : {}),
      messages: review ? snapshot.preparedContext ? modelContextMessages(snapshot, this.digest) : this.policies.forRun(configuration).review.deliveryReviewMessages(snapshot)
        : configuration.profile.operatorGuidancePolicy === 'journaled-system/v1' ? modelContextMessages(snapshot, this.digest)
          : deliveryTaskMessages(beforeCall, configuration, browserTaskMessages(beforeCall, configuration, modelContextMessages(snapshot, this.digest))),
      tools: copy(modelToolCatalog(beforeCall, configuration, this.policies)), finalizationOnly: intent.payload.finalizationOnly === true,
      maxInlineImageBytes: configuration.limits.maxInlineImageBytes };
  }
  private async dispatch(context: PortContext, snapshot: RunSnapshot, configuration: RunConfiguration, intent: EffectIntent,
    emit: (event: ModelStreamEvent) => void, dispatchProofs?: Map<string, ToolDispatchProof>,
    onToolFailure?: (call: ToolCall, observation: ToolFailureObservation) => void): Promise<unknown> {
    context.signal.throwIfAborted();
    switch (intent.kind) {
      case 'workspace_repair': {
        invariant(this.ports.tools.repairWorkspace, 'workspace_repair_port_missing');
        const request = workspaceRepairRequest(context, this.store.load(snapshot.scope, snapshot.runId), intent);
        const result = await this.ports.tools.repairWorkspace(request);
        return result.result === null ? result : { ...result, result: await governArtifactResult({ ...context,
          operationKey: request.originalOperationKey }, request.definition, result.result, configuration, this.ports.artifacts) };
      }
      case 'tool_receipt': {
        invariant(this.ports.tools.observeReceipt, 'tool_receipt_port_missing');
        const request = toolReceiptRequest(context, this.store.load(snapshot.scope, snapshot.runId), intent);
        const observation = await this.ports.tools.observeReceipt(request);
        return observation.result === null ? observation : { ...observation, result: await governArtifactResult({ ...context,
          operationKey: request.originalOperationKey }, request.definition, observation.result, configuration, this.ports.artifacts) };
      }
      case 'child': {
        invariant(this.ports.children, 'child_owner_unavailable');
        const observer = new AbortController(), key = runKey(snapshot.scope, snapshot.runId);
        const request = childLifecycleRequest(snapshot, intent, AbortSignal.any([context.signal, observer.signal]));
        const waiting = { controller: observer, canPause: !request.interaction };
        if (request.action !== 'cancel') this.childObservers.set(key, waiting);
        try { return await this.ports.children.collect(request); }
        finally { if (this.childObservers.get(key) === waiting) this.childObservers.delete(key); }
      }
      case 'model': {
        const review = intent.payload.purpose === 'delivery_review';
        invariant(review === this.policies.forRun(configuration).review.reviewPending(snapshot) || intent.payload.purpose === 'compaction', 'model_purpose_changed');
        if (configuration.contextPolicy) {
          invariant(this.ports.context?.tokens?.tokenizerId === configuration.contextPolicy.tokenizerId
            && this.ports.context.tokens.tokenizerDigest === configuration.contextPolicy.tokenizerDigest, 'context_tokenizer_binding_mismatch');
        }
        if (intent.payload.purpose === 'compaction') {
          const chunk = snapshot.contextState?.compaction?.chunk;
          invariant(chunk && chunk.projectionDigest === this.digest(chunk.messages), 'context_summary_quote_changed');
          return this.ports.model.generate({ ...context, profile: { ...copy(configuration.profile), maxOutputTokens: chunk.maxOutputTokens },
            purpose: 'compaction', messages: copy(chunk.messages), tools: [], finalizationOnly: false, maxInlineImageBytes: configuration.limits.maxInlineImageBytes }, emit);
        }
        assertGuidanceRetained(snapshot, modelContextMessages(snapshot, this.digest));
        const beforeCall = { ...snapshot, usage: { ...snapshot.usage, modelCalls: snapshot.usage.modelCalls - 1 } };
        if (configuration.contextPolicy) {
          const admission = snapshot.preparedContext?.admission;
          invariant(admission && admission.toolsDigest === this.digest(modelToolCatalog(beforeCall, configuration, this.policies))
            && admission.tokenizerDigest === configuration.contextPolicy.tokenizerDigest
            && admission.maxOutputTokens === configuration.profile.maxOutputTokens
            && admission.countedInputTokens + admission.maxOutputTokens <= configuration.profile.contextWindow, 'context_admission_invalid');
        }
        const request = this.taskModelRequest(context, snapshot, configuration, intent);
        return this.ports.model.generate(request, emit);
      }
      case 'tool': {
        const calls = intent.payload.calls as unknown as ToolCall[];
        const singleReadAdmission = quoteSingleArtifactReadAdmission(context, snapshot, configuration, intent, this.ports.context?.tokens, this.digest);
        const artifactCapacity = calls.every(call => call.name === 'ArtifactRead' || call.name === 'ArtifactSearch')
          ? await quoteArtifactRequestCapacity(context, snapshot, configuration, intent, this.ports.context?.tokens, this.digest) : null;
        const results = await Promise.all(calls.map(async call => {
          const definition = configuration.tools.find(tool => tool.name === call.name);
          invariant(definition, 'unbound_tool');
          const rejection = toolInputRejection(definition, call);
          if (rejection) return { status: 'error' as const, content: rejection };
          if (definition.approvalPolicy && this.ports.tools.approvalPolicy !== definition.approvalPolicy)
            return { status: 'error' as const, content: { code: 'tool_approval_protocol_unavailable', executed: false } };
          if (deniedByHook(snapshot, call)) return { status: 'error' as const,
            content: { code: 'pre_tool_hook_denied', executed: false } };
          const planDenied = this.policies.forRun(configuration).planning.planModeDenial(snapshot, configuration, call, definition);
          if (planDenied) return planDenied;
          const sourceReadBudget = sourceReadBudgetFor(snapshot, configuration, call, this.digest);
          if (configuration.sourceReadPolicy === SOURCE_READ_POLICY && (definition.sourceObservationPolicy || call.name === 'ArtifactRead')
            && !sourceReadBudget) return { status: 'error' as const, content: { code: call.name === 'ArtifactRead'
              ? 'artifact_page_budget_unavailable' : 'source_read_budget_unavailable' } };
          return executeTimedTool({ signal: context.signal, timeoutMs: definition.timeoutMs,
            onFailure: observation => onToolFailure?.(call, observation),
            dispatchTimed: definition.executionTimeoutPolicy === 'dispatch/v1' || definition.executionTimeoutPolicy === 'dispatch/v2',
            dispatchProof: dispatchProofs?.get(call.callId),
            lifecycleAvailable: this.ports.tools.executionLifecycle === 'dispatch/v1', now: this.monotonicNow,
            execute: async (toolSignal, lifecycle) => {
            toolSignal.throwIfAborted();
            const request = { ...context, signal: toolSignal,
              ...(this.policies.forRun(configuration).planning.activePlanMode(snapshot, configuration)
                && definition.planModeCommandPolicy ? { planMode: 'session-plan/v1' as const } : {}),
              ...(configuration.artifactPolicy === RUNTIME_ARTIFACT_POLICY ? { resultGovernance: RUNTIME_ARTIFACT_POLICY } : {}),
              ...(sourceReadBudget ? { sourceReadBudget } : {}),
              operationKey: calls.length > 1 ? `${context.operationKey}:call:${calls.indexOf(call) + 1}` : context.operationKey,
              call: copy(call), definition: copy(definition), budget: admittedToolBudget(snapshot, configuration, calls.length),
              interaction: intent.payload.interaction as ObjectValue | null };
            const execute = async (): Promise<ToolResult> => {
              if (this.policies.forRun(configuration).planning.activePlanMode(snapshot, configuration) && this.policies.forRun(configuration).planning.isPlanChildCall(configuration, call, definition)
                && (!this.ports.children?.admitPlan || await this.ports.children.admitPlan(request) !== true))
                return this.policies.forRun(configuration).planning.planModeWriteDenial(configuration);
              if (request.planMode && (!this.ports.tools.checkPlanMode || await this.ports.tools.checkPlanMode(request) !== true))
                return this.policies.forRun(configuration).planning.planModeWriteDenial(configuration);
              toolSignal.throwIfAborted();
              const internal = this.policies.executeTool(snapshot, configuration, call, (intent.payload.interaction ?? null) as ObjectValue | null);
              return internal ? Promise.resolve(internal)
              : isCoordinatorResponse(configuration, call)
              ? Promise.resolve(executeCoordinatorResponse(snapshot, configuration, call, this.digest))
              : configuration.toolDiscoveryPolicy && [TOOL_SEARCH, DEFERRED_TOOL_CALL].includes(call.name)
              ? Promise.resolve(executeToolDiscovery(snapshot, configuration, call))
              : configuration.artifactPolicy === RUNTIME_ARTIFACT_POLICY && isArtifactTool(call.name)
              ? executeArtifactTool(request, call, snapshot, configuration, this.ports.artifacts, this.ports.context?.tokens
                && (!sourceReadBudget || this.ports.context.tokens.tokenizerId === sourceReadBudget.counterId
                  && this.ports.context.tokens.tokenizerDigest === sourceReadBudget.tokenizerDigest)
                ? { ...(sourceReadBudget ? { budget: sourceReadBudget } : {}),
                  countText: text => this.ports.context!.tokens!.countText({ ...request, text }),
                  ...(singleReadAdmission ? { admitCompleteRead: singleReadAdmission } : {}),
                  ...(artifactCapacity ? { resultMessageUnits: artifactCapacity.resultMessageUnits,
                    countResult: result => artifactCapacity.countResult(call, result) } : {}) } : undefined)
              : this.ports.tools.execute(request, lifecycle);
            };
            const result = await execute();
            toolSignal.throwIfAborted();
            return await governArtifactResult(request, definition, result, configuration, this.ports.artifacts);
          } });
        }));
        if (!artifactCapacity || results.length === 1 && singleReadAdmission && await singleReadAdmission(results[0]!)) return { results };
        const selected = await selectArtifactRequestResults(artifactCapacity, calls, results, this.digest);
        if (selected === results) return { results };
        return { results: await Promise.all(selected.map((result, index) => result === results[index] ? result
          : governArtifactResult(context, configuration.tools.find(tool => tool.name === calls[index]!.name)!, result,
            configuration, this.ports.artifacts))) };
      }
      case 'input':
        invariant(this.ports.input && Number.isSafeInteger(intent.payload.step) && Number(intent.payload.step) > 1, 'input_port_missing');
        return this.ports.input.prepare({ ...context, step: Number(intent.payload.step) });
      case 'workspace': invariant(this.ports.workspace, 'workspace_port_missing'); return this.ports.workspace.observe(context);
      case 'context': {
        invariant(this.ports.context, 'context_port_missing');
        if (configuration.contextPolicy) {
          const counter = this.ports.context.tokens, policy = configuration.contextPolicy;
          const assertBinding = () => invariant(counter && counter.tokenizerId === policy.tokenizerId && counter.tokenizerDigest === policy.tokenizerDigest, 'context_tokenizer_binding_mismatch');
          assertBinding();
          invariant(counter, 'context_tokenizer_binding_mismatch');
          const counters: ContextCounters = {
            ...(policy.pruneIdleThresholdMinutes === undefined ? {} : { nowMs: this.now() }),
            ...(counter.countMessage ? { countMessage: async (message: Message) => {
              context.signal.throwIfAborted(); assertBinding();
              const count = await counter.countMessage!({ ...context, profile: copy(configuration.profile), message: copy(message),
                ...(configuration.profile.providerToolSearchPolicy === 'anthropic-deferred/v1'
                  ? { tools: copy(modelToolCatalog(snapshot, configuration, this.policies)) } : {}),
                purpose: 'task', maxInlineImageBytes: configuration.limits.maxInlineImageBytes });
              context.signal.throwIfAborted(); assertBinding(); return count;
            } } : {}),
            countRequest: async (messages, tools, purpose, maxOutputTokens) => {
              context.signal.throwIfAborted(); assertBinding();
              const count = await counter.countRequest({ ...context, profile: { ...copy(configuration.profile), maxOutputTokens },
                messages: purpose === 'task' ? configuration.profile.operatorGuidancePolicy === 'journaled-system/v1'
                  ? this.policies.forRun(configuration).providerContext.projectAnthropicReplay(this.policies.forRun(configuration).providerContext.operatorInputView(this.policies.forRun(configuration).providerContext.anthropicTaskFeedback(snapshot, configuration, messages), configuration.profile, this.digest), tools,
                    configuration.profile, snapshot.abandonedReplayDigests ?? [], this.digest).messages
                  : deliveryTaskMessages(snapshot, configuration, browserTaskMessages(snapshot, configuration, messages)) : messages, tools, purpose, maxOutputTokens,
                maxInlineImageBytes: configuration.limits.maxInlineImageBytes });
              context.signal.throwIfAborted(); assertBinding(); return count;
            },
            countText: async (text: string) => { context.signal.throwIfAborted(); assertBinding(); const count = await counter.countText({ ...context, text });
              context.signal.throwIfAborted(); assertBinding(); return count; },
          };
          const collected = await collectContextContributions(context, snapshot, configuration, this.ports.context,
            messages => counters.countRequest(messages, [], 'task', configuration.profile.maxOutputTokens));
          let planned = await planNativeContext(snapshot, configuration, modelToolCatalog(snapshot, configuration, this.policies), counters,
            this.digest, intent.payload.forceCompaction === true, intent.payload.allowCompaction !== false, collected.messages, this.policies);
          if (planned.action === 'blocked' && planned.reason === 'context_finalization_budget_unavailable' && deliverySummaryAllowed(snapshot, configuration))
            planned = await planNativeContext(snapshot, configuration, modelToolCatalog(snapshot, configuration, this.policies), counters,
              this.digest, intent.payload.forceCompaction === true, true, collected.messages, this.policies);
          return configuration.contextSources.length ? { ...planned, contributions: { sources: collected.diagnostics.map(source => ({
            ...source, budgeted: source.admitted ?? 0, admitted: planned.messages.filter(message => message.kind === 'context_contribution'
              && JSON.parse(message.content).sourceId === source.sourceId).length,
          })) } } : planned;
        }
        invariant(this.ports.context.prepare, 'context_prepare_port_missing');
        const prepared = await this.ports.context.prepare({ ...context, snapshot: copy(snapshot), configuration: copy(configuration), forceCompaction: intent.payload.forceCompaction === true });
        return this.policies.forRun(configuration).review.reviewPending(snapshot) ? { ...prepared, messages: this.policies.forRun(configuration).review.deliveryReviewMessages(snapshot, prepared.messages) } : prepared;
      }
      case 'verify': invariant(this.ports.verification && snapshot.candidate, 'verification_port_missing'); return this.ports.verification.verify({ ...context,
        snapshot: copy(snapshot), contract: copy(configuration.contract), candidate: copy(snapshot.candidate) });
      case 'hook': {
        const request = copy(intent.payload.request) as unknown as HookInvocation;
        if (hookBytes(request.input) > request.definition.maxInputBytes) return hookResult(request, 'failed', null, 'input_budget_exceeded');
        if (!this.ports.hooks) return hookResult(request, 'failed', null, 'binding_unavailable');
        return this.ports.hooks.invoke({ ...request, signal: context.signal });
      }
      default: throw new NativeError('effect_port_not_implemented');
    }
  }
}
