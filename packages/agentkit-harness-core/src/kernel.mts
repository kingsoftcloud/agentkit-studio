import { emptyUsage, terminal } from './contracts.mjs';
import type { CommitBatch, EffectIntent, EffectReceipt, Lease, ModelRequest, ModelResult, ModelStreamEvent, NativePorts, ObjectValue, PortContext,
  RunCommand, RunConfiguration, RunIdentity, RunScope, RunSnapshot, RunStore, ToolCall, ToolResult, VerificationReport, WorkspaceObservation } from './contracts.mjs';
import { initialSnapshot } from './configuration.mjs';
import { pendingCommands } from './store.mjs';
import { NativeError, canonical, copy, invariant, runKey } from './values.mjs';
import { reduceCommand, transition } from './transitions.mjs';
import { advertisedTools, objectValue, plan, reduceModel, reduceTools, settle } from './machine.mjs';
import { normalizeToolIdentities, projectSessionHistory } from './history.mjs';
import { reduceVerification, sealCandidate } from './verification.mjs';
import { recoverClaimed } from './recovery.mjs';
import { toolInputRejection } from './tool-input.mjs';
import { contextSourceDigest, modelContextMessages, validateContextMessages } from './context-view.mjs';

export interface KernelOptions {
  store: RunStore; ports: NativePorts; owner: string;
  digest: (value: unknown) => string;
  now?: () => number; random?: () => number;
  onStream?: (identity: RunIdentity, event: ModelStreamEvent) => void;
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
  private readonly active = new Map<string, AbortController>();
  constructor(options: KernelOptions) {
    invariant(options.owner.trim(), 'worker_identity_missing');
    this.store = options.store; this.ports = options.ports; this.owner = options.owner;
    this.digest = options.digest; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.onStream = options.onStream ?? (() => {});
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
    if (terminal(initial.snapshot.phase)) return initial.snapshot;
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
    try {
      while (true) {
        if (leaseError) throw leaseError;
        const record = this.store.load(scope, runId), snapshot = record.snapshot, config = record.configuration;
        if (terminal(snapshot.phase)) return snapshot;
        const commands = pendingCommands(record);
        const command = commands[0];
        if (command) {
          this.commit(snapshot, lease, reduceCommand(snapshot, command));
          continue;
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
          const batch = await this.execute(snapshot, config, intent, controller.signal);
          this.commit(snapshot, lease, batch);
          continue;
        }
        const next = plan(snapshot, config, { context: !!this.ports.context, workspace: !!this.ports.workspace, verification: !!this.ports.verification });
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
    try {
      const operation = this.dispatch(context, snapshot, configuration, intent);
      raw = objectValue(await Promise.race([operation, aborted]));
      effectSignal.throwIfAborted();
      invariant(this.now() - started < timeoutMs, 'effect_timeout');
      switch (intent.kind) {
        case 'model': {
          const result = normalizeToolIdentities(snapshot, raw as unknown as ModelResult, this.digest);
          changes = reduceModel(snapshot, result, configuration, this.now(), this.random());
          if (changes.candidate) changes.candidate = sealCandidate(changes.candidate, { ...snapshot, ...changes }, configuration, this.digest);
          const rejectedDraft = configuration.contract.finalSubmissionSchema !== null && result.kind === 'final_candidate';
          facts.push({ kind: 'model.completed', payload: { kind: result.kind, text: rejectedDraft ? '' : result.text,
            ...(rejectedDraft ? { candidateStatus: 'rejected' } : {}),
            usageReported: result.usageReported !== false,
            toolCalls: result.toolCalls.map(objectValue), usage: objectValue(result.usage) } });
          break;
        }
        case 'tool': {
          const calls = intent.payload.calls as unknown as ToolCall[];
          const results = raw.results as unknown as ToolResult[];
          changes = reduceTools(snapshot, results, calls, intent, configuration, this.digest);
          for (const [index, result] of results.entries()) facts.push({ kind: result.status === 'approval_required' ? 'approval.requested' : 'tool.completed',
            payload: { callId: calls[index]!.callId, name: calls[index]!.name, status: result.status,
              ...(result.status === 'uncertain' ? {} : { content: result.content }),
              ...(result.interactionId ? { interactionId: `${intent.operationKey}:approval` } : {}) } });
          break;
        }
        case 'workspace': {
          const observation = raw as unknown as WorkspaceObservation;
          invariant(['ok', 'unavailable'].includes(observation.status) && Array.isArray(observation.changedPaths), 'invalid_workspace_observation');
          changes = { pendingIntent: null, workspaceRevision: observation.revision,
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
          changes = { pendingIntent: null, phase: 'preparing_context',
            preparedContext: { messages: validateContextMessages(raw.messages), sourceDigest: contextSourceDigest(snapshot, this.digest) },
            context: { ...snapshot.context, adapter: objectValue(raw.context), preparedCursor: intent.payload.cursor ?? null } };
          facts.push({ kind: 'context.prepared', payload: { sourceDigest: changes.preparedContext!.sourceDigest,
            messageCount: changes.preparedContext!.messages.length, forceCompaction: intent.payload.forceCompaction === true } });
          break;
        case 'verify': changes = reduceVerification(snapshot, raw as unknown as VerificationReport, configuration); break;
        default: throw new NativeError('effect_port_not_implemented');
      }
    } catch (error) {
      const code = error instanceof NativeError ? error.code : 'effect_port_error';
      if (['invalid_context_messages', 'invalid_context_tool_pairing', 'context_binding_mismatch'].includes(code)) {
        raw = { code }; status = 'failed';
        changes = { pendingIntent: null, preparedContext: null, phase: 'finalizing', outcome: 'blocked', reason: code };
      } else if (intent.kind === 'model' && !signal.aborted && ['effect_timeout', 'effect_port_error'].includes(code)) {
        const result: ModelResult = { kind: 'provider_retryable_error', text: '', toolCalls: [], usage: emptyUsage(), usageReported: false,
          failureKind: code === 'effect_timeout' ? 'request_timeout' : 'host_error' };
        raw = objectValue(result);
        changes = reduceModel(snapshot, result, configuration, this.now(), this.random());
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
      clearTimeout(timer); effectSignal.removeEventListener('abort', abortListener);
    }
    return settle(snapshot, intent, { operationKey: intent.operationKey, status, result: raw }, changes, Math.max(0, this.now() - started), facts);
  }
  private async dispatch(context: PortContext, snapshot: RunSnapshot, configuration: RunConfiguration, intent: EffectIntent): Promise<unknown> {
    context.signal.throwIfAborted();
    switch (intent.kind) {
      case 'model': {
        const beforeCall = { ...snapshot, usage: { ...snapshot.usage, modelCalls: snapshot.usage.modelCalls - 1 } };
        const request: ModelRequest = { ...context, profile: copy(configuration.profile), messages: modelContextMessages(snapshot, this.digest),
          tools: copy(advertisedTools(beforeCall, configuration)), finalizationOnly: intent.payload.finalizationOnly === true,
          maxInlineImageBytes: configuration.limits.maxInlineImageBytes };
        return this.ports.model.generate(request, event => { if (!context.signal.aborted) this.onStream(context, event); });
      }
      case 'tool': {
        const calls = intent.payload.calls as unknown as ToolCall[];
        const results = await Promise.all(calls.map(async call => {
          const definition = configuration.tools.find(tool => tool.name === call.name);
          invariant(definition, 'unbound_tool');
          const rejection = toolInputRejection(definition, call);
          if (rejection) return { status: 'error' as const, content: rejection };
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
      case 'workspace': invariant(this.ports.workspace, 'workspace_port_missing'); return this.ports.workspace.observe(context);
      case 'context': invariant(this.ports.context, 'context_port_missing'); return this.ports.context.prepare({ ...context,
        snapshot: copy(snapshot), configuration: copy(configuration), forceCompaction: intent.payload.forceCompaction === true });
      case 'verify': invariant(this.ports.verification && snapshot.candidate, 'verification_port_missing'); return this.ports.verification.verify({ ...context,
        snapshot: copy(snapshot), contract: copy(configuration.contract), candidate: copy(snapshot.candidate) });
      default: throw new NativeError('effect_port_not_implemented');
    }
  }
}
