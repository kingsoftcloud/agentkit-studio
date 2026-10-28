import { emptyUsage } from './contracts.mjs';
import { advanceDirectoryProgress } from './directory-progress.mjs';
import type { CommitBatch, EffectIntent, EffectReceipt, Message, ModelResult, ObjectValue, RunConfiguration, RunSnapshot, ToolCall, ToolResult, Usage } from './contracts.mjs';
import { copy, invariant, canonical } from './values.mjs';
import { prepareEffect, transition } from './transitions.mjs';
import { retryDelay } from './retry.mjs';
import { FINAL_SUBMISSION_TOOL, finalSubmissionTool, submittedFinalText, normalizedFinalText } from './final-submission.mjs';
import { currentHookState, pendingHookFeedback, planHook } from './hook-runtime.mjs';
import { toolContext, deferredToolContexts } from './tool-context.mjs';
import { reduceBrowserReceipt } from './browser-runtime.mjs';
import { advanceInteractionObservation, browserTaskMessages, browserTaskTools, invalidatesBrowserObservation, webObservationDue, webVerificationOnly } from './task-policy.mjs';
import { checkpointCandidate, finishCheckpoint } from './verification.mjs';
import { effectiveGuidanceResponse } from './guidance.mjs';
import { rememberCommand } from './background-runtime.mjs';
import { admittedToolBudget, outstandingChildCalls, reduceChildBudget } from './child-budget.mjs';
import { prepareChildLifecycle, unsettledChildren } from './child-runtime.mjs';
import { toolResourceUsage, toolUsageIncomplete } from './tool-resource-usage.mjs';
import { completeContinuation, outputRecoveryMode, restartContinuation } from './output-recovery.mjs';
import { advanceDiagnosticRecovery, advanceObservedProgress, advanceToolErrorStreak, guardedToolErrorAction,
  refuseUndiagnosedToolAction, reserveDiagnosticTrial, toolErrorRecoveryBoundary, toolErrorRecoveryEnabled,
  toolErrorStreakExhausted } from './tool-error-recovery.mjs';
import { deliveryReadOutsidePaths, deliverySummaryAllowed, deliveryTaskMessages, observeExecutionBudget, rememberDeliveryWrite, scopedDeliveryReader, wallDeliveryOnly } from './deadline-delivery.mjs';
import { contextContinuity } from './context-planning.mjs';
import { discoveryModelTools, resolveDiscoveredCalls, discoveredCallExposed, TOOL_SEARCH } from './tool-discovery.mjs';
import { NativePolicyRegistry } from './policy-registry.mjs';
import { reduceCoordinatorResponses } from './coordinator-response.mjs';

export function objectValue(value: unknown): ObjectValue {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected_json_object');
  return copy(value) as ObjectValue;
}
export function addUsage(left: Usage, right: Usage): Usage {
  const result = emptyUsage();
  for (const key of ['inputTokens', 'outputTokens', 'modelCalls', 'toolCalls', 'cost'] as const) {
    invariant(Number.isFinite(right[key]) && right[key] >= 0
      && (key === 'cost' || Number.isSafeInteger(right[key])), 'invalid_usage');
    result[key] = left[key] + right[key];
    invariant(Number.isFinite(result[key]) && (key === 'cost' || Number.isSafeInteger(result[key])), 'usage_overflow');
  }
  for (const key of ['cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens'] as const) {
    if (left[key] === undefined && right[key] === undefined) continue;
    const current = left[key] ?? 0, added = right[key] ?? 0;
    invariant(Number.isSafeInteger(current) && current >= 0 && Number.isSafeInteger(added) && added >= 0
      && Number.isSafeInteger(current + added), 'invalid_usage');
    result[key] = current + added;
  }
  return result;
}
export function modelRoom(snapshot: RunSnapshot, config: RunConfiguration): number {
  return config.limits.maxModelCalls === null ? Infinity
    : config.limits.maxModelCalls - snapshot.usage.modelCalls - snapshot.descendantUsage.modelCalls - outstandingChildCalls(snapshot, 'model');
}
export function toolRoom(snapshot: RunSnapshot, config: RunConfiguration): number {
  return config.limits.maxToolCalls === null ? Infinity
    : config.limits.maxToolCalls - snapshot.usage.toolCalls - snapshot.descendantUsage.toolCalls - outstandingChildCalls(snapshot, 'tool');
}
function finalizing(snapshot: RunSnapshot, outcome: RunSnapshot['outcome'], reason: string): CommitBatch {
  return transition(snapshot, { phase: 'finalizing', outcome, reason, pendingIntent: null }, [{ kind: 'run.finalizing', payload: { outcome, reason } }]);
}
export function finalizationOnly(snapshot: RunSnapshot, config: RunConfiguration): boolean {
  const calls = modelRoom(snapshot, config);
  return calls <= config.limits.finalizationReserveModelCalls;
}
export function advertisedTools(snapshot: RunSnapshot, config: RunConfiguration, policies = new NativePolicyRegistry()) {
  if (policies.forRun(config).review.reviewPending(snapshot)) return policies.forRun(config).review.deliveryReviewTools(snapshot, config);
  const submission = finalSubmissionTool(config);
  const tools = finalizationOnly(snapshot, config) || toolRoom(snapshot, config) <= 0 ? []
    : browserTaskTools(snapshot, config, wallDeliveryOnly(snapshot, config) && !webObservationDue(snapshot, config) && !webVerificationOnly(snapshot, config)
      ? config.tools.flatMap(tool => { const reader = scopedDeliveryReader(tool, snapshot); return reader ? [reader] : tool.deliveryWrite ? [tool] : []; }) : config.tools).filter(tool => config.contract.allowedToolNames === null
      || config.contract.allowedToolNames.includes(tool.name));
  return [...tools, ...(submission ? [submission] : [])];
}
export interface PlanCapabilities { context: boolean; workspace: boolean; verification: boolean; input?: boolean }
/** Stable declaration is distinct from the per-turn execution admission above. */
export function modelToolCatalog(snapshot: RunSnapshot, config: RunConfiguration, policies = new NativePolicyRegistry()) {
  if ((config.profile.toolCatalogPolicy !== 'stable-task/v1' && config.profile.providerToolSearchPolicy !== 'anthropic-deferred/v1')
    || policies.forRun(config).review.reviewPending(snapshot)) return discoveryModelTools(snapshot, config, advertisedTools(snapshot, config, policies));
  const submission = finalSubmissionTool(config);
  return discoveryModelTools(snapshot, config, [...config.tools.filter(tool => config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(tool.name)),
    ...(submission ? [submission] : [])]);
}
/** Pure next action. Dispatch is impossible until its intent has been committed and claimed. */
export function plan(snapshot: RunSnapshot, config: RunConfiguration, capabilities: PlanCapabilities,
  digest: (value: unknown) => string = canonical, policies = new NativePolicyRegistry()): CommitBatch | null {
  policies.bindings(config);
  if (snapshot.phase === 'paused' || snapshot.phase === 'awaiting_interaction') return null;
  invariant(snapshot.pendingIntent === null, 'pending_effect_requires_dispatch');
  if (snapshot.phase !== 'finalizing' && config.limits.maxWallMs !== null && snapshot.activeElapsedMs >= config.limits.maxWallMs) {
    return finalizing(snapshot, 'budget_exhausted', 'execution_budget_exhausted');
  }
  const childLifecycle = prepareChildLifecycle(snapshot, config);
  if (childLifecycle) return childLifecycle;
  if (snapshot.phase === 'verifying' && config.childLifecyclePolicy !== 'owned-background/v2' && unsettledChildren(snapshot).length) {
    return finalizing(snapshot, 'unverified', 'child_owner_unavailable');
  }
  if (!snapshot.pendingTools.length && snapshot.queuedGuidance.length) return transition(snapshot, {
    messages: [...snapshot.messages, ...snapshot.queuedGuidance], queuedGuidance: [], preparedContext: null,
  });
  if (snapshot.phase === 'finalizing') {
    if (snapshot.outcome !== 'budget_exhausted' && snapshot.candidate && snapshot.verification
      && (snapshot.candidate.purpose === 'checkpoint' || snapshot.verification.workspaceDependency !== 'none')
      && capabilities.workspace && snapshot.context.terminalWorkspaceCursor !== snapshot.candidate.candidateId) {
      return prepareEffect(snapshot, 'workspace', 'finalizing', { cursor: snapshot.candidate.candidateId, purpose: 'terminal' });
    }
    if (snapshot.candidate?.purpose === 'checkpoint' && snapshot.verification && snapshot.outcome === null && snapshot.reason === null) {
      return transition(snapshot, finishCheckpoint(snapshot), [{ kind: 'verification.checkpoint_observed',
        payload: { candidateId: snapshot.candidate.candidateId, toolCalls: snapshot.verificationToolCalls } }]);
    }
    const outcome = snapshot.outcome ?? 'unverified';
    const text = snapshot.candidate?.text ?? snapshot.finalText;
    const phase = snapshot.childTerminalPhase ?? (['effect_outcome_unknown', 'browser_session_unavailable', 'recovery_retry_exhausted',
      'child_owner_unavailable', 'child_receipt_unavailable', 'background_children_unsettled'].includes(snapshot.reason ?? '') ? 'interrupted'
      : outcome === 'failed' || !text.trim() ? 'failed' : 'completed');
    return transition(snapshot, { phase, finalText: snapshot.candidate?.text ?? snapshot.finalText, pendingTools: [] }, [{ kind: 'run.terminal', payload: {
      phase, outcome, reason: snapshot.reason, finalText: snapshot.candidate?.text ?? snapshot.finalText, usage: objectValue(snapshot.usage),
    } }]);
  }
  if (config.limits.maxWallMs !== null && snapshot.activeElapsedMs >= config.limits.maxWallMs) {
    return finalizing(snapshot, 'budget_exhausted', 'execution_budget_exhausted');
  }
  if (snapshot.phase === 'created') return transition(snapshot, { phase: 'preparing_context' }, [
    { kind: 'run.started', payload: { buildId: snapshot.buildId } },
    ...(snapshot.planMode ? [{ kind: 'plan.initialized', payload: policies.forRun(config).planning.planModeFact(snapshot, snapshot.messages.length) }] : []),
    ...(snapshot.todos && snapshot.todos.revision > 0 ? [{ kind: 'todo.initialized', payload: policies.forRun(config).todo.todoUpdateFact(snapshot, snapshot.messages.length) }] : []),
    ...(snapshot.backgroundNotification ? [{ kind: 'background.notification_admitted', payload: { ...snapshot.backgroundNotification } }] : []),
  ]);
  if (snapshot.phase === 'verifying' && snapshot.browserReobservationRefs?.length) {
    return transition(snapshot, { phase: 'preparing_context', candidate: null, verification: null, preparedContext: null,
      messages: [...snapshot.messages, { role: 'user', kind: 'browser_recovery_observation',
        content: canonical({ freshObservationRequired: true, candidateAccepted: false }) }],
    }, [{ kind: 'browser.candidate_rejected', payload: { reason: 'fresh_observation_required' } }]);
  }
  // The first input was admitted before start. Later boundaries drain Host
  // steering only after every result in the previous tool batch is committed.
  // Check candidates too, so input received during the final request is not
  // silently left behind when the delegated engine settles the whole turn.
  if (capabilities.input && snapshot.usage.modelCalls > 0
    && ['preparing_context', 'verifying'].includes(snapshot.phase)
    && snapshot.context.inputModelCursor !== snapshot.usage.modelCalls) {
    return prepareEffect(snapshot, 'input', snapshot.phase, {
      step: snapshot.usage.modelCalls + 1, messageCursor: snapshot.messages.length,
    });
  }
  if (snapshot.phase === 'verifying' && snapshot.candidate?.purpose !== 'checkpoint') {
    const hook = planHook(snapshot, config, 'Stop', digest);
    if (hook) return hook;
  }
  const cursor = `${snapshot.goalRevision}:${snapshot.usage.modelCalls}:${snapshot.usage.toolCalls}:${snapshot.candidate?.candidateId ?? ''}`;
  if (capabilities.workspace && snapshot.context.workspaceCursor !== cursor
    && (['preparing_context', 'verifying'].includes(snapshot.phase) || snapshot.phase === 'compacting' && config.contextPolicy !== null)) {
    return prepareEffect(snapshot, 'workspace', snapshot.phase, { cursor });
  }
  if (snapshot.phase === 'preparing_context' || snapshot.phase === 'compacting') {
    if (snapshot.phase === 'preparing_context' && !policies.forRun(config).review.reviewPending(snapshot) && modelRoom(snapshot, config) > 0) {
      const reminder = policies.beforeModel(snapshot, config);
      if (reminder) return transition(snapshot, reminder, [{ kind: 'todo.reminder', payload: { modelCalls: snapshot.usage.modelCalls } }]);
    }
    const policyCursor = `${snapshot.goalRevision}:${snapshot.usage.modelCalls}:${snapshot.usage.toolCalls}`;
    if (snapshot.phase === 'preparing_context' && modelRoom(snapshot, config) > 0 && snapshot.policyContextCursor !== policyCursor) {
      const contributions = policies.context(snapshot, config);
      if (contributions.length) return transition(snapshot, { policyContextCursor: policyCursor,
        messages: [...snapshot.messages, ...contributions], preparedContext: null,
        context: { ...snapshot.context, preparedCursor: null } }, [{ kind: 'policy.context_staged',
        payload: { policyCursor, policies: policies.bindings(config).map(binding => binding.id) } }]);
    }
    const observation = observeExecutionBudget(snapshot, config);
    if (observation) return observation;
    const recovery = toolErrorRecoveryBoundary(snapshot, config, modelRoom(snapshot, config));
    if (recovery) return recovery;
    if (config.profile.operatorGuidancePolicy === 'journaled-system/v1'
      && snapshot.phase === 'preparing_context' && !policies.forRun(config).review.reviewPending(snapshot) && modelRoom(snapshot, config) > 0) {
      const controls = [{ role: 'system' as const, content: canonical(contextContinuity(snapshot, config, policies)) },
        ...deliveryTaskMessages(snapshot, config, browserTaskMessages(snapshot, config, []))];
      const messages = policies.forRun(config).providerContext.stageOperatorGuidance(snapshot, config, advertisedTools(snapshot, config, policies), controls,
        finalizationOnly(snapshot, config), digest);
      if (messages) return transition(snapshot, { messages, preparedContext: null }, [{ kind: 'model.guidance_staged', payload: {
        modelCall: snapshot.usage.modelCalls, goalRevision: snapshot.goalRevision } }]);
    }
    if (config.contextPolicy && !capabilities.context) return finalizing(snapshot, 'blocked', 'context_port_missing');
    if (snapshot.phase === 'compacting' && !capabilities.context) return finalizing(snapshot, 'blocked', 'context_compaction_unavailable');
    const compaction = config.contextPolicy ? snapshot.contextState?.compaction : null;
    if (snapshot.phase === 'compacting' && compaction) {
      const hook = planHook(snapshot, config, 'PreCompact', digest);
      if (hook) return hook;
      if (compaction.proposal !== null || !compaction.chunk || finalizationOnly(snapshot, config)
        || wallDeliveryOnly(snapshot, config) && !deliverySummaryAllowed(snapshot, config)) {
        return prepareEffect(snapshot, 'context', 'compacting', { cursor, forceCompaction: false,
          allowCompaction: !finalizationOnly(snapshot, config) && (!wallDeliveryOnly(snapshot, config) || deliverySummaryAllowed(snapshot, config)) });
      }
      if (modelRoom(snapshot, config) <= 0) return finalizing(snapshot, 'budget_exhausted', 'model_budget_exhausted');
      return prepareEffect(snapshot, 'model', 'compacting', { purpose: 'compaction', finalizationOnly: false });
    }
    if (capabilities.context && (snapshot.preparedContext === null || snapshot.context.preparedCursor !== cursor)) {
      return prepareEffect(snapshot, 'context', snapshot.phase, { cursor, forceCompaction: snapshot.phase === 'compacting',
        allowCompaction: !finalizationOnly(snapshot, config) && !wallDeliveryOnly(snapshot, config) });
    }
    if (toolErrorStreakExhausted(snapshot) && !snapshot.toolErrorRecovery) {
      return finalizing(snapshot, 'blocked', 'repeated_tool_error_no_progress');
    }
    if (modelRoom(snapshot, config) <= 0) return finalizing(snapshot, 'budget_exhausted', 'model_budget_exhausted');
    if (!policies.forRun(config).review.reviewPending(snapshot) && snapshot.phase === 'preparing_context' && capabilities.workspace && capabilities.verification) {
      const candidate = checkpointCandidate(snapshot, config, digest);
      if (candidate) return transition(snapshot, { phase: 'verifying', candidate, verification: null, preparedContext: null },
        [{ kind: 'verification.checkpoint_started', payload: { workspaceRevision: snapshot.workspaceRevision } }]);
    }
    return prepareEffect(snapshot, 'model', 'requesting_model', policies.forRun(config).review.reviewPending(snapshot)
      ? { purpose: 'delivery_review', finalizationOnly: false } : { finalizationOnly: finalizationOnly(snapshot, config) },
      policies.forRun(config).review.reviewPending(snapshot) ? {} : policies.forRun(config).providerContext.captureAnthropicContext(snapshot, config, modelToolCatalog(snapshot, config, policies), digest));
  }
  if (snapshot.phase === 'executing_tools') {
    const post = planHook(snapshot, config, 'PostToolUse', digest);
    if (post) return post;
    if (!snapshot.pendingTools.length) return transition(snapshot, { phase: 'preparing_context', interaction: null,
      messages: [...snapshot.messages, ...pendingHookFeedback(snapshot), ...snapshot.queuedGuidance], queuedGuidance: [], preparedContext: null,
    });
    const first = snapshot.pendingTools[0]!;
    const refused = refuseUndiagnosedToolAction(snapshot, first, digest);
    if (refused) return refused;
    const definition = config.tools.find(tool => tool.name === first.name);
    if (!definition || config.contract.allowedToolNames !== null && !config.contract.allowedToolNames.includes(first.name)) {
      return transition(snapshot, { pendingTools: snapshot.pendingTools.slice(1), messages: [...snapshot.messages,
        { role: 'tool', content: canonical({ status: 'error', code: 'tool_not_advertised' }), callId: first.callId, name: first.name }] },
      [{ kind: 'tool.rejected', payload: { callId: first.callId, name: first.name, reason: 'tool_not_advertised' } }]);
    }
    if (toolRoom(snapshot, config) <= 0) {
      const messages: Message[] = snapshot.pendingTools.map(call => ({ role: 'tool', callId: call.callId, name: call.name,
        content: canonical({ status: 'error', code: 'tool_budget_exhausted' }) }));
      return transition(snapshot, { phase: 'preparing_context', pendingTools: [], messages: [...snapshot.messages, ...messages] },
        [{ kind: 'tools.budget_exhausted', payload: {} }]);
    }
    let calls: ToolCall[] = [first];
    if (definition.readOnly && definition.concurrentSafe && !definition.delegatedReadOnly && !guardedToolErrorAction(snapshot, first, digest)) {
      calls = [];
      for (const call of snapshot.pendingTools.slice(0, Math.min(config.limits.maxParallelTools, toolRoom(snapshot, config)))) {
        const tool = config.tools.find(item => item.name === call.name);
        if (!tool?.readOnly || !tool.concurrentSafe || tool.delegatedReadOnly || tool.observationRole !== 'none') break;
        if (guardedToolErrorAction(snapshot, call, digest)) break;
        calls.push(call);
      }
    }
    const pre = planHook(snapshot, config, 'PreToolUse', digest, calls);
    if (pre) return pre;
    return reserveDiagnosticTrial(snapshot, first,
      prepareEffect(snapshot, 'tool', 'executing_tools', { calls: calls.map(objectValue), interaction: snapshot.interaction },
        { interaction: null }), digest);
  }
  if (snapshot.phase === 'verifying') {
    invariant(snapshot.candidate, 'verification_candidate_missing');
    if (!capabilities.verification) {
      const review = policies.forRun(config).review.scheduleDeliveryReview(snapshot, config, 'verification_report_missing', digest);
      return review ? transition(snapshot, review, [{ kind: 'completion.delivery_review_started', payload: {} }])
        : finalizing(snapshot, 'unverified', 'verification_report_missing');
    }
    return prepareEffect(snapshot, 'verify', 'verifying', { candidate: objectValue(snapshot.candidate) });
  }
  invariant(false, 'unsupported_phase');
}
function boundReplay(result: ModelResult, config: RunConfiguration): ObjectValue | undefined {
  if (result.providerReplay === undefined) return undefined;
  invariant(config.profile.providerReplayMode !== 'none'
    && result.providerReplay.compatibilityDigest === config.profile.compatibilityDigest, 'provider_replay_binding_mismatch');
  return result.providerReplay;
}
export function validateModelResult(input: ModelResult): ModelResult {
  const result = copy(input);
  invariant(['tool_calls', 'final_candidate', 'output_limit', 'context_overflow', 'empty_response', 'malformed_tool_call',
    'provider_retryable_error', 'provider_terminal_error', 'policy_abort', 'user_abort'].includes(result.kind)
    && typeof result.text === 'string' && Array.isArray(result.toolCalls), 'invalid_model_result');
  addUsage(emptyUsage(), result.usage);
  invariant(result.usageReported === undefined || typeof result.usageReported === 'boolean', 'invalid_usage_report_status');
  const ids = new Set<string>();
  for (const call of result.toolCalls) {
    invariant(typeof call.callId === 'string' && call.callId.trim() && typeof call.name === 'string' && call.name.trim()
      && !ids.has(call.callId), 'invalid_tool_call');
    ids.add(call.callId); objectValue(call.arguments);
    invariant(call.modelCallWrapper === undefined, 'model_must_not_set_call_wrapper');
    invariant(call.wireArgumentsInvalid === undefined || typeof call.wireArgumentsInvalid === 'boolean', 'invalid_tool_call');
    invariant(!call.wireArgumentsInvalid || canonical(call.arguments) === '{}', 'invalid_wire_arguments_must_be_empty');
  }
  invariant(result.kind !== 'tool_calls' || result.toolCalls.length > 0, 'empty_tool_batch');
  invariant(result.kind !== 'final_candidate' || result.text.trim(), 'empty_final_candidate');
  return result;
}
export function reduceModel(snapshot: RunSnapshot, input: ModelResult, config: RunConfiguration, now: number, random: number,
  digest: (value: unknown) => string = canonical, responseId = `${snapshot.runId}:review:${snapshot.usage.modelCalls}`, policies = new NativePolicyRegistry()): Partial<RunSnapshot> {
  const validated = validateModelResult(input);
  const result = validated.kind === 'tool_calls' && !policies.forRun(config).review.reviewPending(snapshot)
    ? { ...validated, toolCalls: resolveDiscoveredCalls(snapshot, config, validated.toolCalls) } : validated;
  const replay = boundReplay(result, config);
  const usage = addUsage(snapshot.usage, { ...result.usage, modelCalls: 0, toolCalls: 0 });
  const base: Partial<RunSnapshot> = { pendingIntent: null, preparedContext: null, usage,
    ...(snapshot.pendingGuidanceIds?.length && effectiveGuidanceResponse(result) ? { pendingGuidanceIds: [] } : {}),
    ...(result.usageReported === false ? { diagnostics: { ...snapshot.diagnostics, providerUsageIncomplete: true } } : {}) };
  if (policies.forRun(config).review.reviewPending(snapshot)) {
    const beforeCall = { ...snapshot, usage: { ...snapshot.usage, modelCalls: snapshot.usage.modelCalls - 1 } };
    const readers = policies.forRun(config).review.deliveryReviewReaders(beforeCall, config);
    if (result.kind === 'tool_calls' && result.toolCalls.length && readers.length
      && result.toolCalls.every(call => readers.some(tool => tool.name === call.name))) return { ...base, phase: 'executing_tools',
      pendingTools: result.toolCalls, modelErrors: 0, continuations: 0,
      deliveryReview: { ...snapshot.deliveryReview!, readRounds: snapshot.deliveryReview!.readRounds + 1, continuationMessages: [] },
      messages: [...snapshot.messages, { role: 'assistant', kind: 'delivery_review_source', content: '', toolCalls: result.toolCalls,
        ...(replay ? { providerReplay: replay, ...(result.replayToolIds ? { replayToolIds: result.replayToolIds } : {}) } : {}) }] };
    if (result.kind === 'context_overflow') return { ...base, ...policies.forRun(config).review.unavailableReview(snapshot, 'review_context_budget_unavailable') };
    if (!['provider_retryable_error', 'provider_terminal_error', 'policy_abort', 'user_abort'].includes(result.kind))
      return { ...base, ...policies.forRun(config).review.reduceDeliveryReview({ ...snapshot, usage }, result, config, digest, responseId) };
  }
  // Only a meaningful sealed task response acknowledges delivery. Provider
  // errors, malformed calls and context-overflow retries keep this input debt.
  if (snapshot.hookState && ['tool_calls', 'final_candidate', 'output_limit'].includes(result.kind)
    && (result.toolCalls.length > 0 || result.text.trim())) base.hookState = { ...currentHookState(snapshot), feedback: [] };
  const message: Message = { role: 'assistant', content: result.text,
    ...(config.contextPolicy?.pruneIdleThresholdMinutes !== undefined && Number.isSafeInteger(now) && now >= 0
      && ['tool_calls', 'final_candidate', 'output_limit'].includes(result.kind) ? { completedAtMs: now } : {}),
    ...(replay ? { providerReplay: replay, ...(result.replayToolIds ? { replayToolIds: result.replayToolIds } : {}) } : {}) };
  switch (result.kind) {
    case 'tool_calls':
      if (deliveryReadOutsidePaths(snapshot, config, result.toolCalls)) return { ...base, phase: 'preparing_context', pendingTools: [],
        messages: [...snapshot.messages, { ...message, toolCalls: result.toolCalls }, ...result.toolCalls.map(call => ({ role: 'tool' as const,
          callId: call.callId, name: call.name, content: canonical({ status: 'error', content: { reason: 'delivery_read_path_not_written', executed: false } }) }))] };
      if (config.contract.finalSubmissionSchema && result.toolCalls.some(call => call.name === FINAL_SUBMISSION_TOOL)) {
        const text = result.toolCalls.length === 1 ? submittedFinalText(result.toolCalls[0]!, config) : null;
        const messages: Message[] = [...snapshot.messages, { ...message, toolCalls: result.toolCalls },
          ...result.toolCalls.map(call => ({ role: 'tool' as const, callId: call.callId, name: call.name,
            content: canonical({ status: text === null ? 'not_dispatched' : 'accepted',
              reason: text === null ? 'final_submission_schema_or_batch_invalid' : 'final_submission_candidate' }) }))];
        if (text !== null) return { ...base, phase: 'verifying', messages, pendingTools: [], modelErrors: 0, continuations: 0,
          candidate: { candidateId: `${snapshot.runId}:candidate:${snapshot.usage.modelCalls}`, text,
            goalRevision: snapshot.goalRevision, workspaceRevision: snapshot.workspaceRevision } };
        const errors = snapshot.modelErrors + 1, exhausted = errors > config.profile.maxRetries;
        return { ...base, messages, pendingTools: [], modelErrors: errors, phase: exhausted ? 'finalizing' : 'preparing_context',
          outcome: exhausted ? 'unverified' : null, reason: exhausted ? 'final_submission_retry_exhausted' : null };
      }
      if (toolRoom(snapshot, config) <= 0) return { ...base, phase: 'finalizing', outcome: 'budget_exhausted', reason: 'tool_call_after_budget_exhaustion' };
      if (finalizationOnly({ ...snapshot, usage: { ...snapshot.usage, modelCalls: snapshot.usage.modelCalls - 1 } }, config)) {
        return { ...base, phase: 'finalizing', outcome: 'budget_exhausted', reason: 'tool_call_after_finalization_reserve' };
      }
      if (result.toolCalls.some(call => !advertisedTools({ ...snapshot,
        usage: { ...snapshot.usage, modelCalls: snapshot.usage.modelCalls - 1 } }, config, policies).some(tool => tool.name === call.name)
        || !discoveredCallExposed(snapshot, config, call))) {
        const unbound = result.toolCalls.some(call => !config.tools.some(tool => tool.name === call.name)
          || !discoveredCallExposed(snapshot, config, call));
        const errors = snapshot.modelErrors + Number(unbound), exhausted = errors > config.profile.maxRetries;
        return { ...base, phase: exhausted ? 'finalizing' : 'preparing_context', pendingTools: [], modelErrors: errors,
          outcome: exhausted ? 'blocked' : null, reason: exhausted ? 'tool_call_not_advertised_retry_exhausted' : null, messages: [...snapshot.messages,
          { ...message, toolCalls: result.toolCalls }, ...result.toolCalls.map(call => ({ role: 'tool' as const,
            callId: call.callId, name: call.name, content: canonical({ status: 'error', code: 'tool_not_advertised' }) }))] };
      }
      return { ...base, phase: 'executing_tools', pendingTools: result.toolCalls,
        messages: [...snapshot.messages, { ...message, toolCalls: result.toolCalls }],
        continuations: 0, modelErrors: 0 };
    case 'final_candidate': {
      if (config.contract.finalSubmissionSchema) {
        const errors = snapshot.modelErrors + 1;
        const exhausted = errors > config.profile.maxRetries || modelRoom(snapshot, config) <= 0;
        const reason = 'final_submission_missing';
        return { ...base, phase: exhausted ? 'finalizing' : 'preparing_context', modelErrors: errors,
          outcome: exhausted ? 'unverified' : null, reason: exhausted ? reason : null,
          messages: [...snapshot.messages, { ...message, kind: 'unstructured_final_draft' },
            { role: 'user', kind: 'final_submission_required', content: 'Submit the complete final answer through submit_final_output.' }] };
      }
      const text = normalizedFinalText(completeContinuation(snapshot.messages, result.text, digest), config.contract.finalOutputFormat);
      return { ...base, phase: 'verifying', modelErrors: 0, candidate: { candidateId: `${snapshot.runId}:candidate:${snapshot.usage.modelCalls}`,
        text, goalRevision: snapshot.goalRevision, workspaceRevision: snapshot.workspaceRevision },
        messages: [...snapshot.messages, { ...message, content: text, kind: 'final_candidate' }] };
    }
    case 'output_limit': {
      if (snapshot.continuations >= config.profile.maxContinuations) {
        if (snapshot.outputRestarts < config.limits.maxOutputRestarts) {
          try { return { ...base, ...restartContinuation(snapshot, config, result.text, digest), phase: 'preparing_context',
            continuations: 0, outputRestarts: snapshot.outputRestarts + 1 }; }
          catch (error) { if (!(error instanceof Error) || !('code' in error)) throw error;
            return { ...base, phase: 'finalizing', outcome: 'blocked', reason: String(error.code) }; }
        }
        return { ...base, phase: 'finalizing', outcome: 'unverified', reason: 'continuation_budget_exhausted' };
      }
      const mode = result.text ? outputRecoveryMode({ ...snapshot, ...base }, config,
        advertisedTools({ ...snapshot, ...base }, config, policies).length > 0) : 'empty_output';
      const responseId = snapshot.pendingIntent ?? `${snapshot.runId}:model:${snapshot.usage.modelCalls}`;
      return { ...base, phase: 'preparing_context', continuations: snapshot.continuations + 1,
        messages: [...snapshot.messages, ...(result.text ? [{ ...message, kind: 'continuation_fragment', continuationResponseId: responseId }] : []),
          { role: 'user', kind: 'continuation_observation', continuationMode: mode, continuationResponseId: responseId,
            continuationFragmentDigest: digest(result.text), content: mode === 'task_resume'
              ? 'The previous output was interrupted while task tools remain available. It is work in progress, not a completed delivery. Continue from the last committed state using the available tools as needed; break remaining work into smaller actions. Incomplete tool calls were not executed. Give a fresh final answer only after the task is complete.'
              : result.text ? 'The last response hit its output limit. Return only the exact missing suffix of that response. Incomplete tool calls were not executed.'
                : 'The last response hit its output limit without visible content or a committed tool call. Continue the task from the last committed state; take the next useful action or answer only if the task is complete.' }] };
    }
    case 'context_overflow':
      return { ...base, phase: 'compacting', context: { ...snapshot.context, preparedCursor: null } };
    case 'empty_response':
    case 'malformed_tool_call':
    case 'provider_retryable_error': {
      const provider = result.kind === 'provider_retryable_error';
      const attempts = (provider ? snapshot.providerErrors : snapshot.modelErrors) + 1;
      const exhausted = attempts > (provider ? config.profile.maxProviderRetries : config.profile.maxRetries);
      const delay = retryDelay(result, attempts, config, random);
      return { ...base, phase: exhausted ? 'finalizing' : 'preparing_context', outcome: exhausted ? 'failed' : null,
        reason: exhausted ? `${result.kind}_retry_exhausted` : null,
        providerErrors: provider ? attempts : snapshot.providerErrors,
        modelErrors: provider ? snapshot.modelErrors : attempts, retryNotBefore: exhausted ? 0 : now + delay,
        messages: provider ? snapshot.messages : [...snapshot.messages, { role: 'user', kind: 'model_feedback',
          content: result.kind === 'empty_response' ? 'The last response was empty. Continue the task or provide a complete answer.' : 'The last tool call was malformed and was not executed. Return complete valid tool arguments.' }] };
    }
    case 'policy_abort': return { ...base, phase: 'finalizing', outcome: 'blocked', reason: 'model_policy_abort' };
    case 'user_abort': return { ...base, phase: 'finalizing', outcome: 'unverified', reason: 'model_user_abort' };
    case 'provider_terminal_error': return { ...base, phase: 'finalizing', outcome: 'failed', reason: 'provider_terminal_error' };
  }
}
export function reduceTools(snapshot: RunSnapshot, results: ToolResult[], calls: ToolCall[], intent: EffectIntent, config: RunConfiguration,
  digest: (value: unknown) => string = canonical, policies = new NativePolicyRegistry()): Partial<RunSnapshot> {
  invariant(results.length === calls.length && calls.length > 0
    && canonical(snapshot.pendingTools.slice(0, calls.length)) === canonical(calls), 'tool_receipt_mismatch');
  const resources = results.map(toolResourceUsage);
  if (results.length === 1 && results[0]!.status === 'uncertain'
    && config.tools.find(tool => tool.name === calls[0]!.name)?.recoveryPolicy === 'receipt-observation/v1') {
    return { pendingIntent: null, phase: 'awaiting_reconciliation', outcome: null, reason: 'effect_outcome_unknown',
      toolReconciliation: { contract: 'agentkit.tool-receipt-observation/v1', operationKey: intent.operationKey, callId: calls[0]!.callId },
      usage: { ...snapshot.usage, toolCalls: snapshot.usage.toolCalls + 1 },
      descendantUsage: addUsage(snapshot.descendantUsage, resources[0]!),
      diagnostics: { ...snapshot.diagnostics, descendantUsageIncomplete: true } };
  }
  let updated = { ...copy(snapshot), browserSessionRefs: copy(snapshot.browserSessionRefs ?? []),
    backgroundCommands: copy(snapshot.backgroundCommands),
    browserReobservationRefs: copy(snapshot.browserReobservationRefs ?? []), lastBrowserObservation: snapshot.lastBrowserObservation ?? null,
    lastBrowserAttemptToolCall: snapshot.lastBrowserAttemptToolCall ?? null,
    lastWebMutationToolCall: snapshot.lastWebMutationToolCall ?? null,
    workspaceDirtySinceCheckpoint: snapshot.workspaceDirtySinceCheckpoint ?? false,
    lastWorkspaceMutationToolCall: snapshot.lastWorkspaceMutationToolCall ?? null,
    unresolvedInteractionObservation: snapshot.unresolvedInteractionObservation ?? null };
  for (const [index, call] of calls.entries()) {
    const result = copy(results[index]!);
    invariant(['ok', 'error', 'approval_required', 'uncertain'].includes(result.status), 'invalid_tool_result');
    if (calls.length > 1 && (result.status === 'approval_required' || result.status === 'uncertain'
      || result.workspaceChangedPaths?.length || result.childRunIds?.length || result.childBudgetReservation || result.childBudgetSettlement || result.browserSessionRef || result.browserObservation || result.backgroundCommandRef
      || (result.resourceUsage?.modelCalls ?? 0) > 0)) {
      return { pendingIntent: null, phase: 'finalizing', outcome: 'blocked', reason: 'parallel_readonly_contract_violation',
        usage: { ...snapshot.usage, toolCalls: snapshot.usage.toolCalls + calls.length },
        descendantUsage: resources.reduce(addUsage, snapshot.descendantUsage),
        diagnostics: { ...snapshot.diagnostics, ...(results.some(toolUsageIncomplete) ? { descendantUsageIncomplete: true } : {}) } };
    }
    if (result.status === 'approval_required') {
      invariant(result.backgroundCommandRef === undefined, 'background_command_before_approval');
      invariant(!result.childBudgetReservation && !result.childBudgetSettlement, 'child_budget_before_approval');
      invariant(!toolUsageIncomplete(result) && Object.values(resources[index]!).every(value => value === 0), 'tool_resource_usage_before_approval');
      invariant(typeof result.interactionId === 'string' && result.interactionId.trim(), 'approval_identity_missing');
      invariant(result.approvalPolicy === undefined || result.approvalPolicy === 'durable-preflight/v1'
        && config.tools.find(tool => tool.name === call.name)?.approvalPolicy === result.approvalPolicy,
      'tool_approval_policy_mismatch');
      return { pendingIntent: null, phase: 'awaiting_interaction', pendingInteraction: {
        interactionId: `${intent.operationKey}:approval`, hostInteractionId: result.interactionId, callId: call.callId, operationKey: intent.operationKey,
        ...(result.approvalPolicy ? { approvalPolicy: result.approvalPolicy } : {}) } };
    }
    updated.usage.toolCalls += 1;
    Object.assign(updated, policies.reduceTool(updated, config, call, result));
    if (result.workspaceChangedPaths?.length) {
      updated.workspaceDirtySinceCheckpoint = true;
      updated.lastWorkspaceMutationToolCall = updated.usage.toolCalls;
    }
    const definition = config.tools.find(tool => tool.name === call.name);
    Object.assign(updated, rememberDeliveryWrite(updated, call, result, definition));
    const childBudget = reduceChildBudget(updated, result, definition, intent.operationKey, call,
      admittedToolBudget(snapshot, config, calls.length), digest);
    updated.childBudgetReservations = childBudget.childBudgetReservations;
    updated.childRunIds = childBudget.childRunIds;
    if (result.coordinatorResponses !== undefined) {
      invariant(definition?.childBudgetPolicy && (result.childBudgetReservation || result.childBudgetSettlement), 'coordinator_response_not_owned');
      Object.assign(updated, reduceCoordinatorResponses(updated, config, result.coordinatorResponses,
        [result.childBudgetSettlement?.childRunId ?? result.childBudgetReservation!.childRunId], digest));
    }
    updated.descendantUsage = addUsage(updated.descendantUsage, childBudget.usage);
    if (toolUsageIncomplete(result)) updated.diagnostics.descendantUsageIncomplete = true;
    updated.backgroundCommands = rememberCommand(updated, result, definition);
    if (invalidatesBrowserObservation(result, config)) updated.lastWebMutationToolCall = updated.usage.toolCalls;
    if (definition) {
      updated.unresolvedInteractionObservation = advanceInteractionObservation(updated.unresolvedInteractionObservation,
        definition, updated.usage.toolCalls, result, digest);
      Object.assign(updated, reduceBrowserReceipt(updated, result, definition, call, digest));
    }
    const browserFields = { backgroundCommands: updated.backgroundCommands,
      browserSessionRefs: updated.browserSessionRefs, browserReobservationRefs: updated.browserReobservationRefs,
      lastBrowserObservation: updated.lastBrowserObservation, lastBrowserAttemptToolCall: updated.lastBrowserAttemptToolCall,
      lastWebMutationToolCall: updated.lastWebMutationToolCall, unresolvedInteractionObservation: updated.unresolvedInteractionObservation,
      descendantUsage: updated.descendantUsage, diagnostics: updated.diagnostics,
      childBudgetReservations: updated.childBudgetReservations, childRunIds: updated.childRunIds };
    if (updated.phase === 'finalizing') return { ...browserFields, pendingIntent: null, phase: 'finalizing',
      outcome: updated.outcome, reason: updated.reason, preparedContext: updated.preparedContext, contextState: updated.contextState,
      candidate: updated.candidate, verification: updated.verification, finalText: updated.finalText, usage: updated.usage };
    if (result.status === 'uncertain') return { ...browserFields, pendingIntent: null, phase: 'finalizing', outcome: 'unverified', reason: 'effect_outcome_unknown', usage: updated.usage };
    updated.toolErrorStreak = advanceToolErrorStreak(updated, call, result, definition, config, digest);
    if (toolErrorRecoveryEnabled(config)) {
      if (result.sourceObservationState !== 'unread') Object.assign(updated, advanceObservedProgress(updated, result, definition, digest));
      Object.assign(updated, advanceDiagnosticRecovery(updated, updated, call, result, definition, digest));
    }
    updated.messages.push({ ...(result.context === undefined ? { content: canonical(result.content) } : toolContext(result.context)),
      role: 'tool', callId: call.callId, name: call.name,
      ...(config.contextPolicy?.pruneToolResults || config.contextPolicy?.sourceReusePolicy ? { toolOutcome: result.status } : {}),
      ...(definition?.contextRetention === 'persistent' ? { persistent: true } : {}) });
    if (updated.toolDiscovery && call.name === TOOL_SEARCH && result.status === 'ok'
      && result.content && typeof result.content === 'object' && !Array.isArray(result.content)) {
      const names = result.content.tool_names;
      invariant(Array.isArray(names) && names.length <= 20 && names.every(name => typeof name === 'string'
        && config.tools.some(tool => tool.name === name && tool.discovery?.deferred)
        && (config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(name))), 'invalid_tool_discovery_receipt');
      updated.toolDiscovery.discovered = [...new Set([...updated.toolDiscovery.discovered, ...names as string[]])];
      updated.messages.at(-1)!.discoveredToolNames = names as string[];
    }
    if (definition?.deliveryWrite && !definition.readOnly && result.status === 'ok' && result.content && typeof result.content === 'object'
      && !Array.isArray(result.content) && result.content.ok === true && result.content.path === call.arguments.path
      && result.workspaceChangedPaths?.includes(String(call.arguments.path)))
      updated.context.lastDeliveryWriteReceipt = { runId: updated.runId, goalRevision: updated.goalRevision,
        toolCalls: updated.usage.toolCalls, callId: call.callId, receiptDigest: canonical(updated.messages.at(-1)) };
    updated.queuedGuidance.push(...deferredToolContexts(result.additionalContexts));
    const directoryProgress = advanceDirectoryProgress(updated, call, result, definition, intent);
    if (directoryProgress) updated.context = { ...updated.context, directoryProgress };
    if (result.status === 'ok' && result.sourceObservationState !== 'unread' && definition && ['workspace_read', 'workspace_search', 'workspace_list', 'artifact_read'].includes(definition.contextRole)) {
      const prior = updated.context.observedSourceDigests;
      const observed: ObjectValue = prior && typeof prior === 'object' && !Array.isArray(prior) ? copy(prior) : {};
      const key = digest({ name: call.name, arguments: call.arguments }), value = config.artifactPolicy === 'runtime-artifacts/v1'
        && result.artifactObservationDigest ? result.artifactObservationDigest : digest({ content: result.content, artifacts: result.artifactRefs ?? [] });
      if (observed[key] !== value) {
        observed[key] = value;
        if (Object.keys(observed).length > 128) delete observed[Object.keys(observed)[0]!];
        updated.context = { ...updated.context, observedSourceDigests: observed,
          observedSourceRevision: Number(updated.context.observedSourceRevision ?? 0) + 1 };
      }
    }
    updated.workspaceModifiedPaths = [...new Set([...updated.workspaceModifiedPaths, ...(result.workspaceChangedPaths ?? [])])];
    for (const artifact of result.artifactRefs ?? []) {
      const previous = updated.artifactRefs.find(item => item.uri === artifact.uri);
      invariant(!previous || canonical(previous) === canonical(artifact), 'artifact_reference_conflict');
      if (!previous) updated.artifactRefs.push(artifact);
    }
  }
  return { pendingIntent: null, pendingTools: snapshot.pendingTools.slice(calls.length), usage: updated.usage,
    ...(updated.toolDiscovery ? { toolDiscovery: updated.toolDiscovery } : {}),
    ...(updated.todos ? { todos: updated.todos } : {}),
    ...(updated.planMode ? { planMode: updated.planMode } : {}),
    ...(updated.childResponseCursors ? { childResponseCursors: updated.childResponseCursors } : {}),
    context: updated.context,
    ...(updated.deliveryArtifacts ? { deliveryArtifacts: updated.deliveryArtifacts } : {}),
    descendantUsage: updated.descendantUsage, messages: updated.messages, artifactRefs: updated.artifactRefs,
    childBudgetReservations: updated.childBudgetReservations, childRunIds: updated.childRunIds,
    diagnostics: updated.diagnostics,
    backgroundCommands: updated.backgroundCommands,
    queuedGuidance: updated.queuedGuidance,
    browserSessionRefs: updated.browserSessionRefs, browserReobservationRefs: updated.browserReobservationRefs,
    lastBrowserObservation: updated.lastBrowserObservation, lastBrowserAttemptToolCall: updated.lastBrowserAttemptToolCall,
    lastWebMutationToolCall: updated.lastWebMutationToolCall, unresolvedInteractionObservation: updated.unresolvedInteractionObservation,
    workspaceDirtySinceCheckpoint: updated.workspaceDirtySinceCheckpoint, lastWorkspaceMutationToolCall: updated.lastWorkspaceMutationToolCall,
    workspaceModifiedPaths: updated.workspaceModifiedPaths, interaction: null, toolErrorStreak: updated.toolErrorStreak,
    ...(toolErrorRecoveryEnabled(config) ? { toolErrorRecovery: updated.toolErrorRecovery ?? null,
      observedProgressRevision: updated.observedProgressRevision ?? 0,
      observedProgressFingerprints: updated.observedProgressFingerprints ?? [] } : {}) };
}
export function settle(snapshot: RunSnapshot, intent: EffectIntent, receipt: EffectReceipt, changes: Partial<RunSnapshot>, elapsedMs: number, facts: { kind: string; payload: ObjectValue }[] = []): CommitBatch {
  invariant(receipt.operationKey === intent.operationKey && snapshot.pendingIntent === intent.operationKey, 'effect_receipt_mismatch');
  return transition(snapshot, { ...changes, activeElapsedMs: snapshot.activeElapsedMs + elapsedMs }, [
    { kind: 'effect.settled', payload: { operationKey: intent.operationKey, kind: intent.kind, status: receipt.status } }, ...facts,
    ...(intent.kind === 'model' && intent.payload.purpose !== 'compaction' && changes.pendingGuidanceIds?.length === 0
      ? (snapshot.pendingGuidanceIds ?? []).map(inputId => ({ kind: 'input.guidance_consumed', payload: {
        inputId, operationKey: intent.operationKey, goalRevision: snapshot.goalRevision } })) : []),
  ], { receipts: [receipt] });
}
