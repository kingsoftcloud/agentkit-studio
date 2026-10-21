import { emptyUsage, terminal } from './contracts.mjs';
import type { CommitBatch, EffectIntent, EffectReceipt, Lease, ModelRequest, ModelResult, ModelStreamEvent, ModelStreamRecord, NativePorts, ObjectValue, PortContext,
  RunCommand, RunConfiguration, RunIdentity, RunScope, RunSnapshot, RunStore, ToolCall, ToolResult, VerificationReport, WorkspaceObservation,
  HookInvocation, HookInvocationResult, ContextPlanningResult } from './contracts.mjs';
import { initialSnapshot } from './configuration.mjs';
import { pendingCommands } from './store.mjs';
import { NativeError, canonical, copy, invariant, runKey } from './values.mjs';
import { reduceCommand, transition } from './transitions.mjs';
import { addUsage, advertisedTools, objectValue, plan, reduceModel, reduceTools, settle, validateModelResult } from './machine.mjs';
import { browserTaskMessages } from './task-policy.mjs';
import { normalizeToolIdentities, projectSessionHistory } from './history.mjs';
import { reduceVerification, sealCandidate } from './verification.mjs';
import { effectiveRunConfiguration } from './task-contract.mjs';
import { recoverClaimed } from './recovery.mjs';
import { toolInputRejection } from './tool-input.mjs';
import { contextSourceDigest, modelContextMessages, validateContextMessages } from './context-view.mjs';
import { assertHookFeedbackRetained, deniedByHook, reduceHook, stagePostHooks } from './hook-runtime.mjs';
import { hookBytes, hookResult } from './hook-contract.mjs';
import { planNativeContext, reduceContextModel } from './context-planning.mjs';
import { reduceTurnInput } from './turn-input.mjs';
import { modelStreamCapture } from './model-stream.mjs';
import { browserRecoveryTransition } from './browser-runtime.mjs';
import { validateBrowserSessionRef } from './browser-contract.mjs';
import type { BrowserRecovery } from './browser-contract.mjs';

export interface KernelOptions {
  store: RunStore; ports: NativePorts; owner: string;
  digest: (value: unknown) => string;
  now?: () => number; random?: () => number;
  onStream?: (identity: PortContext, event: ModelStreamEvent, record: ModelStreamRecord) => void;
  /** Await durable event delivery before dispatching another effect. Failure leaves the ledger resumable. */
  onCheckpoint?: (snapshot: RunSnapshot) => Promise<void>;
}
/** Durable, single-owner driver. Host ports receive no writable ledger capability. */
export class NativeKernel {
  readonly store: RunStore;
  private readonly ports: NativePorts;
  private readonly owner: string;
  private readonly digest: KernelOptions['digest'];
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onStream: NonNullable<KernelOptions['onStream']>;
  private readonly onCheckpoint: KernelOptions['onCheckpoint'];
  private readonly active = new Map<string, AbortController>();
  constructor(options: KernelOptions) {
    invariant(options.owner.trim(), 'worker_identity_missing');
    this.store = options.store; this.ports = options.ports; this.owner = options.owner;
    this.digest = options.digest; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.onStream = options.onStream ?? (() => {});
    this.onCheckpoint = options.onCheckpoint;
  }
  start(identity: RunIdentity, configuration: RunConfiguration,
    options: { expectedParentRunId?: string | null } = {}): RunSnapshot {
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
    const initial = initialSnapshot({ ...identity, parentRunId: head?.runId ?? null }, configuration, configDigest);
    const history = projectSessionHistory(parent, configuration, this.digest);
    const snapshot: RunSnapshot = { ...initial,
      messages: [...initial.messages.filter(message => message.role === 'system'), ...history,
        ...initial.messages.filter(message => message.role !== 'system')],
      workspaceRevision: head?.workspaceRevision ?? null,
      workspaceModifiedPaths: copy(head?.workspaceModifiedPaths ?? []), artifactRefs: copy(head?.artifactRefs ?? []),
      backgroundCommands: copy(head?.backgroundCommands ?? []),
    };
    return this.store.create(configuration, snapshot);
  }
  attach(scope: RunScope, runId: string, configuration?: RunConfiguration): RunSnapshot {
    const record = this.store.load(scope, runId);
    invariant(!configuration || this.digest(configuration) === record.snapshot.configDigest, 'configuration_mismatch');
    invariant(this.digest(record.configuration) === record.snapshot.configDigest, 'stored_configuration_mismatch');
    effectiveRunConfiguration(record.snapshot, record.configuration, this.digest);
    return record.snapshot;
  }
  submit(scope: RunScope, runId: string, command: RunCommand) {
    const result = this.store.enqueue(scope, runId, command);
    if (result.status === 'accepted' && ['cancel', 'policy_revoked'].includes(command.kind)) {
      this.active.get(runKey(scope, runId))?.abort(new NativeError('command_interrupt'));
    }
    return result;
  }
  async runUntilIdle(scope: RunScope, runId: string, { signal, waitForRetry = true }: { signal?: AbortSignal; waitForRetry?: boolean } = {}): Promise<RunSnapshot> {
    const initial = this.store.load(scope, runId);
    invariant(this.digest(initial.configuration) === initial.snapshot.configDigest, 'stored_configuration_mismatch');
    effectiveRunConfiguration(initial.snapshot, initial.configuration, this.digest);
    if (terminal(initial.snapshot.phase)) {
      await this.onCheckpoint?.(copy(initial.snapshot));
      return initial.snapshot;
    }
    const key = runKey(scope, runId);
    invariant(!this.active.has(key), 'worker_already_driving');
    const controller = new AbortController();
    this.active.set(key, controller);
    let lease: Lease;
    try { lease = this.store.acquire(scope, runId, this.owner, this.now(), initial.configuration.limits.leaseMs); }
    catch (error) { this.active.delete(key); throw error; }
    const externalAbort = () => this.submit(scope, runId, { commandId: `${key}:signal-cancel`, kind: 'cancel', payload: {} });
    if (signal?.aborted) externalAbort();
    signal?.addEventListener('abort', externalAbort, { once: true });
    let leaseError: unknown;
    const heartbeat = setInterval(() => {
      try {
        lease = this.store.renew(scope, runId, lease, this.now(), initial.configuration.limits.leaseMs);
        const command = pendingCommands(this.store.load(scope, runId))[0];
        if (command && ['cancel', 'policy_revoked'].includes(command.kind)) controller.abort(new NativeError('command_interrupt'));
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
        if (terminal(snapshot.phase)) return snapshot;
        const commands = pendingCommands(record);
        const command = commands[0];
        if (command) {
          const intent = record.intents.find(item => item.operationKey === snapshot.pendingIntent) ?? null;
          // A lost claim must be classified before steering can invalidate any
          // request. An undispatched intent can instead be retired definitively.
          if (intent?.status === 'running' && ['guide', 'steer'].includes(command.kind)) {
            this.commit(snapshot, lease, recoverClaimed(snapshot, config, intent, this.now()));
            continue;
          }
          this.commit(snapshot, lease, reduceCommand(snapshot, command, intent, { configuration: config, digest: this.digest }));
          continue;
        }
        if (!browserChecked) {
          const pending = record.intents.find(item => item.operationKey === snapshot.pendingIntent) ?? null;
          // Resource loss must not conceal an already claimed effect. Classify
          // its uncertainty before any continuity report can stop the run.
          if (pending?.status === 'running') {
            this.commit(snapshot, lease, recoverClaimed(snapshot, config, pending, this.now()));
            continue;
          }
          const probeStarted = this.now();
          const reports = await this.inspectBrowserResources(snapshot, config, controller.signal);
          if (leaseError) throw leaseError;
          if (controller.signal.aborted || pendingCommands(this.store.load(scope, runId)).length) continue;
          const batch = browserRecoveryTransition(snapshot, reports, pending, Math.max(0, this.now() - probeStarted));
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
        if (snapshot.phase === 'paused' || snapshot.phase === 'awaiting_interaction') return snapshot;
        if (snapshot.retryNotBefore > this.now()) {
          if (!waitForRetry) return snapshot;
          await new Promise(resolve => setTimeout(resolve, Math.min(50, snapshot.retryNotBefore - this.now())));
          continue;
        }
        if (snapshot.pendingIntent !== null) {
          const intent = record.intents.find(item => item.operationKey === snapshot.pendingIntent);
          invariant(intent, 'pending_intent_missing');
          if (intent.status === 'running') {
            this.commit(snapshot, lease, recoverClaimed(snapshot, config, intent, this.now()));
            continue;
          }
          try { this.store.claim(scope, runId, lease, this.now(), intent.operationKey); }
          catch (error) { if (error instanceof NativeError && error.code === 'pending_command_conflict') continue; throw error; }
          const claimedSnapshot = this.store.load(scope, runId).snapshot;
          const batch = await this.execute(claimedSnapshot, config, intent, controller.signal);
          this.commit(claimedSnapshot, lease, batch);
          continue;
        }
        const next = plan(snapshot, config, { context: !!this.ports.context, workspace: !!this.ports.workspace,
          verification: !!this.ports.verification, input: !!this.ports.input }, this.digest);
        if (!next) return snapshot;
        try { this.commit(snapshot, lease, next); }
        catch (error) { if (error instanceof NativeError && error.code === 'pending_command_conflict') continue; throw error; }
      }
    } finally {
      clearInterval(heartbeat); this.active.delete(key);
      signal?.removeEventListener('abort', externalAbort);
      try { this.store.release(scope, runId, lease); }
      catch (error) { if (!(error instanceof NativeError && error.code === 'stale_fence')) throw error; }
    }
  }
  private commit(snapshot: RunSnapshot, lease: Lease, batch: CommitBatch): RunSnapshot {
    return this.store.commit(snapshot.scope, snapshot.runId, lease, this.now(), snapshot.revision, batch);
  }
  private async inspectBrowserResources(snapshot: RunSnapshot, configuration: RunConfiguration, signal: AbortSignal): Promise<BrowserRecovery[]> {
    const refs = (snapshot.browserSessionRefs ?? []).map(validateBrowserSessionRef);
    invariant(refs.every(ref => canonical(ref.scope) === canonical(snapshot.scope) && ref.runId === snapshot.runId), 'persisted_browser_scope_mismatch');
    if (!refs.length) return [];
    const unavailable = (reason: string): BrowserRecovery[] => refs.map(sessionRef => ({ status: 'lost', sessionRef,
      lastActionSeq: 0, reason, reobserveAvailable: false }));
    if (!this.ports.browser) return unavailable('browser_port_unbound');
    const deadline = new AbortController(), probeSignal = AbortSignal.any([signal, deadline.signal]);
    const remainingWall = configuration.limits.maxWallMs === null ? Infinity : Math.max(1, configuration.limits.maxWallMs - snapshot.activeElapsedMs);
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
  private async execute(snapshot: RunSnapshot, configuration: RunConfiguration, intent: EffectIntent, signal: AbortSignal): Promise<CommitBatch> {
    const started = this.now(), abort = new AbortController();
    const effectSignal = AbortSignal.any([signal, abort.signal]);
    const context: PortContext = { scope: copy(snapshot.scope), runId: snapshot.runId, sessionId: snapshot.sessionId,
      turnId: snapshot.turnId, buildId: snapshot.buildId, parentRunId: snapshot.parentRunId, taskChainId: snapshot.taskChainId,
      operationKey: intent.operationKey, signal: effectSignal };
    const timeoutMs = intent.kind === 'model' ? configuration.profile.requestTimeoutMs : configuration.limits.effectTimeoutMs;
    const timer = setTimeout(() => abort.abort(new NativeError('effect_timeout')), timeoutMs);
    let abortListener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(effectSignal.reason ?? new NativeError('effect_aborted'));
      if (effectSignal.aborted) abortListener();
      else effectSignal.addEventListener('abort', abortListener, { once: true });
    });
    let raw: ObjectValue, status: EffectReceipt['status'] = 'committed', changes: Partial<RunSnapshot>;
    const facts: { kind: string; payload: ObjectValue }[] = [];
    const capture = intent.kind === 'model' && intent.payload.purpose !== 'compaction'
      && configuration.contract.finalSubmissionSchema === null
      ? modelStreamCapture(configuration.limits.maxModelStreamBytes ?? 1024 * 1024, this.now,
        (event, record) => this.onStream({ ...context, scope: copy(context.scope) }, event, record)) : null;
    let receiving = true;
    try {
      const operation = this.dispatch(context, snapshot, configuration, intent, event => {
        if (receiving && !effectSignal.aborted) capture?.emit(event);
      });
      raw = objectValue(await Promise.race([operation, aborted]));
      effectSignal.throwIfAborted();
      invariant(this.now() - started < timeoutMs, 'effect_timeout');
      switch (intent.kind) {
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
          const result = normalizeToolIdentities(snapshot, raw as unknown as ModelResult, this.digest);
          changes = reduceModel(snapshot, result, configuration, this.now(), this.random());
          if (changes.candidate) changes.candidate = sealCandidate(changes.candidate, { ...snapshot, ...changes }, configuration, this.digest);
          const rejectedDraft = configuration.contract.finalSubmissionSchema !== null && result.kind === 'final_candidate';
          const appended = changes.messages?.slice(snapshot.messages.length) ?? [];
          const assistantOffset = appended.findIndex(message => message.role === 'assistant');
          facts.push({ kind: 'model.completed', payload: { kind: result.kind, text: rejectedDraft ? '' : result.text,
            ...(rejectedDraft ? { candidateStatus: 'rejected' } : {}),
            messageIndex: assistantOffset < 0 ? null : snapshot.messages.length + assistantOffset,
            messageCursor: changes.messages?.length ?? snapshot.messages.length,
            usageReported: result.usageReported !== false,
            toolCalls: result.toolCalls.map(objectValue), usage: objectValue(result.usage) } });
          break;
        }
        case 'input':
          changes = reduceTurnInput(snapshot, raw);
          facts.push({ kind: 'input.completed', payload: { step: intent.payload.step!, status: raw.status!,
            messageCursor: changes.messages?.length ?? snapshot.messages.length } });
          break;
        case 'tool': {
          const calls = intent.payload.calls as unknown as ToolCall[];
          const results = raw.results as unknown as ToolResult[];
          changes = stagePostHooks(snapshot, reduceTools(snapshot, results, calls, intent, configuration, this.digest), configuration, calls, results);
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
                || snapshot.usage.modelCalls + snapshot.descendantUsage.modelCalls < configuration.limits.maxModelCalls);
            changes = { ...changes, phase: repair ? 'preparing_context' : 'finalizing', candidate: null,
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
              context: { ...snapshot.context, preparedCursor: intent.payload.cursor ?? null } };
            if (result.action === 'ready') {
              invariant(result.admission && result.admission.sourceDigest === contextSourceDigest(snapshot, this.digest)
                && result.admission.countedInputTokens + result.admission.maxOutputTokens <= configuration.profile.contextWindow, 'context_admission_invalid');
              changes.preparedContext = { messages: validateContextMessages(result.messages), sourceDigest: result.admission.sourceDigest,
                admission: result.admission };
              assertHookFeedbackRetained(snapshot, changes.preparedContext.messages);
            }
            facts.push({ kind: 'context.planned', payload: { action: result.action, reason: result.reason,
              admission: result.admission as unknown as ObjectValue | null, compactions: result.state.compactions } });
            break;
          }
          assertHookFeedbackRetained(snapshot, validateContextMessages(raw.messages));
          changes = { pendingIntent: null, phase: 'preparing_context',
            preparedContext: { messages: validateContextMessages(raw.messages), sourceDigest: contextSourceDigest(snapshot, this.digest) },
            context: { ...snapshot.context, adapter: objectValue(raw.context), preparedCursor: intent.payload.cursor ?? null } };
          facts.push({ kind: 'context.prepared', payload: { sourceDigest: changes.preparedContext!.sourceDigest,
            messageCount: changes.preparedContext!.messages.length, forceCompaction: intent.payload.forceCompaction === true } });
          break;
        case 'verify': changes = reduceVerification(snapshot, raw as unknown as VerificationReport, configuration, this.digest); break;
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
      if (intent.kind === 'context' && configuration.contextPolicy || ['invalid_context_messages', 'invalid_context_tool_pairing', 'context_binding_mismatch', 'context_hook_feedback_missing'].includes(code)) {
        raw = { code }; status = 'failed';
        changes = { pendingIntent: null, preparedContext: null, phase: 'finalizing', outcome: 'blocked', reason: code };
      } else if (intent.kind === 'model' && !signal.aborted && ['effect_timeout', 'effect_port_error'].includes(code)) {
        const result: ModelResult = { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false,
          failureKind: code === 'effect_timeout' ? 'request_timeout' : 'host_error' };
        raw = objectValue(result);
        changes = intent.payload.purpose === 'compaction' ? reduceContextModel(snapshot, result, configuration,
          addUsage(snapshot.usage, { ...result.usage, modelCalls: 0, toolCalls: 0 }), this.now(), this.random())
          : reduceModel(snapshot, result, configuration, this.now(), this.random());
        status = 'failed';
      } else {
        raw = { code };
        changes = { phase: 'finalizing', pendingIntent: null, outcome: 'unverified', reason: 'effect_outcome_unknown',
          // A claimed tool batch has spent its attempt even when cancellation
          // wins the outer effect race before reduceTools receives results.
          ...(intent.kind === 'tool' ? { usage: { ...snapshot.usage,
            toolCalls: snapshot.usage.toolCalls + (intent.payload.calls as unknown as ToolCall[]).length } } : {}) };
        status = 'uncertain';
      }
    } finally {
      receiving = false;
      clearTimeout(timer); effectSignal.removeEventListener('abort', abortListener);
    }
    if (intent.kind === 'model') {
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
    return settle(snapshot, intent, { operationKey: intent.operationKey, status, result: raw }, changes, Math.max(0, this.now() - started), facts);
  }
  private async dispatch(context: PortContext, snapshot: RunSnapshot, configuration: RunConfiguration, intent: EffectIntent,
    emit: (event: ModelStreamEvent) => void): Promise<unknown> {
    context.signal.throwIfAborted();
    switch (intent.kind) {
      case 'model': {
        if (configuration.contextPolicy) {
          invariant(this.ports.context?.tokens?.tokenizerId === configuration.contextPolicy.tokenizerId
            && this.ports.context.tokens.tokenizerDigest === configuration.contextPolicy.tokenizerDigest, 'context_tokenizer_binding_mismatch');
        }
        if (intent.payload.purpose === 'compaction') {
          const chunk = snapshot.contextState?.compaction?.chunk;
          invariant(chunk && chunk.projectionDigest === this.digest(chunk.messages), 'context_summary_quote_changed');
          return this.ports.model.generate({ ...context, profile: { ...copy(configuration.profile), maxOutputTokens: chunk.maxOutputTokens },
            messages: copy(chunk.messages), tools: [], finalizationOnly: false, maxInlineImageBytes: configuration.limits.maxInlineImageBytes }, () => {});
        }
        const beforeCall = { ...snapshot, usage: { ...snapshot.usage, modelCalls: snapshot.usage.modelCalls - 1 } };
        if (configuration.contextPolicy) {
          const admission = snapshot.preparedContext?.admission;
          invariant(admission && admission.toolsDigest === this.digest(advertisedTools(beforeCall, configuration))
            && admission.tokenizerDigest === configuration.contextPolicy.tokenizerDigest
            && admission.maxOutputTokens === configuration.profile.maxOutputTokens
            && admission.countedInputTokens + admission.maxOutputTokens <= configuration.profile.contextWindow, 'context_admission_invalid');
        }
        const request: ModelRequest = { ...context, profile: copy(configuration.profile),
          messages: browserTaskMessages(beforeCall, configuration, modelContextMessages(snapshot, this.digest)),
          tools: copy(advertisedTools(beforeCall, configuration)), finalizationOnly: intent.payload.finalizationOnly === true,
          maxInlineImageBytes: configuration.limits.maxInlineImageBytes };
        return this.ports.model.generate(request, emit);
      }
      case 'tool': {
        const calls = intent.payload.calls as unknown as ToolCall[];
        const results = await Promise.all(calls.map(async call => {
          const definition = configuration.tools.find(tool => tool.name === call.name);
          invariant(definition, 'unbound_tool');
          const rejection = toolInputRejection(definition, call);
          if (rejection) return { status: 'error' as const, content: rejection };
          if (deniedByHook(snapshot, call)) return { status: 'error' as const,
            content: { code: 'pre_tool_hook_denied', executed: false } };
          const deadline = new AbortController(), started = this.now();
          const toolSignal = AbortSignal.any([context.signal, deadline.signal]);
          const timer = setTimeout(() => deadline.abort(new NativeError('tool_timeout')), definition.timeoutMs);
          let onAbort = () => {};
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () => reject(toolSignal.reason);
            if (toolSignal.aborted) onAbort(); else toolSignal.addEventListener('abort', onAbort, { once: true });
          });
          try {
            toolSignal.throwIfAborted();
            const result = await Promise.race([this.ports.tools.execute({ ...context, signal: toolSignal,
              operationKey: calls.length > 1 ? `${context.operationKey}:call:${calls.indexOf(call) + 1}` : context.operationKey,
              call: copy(call), definition: copy(definition), interaction: intent.payload.interaction as ObjectValue | null }), aborted]);
            toolSignal.throwIfAborted();
            invariant(this.now() - started < definition.timeoutMs, 'tool_timeout');
            return result;
          } catch {
            // A thrown/late tool result cannot establish whether its external mutation happened.
            return { status: 'uncertain' as const, content: { code: 'tool_outcome_unknown' } };
          } finally { clearTimeout(timer); toolSignal.removeEventListener('abort', onAbort); }
        }));
        return { results };
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
          return planNativeContext(snapshot, configuration, advertisedTools(snapshot, configuration), {
            countRequest: async (messages, tools, purpose, maxOutputTokens) => {
              context.signal.throwIfAborted(); assertBinding();
              const count = await counter.countRequest({ ...context, profile: { ...copy(configuration.profile), maxOutputTokens },
                messages: purpose === 'task' ? browserTaskMessages(snapshot, configuration, messages) : messages, tools, purpose, maxOutputTokens,
                maxInlineImageBytes: configuration.limits.maxInlineImageBytes });
              context.signal.throwIfAborted(); assertBinding(); return count;
            },
            countText: async text => { context.signal.throwIfAborted(); assertBinding(); const count = await counter.countText({ ...context, text });
              context.signal.throwIfAborted(); assertBinding(); return count; },
          }, this.digest, intent.payload.forceCompaction === true, intent.payload.allowCompaction !== false);
        }
        invariant(this.ports.context.prepare, 'context_prepare_port_missing');
        return this.ports.context.prepare({ ...context, snapshot: copy(snapshot), configuration: copy(configuration), forceCompaction: intent.payload.forceCompaction === true });
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
