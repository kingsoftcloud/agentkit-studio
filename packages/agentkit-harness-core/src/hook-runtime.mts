import type { CommitBatch, EffectIntent, HookDefinition, HookEvent, HookInvocation, HookInvocationResult, HookState,
  Message, ObjectValue, RunConfiguration, RunSnapshot, ToolCall, ToolResult } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { hookIdentity, hookMatches, validateHookResult } from './hook-contract.mjs';
import { prepareEffect } from './transitions.mjs';
import { toolInputRejection } from './tool-input.mjs';

export function currentHookState(snapshot: RunSnapshot): HookState {
  return snapshot.hookState?.goalRevision === snapshot.goalRevision ? copy(snapshot.hookState)
    : { goalRevision: snapshot.goalRevision, pre: [], post: [], stop: null, feedback: [] };
}
function validCall(config: RunConfiguration, call: ToolCall): boolean {
  const definition = config.tools.find(tool => tool.name === call.name);
  return !!definition && (config.contract.allowedToolNames === null || config.contract.allowedToolNames.includes(call.name))
    && !toolInputRejection(definition, call);
}
function matching(config: RunConfiguration, event: HookEvent, call?: ToolCall): HookDefinition[] {
  return config.hooks.filter(hook => hookMatches(hook, event, call?.name));
}
function compactionSubject(snapshot: RunSnapshot, definition: HookDefinition): ObjectValue {
  const subject = copy(snapshot.contextState!.compaction!.hookSubject);
  if (definition.compactionSourceProjection === 'canonical_user') {
    const messages = subject.messages as unknown as Message[], refs = subject.messageRefs as string[];
    const indexes = messages.flatMap((message, index) => message.role === 'user'
      && (message.kind === undefined || message.kind === 'user_input') ? [index] : []);
    subject.messages = indexes.map(index => messages[index]!) as unknown as ObjectValue[];
    subject.messageRefs = indexes.map(index => refs[index]!);
    subject.sourceProjection = 'canonical_user';
  }
  return subject;
}
function callState(state: HookState, call: ToolCall): HookState['pre'][number] {
  let record = state.pre.find(item => item.original.callId === call.callId);
  if (!record) { record = { original: copy(call), effective: copy(call), nextIndex: 0, denied: false }; state.pre.push(record); }
  invariant(canonical(record.effective) === canonical(call), 'hook_effective_call_mismatch');
  return record;
}
/** All hooks are sealed external effects; no callback receives the live snapshot. */
export function planHook(snapshot: RunSnapshot, config: RunConfiguration, event: HookEvent,
  digest: (value: unknown) => string, calls: ToolCall[] = []): CommitBatch | null {
  const state = currentHookState(snapshot);
  let hook: HookDefinition | undefined, call: ToolCall | null = null, result: ToolResult | null = null;
  if (event === 'PostToolUse') {
    const post = state.post[0];
    if (!post) return null;
    call = post.call; result = post.result; hook = matching(config, event, call)[post.nextIndex];
    invariant(hook, 'post_hook_cursor_mismatch');
  } else if (event === 'PreToolUse') {
    for (const pending of calls) {
      if (!validCall(config, pending)) continue;
      const record = callState(state, pending);
      if (record.denied) continue;
      hook = matching(config, event, pending)[record.nextIndex];
      if (hook) { call = pending; break; }
    }
    if (!hook) return null;
  } else if (event === 'Stop') {
    if (!snapshot.candidate) return null;
    if (state.stop?.candidateId !== snapshot.candidate.candidateId) state.stop = { candidateId: snapshot.candidate.candidateId, nextIndex: 0 };
    hook = matching(config, event)[state.stop.nextIndex];
    if (!hook) return null;
  } else {
    const compaction = snapshot.contextState?.compaction;
    if (!compaction || compaction.hooksComplete) return null;
    const subjectDigest = digest(compaction.hookSubject);
    if (state.precompact?.subjectDigest !== subjectDigest) state.precompact = { subjectDigest, nextIndex: 0 };
    hook = matching(config, event)[state.precompact.nextIndex];
    invariant(hook, 'precompact_hook_cursor_mismatch');
  }
  const input: HookInvocation['input'] = { goal: snapshot.goal, toolCallCount: snapshot.usage.toolCalls,
    stopContinuationCount: snapshot.stopHookContinuations, call, toolResult: result,
    candidate: event === 'Stop' ? snapshot.candidate : null, compaction: null };
  if (event === 'PreCompact') {
    input.compaction = compactionSubject(snapshot, hook!);
  }
  const batch = prepareEffect(snapshot, 'hook', snapshot.phase, {}, { hookState: state });
  const request: HookInvocation = { ...hookIdentity(snapshot), schemaVersion: 'agentkit.native-hook/v1',
    operationKey: batch.snapshot.pendingIntent!, goalRevision: snapshot.goalRevision, event, definition: copy(hook!), input,
    inputDigest: digest({ definition: hook, input }) };
  batch.intents[0]!.payload = { request: request as unknown as ObjectValue };
  return batch;
}
function close(snapshot: RunSnapshot, state: HookState, outcome: 'blocked' | 'unverified', reason: string): Partial<RunSnapshot> {
  return { pendingIntent: null, phase: 'finalizing', outcome, reason, candidate: null, verification: null, preparedContext: null,
    hookState: state, pendingTools: [], pendingInteraction: null, interaction: null,
    messages: [...snapshot.messages, ...snapshot.pendingTools.map(call => ({ role: 'tool' as const, name: call.name, callId: call.callId,
      content: canonical({ status: 'not_dispatched', reason, executed: false }) }))] };
}
export function deniedByHook(snapshot: RunSnapshot, call: ToolCall): boolean {
  return currentHookState(snapshot).pre.some(item => item.original.callId === call.callId && item.denied);
}
export function stagePostHooks(snapshot: RunSnapshot, changes: Partial<RunSnapshot>, config: RunConfiguration,
  calls: ToolCall[], results: ToolResult[]): Partial<RunSnapshot> {
  const updated = { ...snapshot, ...changes };
  if (updated.phase !== 'executing_tools' || !config.hooks.some(hook => hook.events.includes('PostToolUse'))) return changes;
  const state = currentHookState(updated);
  for (const [index, call] of calls.entries()) {
    const result = results[index]!;
    if (['ok', 'error'].includes(result.status) && !deniedByHook(snapshot, call) && validCall(config, call)
      && matching(config, 'PostToolUse', call).length) state.post.push({ call: copy(call), result: copy(result), nextIndex: 0 });
  }
  return { ...changes, hookState: state };
}
export function pendingHookFeedback(snapshot: RunSnapshot, messages = snapshot.messages): Message[] {
  const state = currentHookState(snapshot);
  if (snapshot.pendingTools.length || state.post.length) return [];
  const seen = new Set(messages.map(canonical));
  return state.feedback.filter(message => !seen.has(canonical(message)));
}
export function assertHookFeedbackRetained(snapshot: RunSnapshot, messages: Message[]): void {
  invariant(pendingHookFeedback(snapshot, messages).length === 0, 'context_hook_feedback_missing');
}
export function reduceHook(snapshot: RunSnapshot, intent: EffectIntent, input: HookInvocationResult,
  config: RunConfiguration): Partial<RunSnapshot> {
  const request = intent.payload.request as unknown as HookInvocation;
  const result = validateHookResult(request, input), state = currentHookState(snapshot);
  invariant(request.operationKey === intent.operationKey && request.goalRevision === snapshot.goalRevision, 'hook_subject_mismatch');
  if (result.status === 'uncertain' || result.reason === 'binding_unavailable') return close(snapshot, state, 'unverified', 'effect_outcome_unknown');
  if (result.status === 'failed') {
    const optional = ['producer_failed', 'producer_invalid', 'producer_timeout', 'input_budget_exceeded', 'output_budget_exceeded'].includes(result.reason!);
    if (!optional || request.definition.failureMode !== 'warn') return close(snapshot, state, 'blocked', `hook_${result.reason}`);
  }
  let changes: Partial<RunSnapshot> = { pendingIntent: null, hookState: state };
  const output = result.output;
  if (request.event === 'PreToolUse') {
    invariant(request.input.call, 'hook_call_missing');
    const record = callState(state, request.input.call);
    record.nextIndex++;
    if (output?.action === 'deny') record.denied = true;
    if (output?.updatedArguments !== null && output?.updatedArguments !== undefined) {
      record.effective = { ...record.effective, arguments: copy(output.updatedArguments) };
      changes.pendingTools = snapshot.pendingTools.map(call => call.callId === record.effective.callId ? record.effective : call);
      changes.interaction = null; changes.pendingInteraction = null;
    }
  } else if (request.event === 'PostToolUse') {
    const pending = state.post[0];
    invariant(pending && canonical(pending.call) === canonical(request.input.call)
      && canonical(pending.result) === canonical(request.input.toolResult), 'post_hook_subject_mismatch');
    pending.nextIndex++;
    if (pending.nextIndex >= matching(config, request.event, pending.call).length) state.post.shift();
    if (output?.action === 'deny') return close(snapshot, state, 'blocked', 'post_tool_hook_denied');
  } else if (request.event === 'Stop') {
    invariant(state.stop && state.stop.candidateId === snapshot.candidate?.candidateId
      && canonical(request.input.candidate) === canonical(snapshot.candidate), 'stop_hook_subject_mismatch');
    state.stop.nextIndex++;
    if (output?.action === 'deny') return close(snapshot, state, 'blocked', 'stop_hook_denied');
  } else {
    const contextState = copy(snapshot.contextState), compaction = contextState?.compaction;
    invariant(compaction && state.precompact, 'precompact_hook_subject_missing');
    invariant(canonical(request.input.compaction) === canonical(compactionSubject(snapshot, request.definition)), 'precompact_hook_subject_changed');
    if (output?.action === 'deny') return close(snapshot, state, 'blocked', 'precompact_hook_denied');
    state.precompact.nextIndex++;
    compaction.hooksComplete = state.precompact.nextIndex >= matching(config, request.event).length;
    compaction.chunk = null;
    changes.contextState = contextState;
  }
  if (output && (output.additionalContext.length || output.updatedArguments !== null)) {
    const feedback: Message = { role: 'user', kind: 'hook_context', content: canonical({
      event: request.event, hookId: request.definition.hookId, sourceRef: request.definition.sourceRef,
      bindingDigest: request.definition.bindingDigest, operationKey: request.operationKey, trustLevel: 'untrusted',
      action: output.action, data: output.additionalContext, ...(request.input.call ? { callId: request.input.call.callId } : {}),
      ...(output.updatedArguments === null ? {} : { effectiveArguments: output.updatedArguments }),
    }) };
    state.feedback.push(feedback);
    if (request.event === 'Stop' || request.event === 'PreCompact') changes.messages = [...snapshot.messages, feedback];
  }
  if (output && !request.definition.readOnly) changes.context = { ...snapshot.context, workspaceCursor: null, terminalWorkspaceCursor: null };
  if (output?.action === 'repair') {
    if (snapshot.stopHookContinuations >= config.stopHookContinuationLimit) return close({ ...snapshot, ...changes }, state, 'blocked', 'stop_hook_continuation_exhausted');
    changes = { ...changes, phase: 'preparing_context', candidate: null, verification: null, preparedContext: null,
      finalText: '', outcome: null, reason: null, continuations: 0, stopHookContinuations: snapshot.stopHookContinuations + 1 };
    state.stop = null;
  }
  return changes;
}
