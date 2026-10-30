import type { ContextPort, EffectIntent, Message, ObjectValue, PortContext, RunConfiguration, RunSnapshot, ToolCall, ToolResult } from './contracts.mjs';
import { copy, canonical, invariant } from './values.mjs';
import { modelToolCatalog, finalizationOnly, modelRoom, plan, reduceTools, settle, objectValue } from './machine.mjs';
import { anthropicTaskFeedback, operatorInputView, projectAnthropicReplay } from './anthropic-context.mjs';
import { planNativeContext } from './context-planning.mjs';
import { browserTaskMessages } from './task-policy.mjs';
import { deliveryTaskMessages, wallDeliveryOnly } from './deadline-delivery.mjs';
import { selectArtifactSearchFeedback } from './artifact-search-feedback.mjs';
import { artifactToolDefinitions } from './artifact-runtime.mjs';
import { sourceWorkingSetGroup } from './source-working-set-group.mjs';
import type { ContextCounters } from './context-planning.mjs';

type Digest = (value: unknown) => string;
type Tokens = NonNullable<ContextPort['tokens']>;
const count = (value: number) => { invariant(Number.isSafeInteger(value) && value > 0, 'artifact_capacity_counter_invalid'); return value; };
function requestCounters(context: PortContext, config: RunConfiguration, tokens: Tokens, future: RunSnapshot, digest: Digest): ContextCounters {
  return {
    countRequest: async (messages, tools, purpose, maxOutputTokens) => {
      context.signal.throwIfAborted();
      return count(await tokens.countRequest({ ...context, profile: { ...config.profile, maxOutputTokens },
        messages: purpose === 'task' ? config.profile.operatorGuidancePolicy === 'journaled-system/v1'
          ? projectAnthropicReplay(operatorInputView(anthropicTaskFeedback(future, config, messages), config.profile, digest), tools, config.profile,
            future.abandonedReplayDigests ?? [], digest).messages
          : deliveryTaskMessages(future, config, browserTaskMessages(future, config, messages)) : messages,
        tools, purpose, maxOutputTokens, maxInlineImageBytes: config.limits.maxInlineImageBytes }));
    }, countText: async text => count(await tokens.countText({ ...context, text })),
    ...(tokens.countMessage ? { countMessage: async (message: Message) => count(await tokens.countMessage!({ ...context,
      profile: config.profile, message: copy(message), purpose: 'task', maxInlineImageBytes: config.limits.maxInlineImageBytes })) } : {}),
  };
}

/** One original immutable page can enter one complete real summary request.
 * This quotes input coverage only; the actual Kernel must still seal the summary output. */
export function quoteSingleArtifactReadAdmission(context: PortContext, snapshot: RunSnapshot, config: RunConfiguration,
  intent: EffectIntent, tokens: Tokens | undefined, digest: Digest): ((result: ToolResult) => Promise<boolean>) | undefined {
  const declaration = [...snapshot.messages].reverse().find(message => message.role === 'assistant' && message.toolCalls?.length);
  const calls = declaration?.toolCalls, call = calls?.[0], installed = config.tools.find(tool => tool.name === 'ArtifactRead');
  if (config.sourceReadPolicy !== 'studio-source-read/v1' || !config.contextPolicy || !tokens?.countMessage
    || tokens.tokenizerId !== config.contextPolicy.tokenizerId || tokens.tokenizerDigest !== config.contextPolicy.tokenizerDigest
    || calls?.length !== 1 || call?.name !== 'ArtifactRead' || snapshot.pendingTools.length !== 1
    || canonical(snapshot.pendingTools) !== canonical(calls) || canonical(intent.payload.calls) !== canonical(calls)
    || canonical(installed) !== canonical(artifactToolDefinitions()[0]) || snapshot.contextState?.compaction) return undefined;
  return async result => {
    try {
      context.signal.throwIfAborted();
      if (result.status !== 'ok' || result.context || !sourceWorkingSetGroup([declaration!, { role: 'tool', name: call.name,
        callId: call.callId, content: canonical(result.content) }], config.tools, snapshot.artifactRefs)?.immutable) return false;
      const future = projectArtifactRequest(snapshot, config, intent, new Map([[call.callId, result]]), digest);
      if (!future) return false;
      const allow = !finalizationOnly(future, config) && !wallDeliveryOnly(future, config);
      const planned = await planNativeContext(future, config, modelToolCatalog(future, config),
        requestCounters(context, config, tokens, future, digest), digest, false, allow);
      if (planned.action === 'ready') return !!planned.admission
        && planned.admission.countedInputTokens + config.profile.maxOutputTokens <= config.profile.contextWindow;
      const compaction = planned.state.compaction, chunk = compaction?.chunk;
      return planned.action === 'compact' && modelRoom(future, config) >= 2 && !!compaction?.hooksComplete && !!chunk
        && compaction.offset === 0 && chunk.start === 0 && chunk.stop === compaction.sourceText.length
        && chunk.maxOutputTokens === config.profile.maxOutputTokens
        && chunk.countedInputTokens + chunk.maxOutputTokens <= config.profile.contextWindow;
    } catch { context.signal.throwIfAborted(); return false; }
  };
}
export interface ArtifactRequestCapacity {
  resultMessageUnits: number;
  groupSize: number;
  countResult(call: ToolCall, result: ToolResult): Promise<number>;
  admits(results: Map<string, ToolResult>): Promise<boolean>;
}

/** Select from actual retained bytes once the parallel segment has returned.
 * Shadow observations are never published; only these real results are committed. */
export async function selectArtifactRequestResults(capacity: ArtifactRequestCapacity, calls: ToolCall[],
  input: ToolResult[], digest: Digest): Promise<ToolResult[]> {
  const selected = [...input];
  const fits = () => capacity.admits(new Map(calls.map((call, index) => [call.callId, selected[index]!])));
  if (await fits()) return input;
  for (let index = selected.length - 1; index >= 0; index--) {
    const original = selected[index]!, call = calls[index]!;
    if (original.status !== 'ok' || !original.content || typeof original.content !== 'object' || Array.isArray(original.content)) continue;
    const replace = (content: ObjectValue, status: ToolResult['status'] = 'ok') => {
      selected[index] = { ...original, status, content, metadata: { ...original.metadata,
        progressObservationDigest: digest(content) } };
      delete selected[index]!.context;
    };
    if (call.name === 'ArtifactSearch') {
      const content = await selectArtifactSearchFeedback(original.content, async value => { replace(value); return fits(); });
      if (content) { replace(content); return selected; }
    } else if (call.name === 'ArtifactRead' && typeof original.content.content === 'string') {
      const text = Array.from(original.content.content);
      for (let size = Math.floor(text.length / 2); size > 0; size = Math.floor(size / 2)) {
        const offset = Number(original.content.offset_chars);
        replace({ ...original.content, content: text.slice(0, size).join(''), returned_chars: size,
          next_offset: offset + size, result_truncated: true });
        if (await fits()) return selected;
      }
    }
    replace({ code: call.name === 'ArtifactRead' ? 'artifact_page_budget_unavailable' : 'artifact_search_capacity_unavailable' }, 'error');
    if (await fits()) return selected;
  }
  // Even an error envelope can exceed a tiny context. The final planner will
  // report that fact; this function does not assert a successful admission.
  return selected;
}

/** Detached ordinary completion only: no commands, I/O, receipts or state writes.
 * Real reducers retain sealed members and generate budget-exhausted suffixes. */
export function projectArtifactRequest(snapshot: RunSnapshot, config: RunConfiguration, original: EffectIntent,
  results: Map<string, ToolResult>, digest: Digest): RunSnapshot | null {
  let current = copy(snapshot), intent: EffectIntent | undefined = original;
  for (let steps = 0; steps < snapshot.pendingTools.length * 4 + 32; steps++) {
    if (intent) {
      if (intent.kind !== 'tool' || current.pendingIntent !== intent.operationKey) return null;
      const calls = intent.payload.calls as unknown as ToolCall[];
      if (!calls?.length || calls.some(call => !['ArtifactRead', 'ArtifactSearch'].includes(call.name))) return null;
      const values = calls.map(call => copy(results.get(call.callId) ?? { status: 'ok', content: { capacity_call: call.callId } } as ToolResult));
      const changes = reduceTools(current, values, calls, intent, config, digest);
      current = settle(current, intent, { operationKey: intent.operationKey, status: 'committed', result: objectValue({ results: values }) }, changes, 0).snapshot;
      intent = undefined;
    }
    const next = plan(current, config, { context: true, workspace: false, verification: false, input: false }, digest);
    if (!next) return null;
    current = next.snapshot;
    if (next.intents.length) {
      if (next.intents.length !== 1) return null;
      const prepared = next.intents[0]!;
      if (prepared.kind === 'context' && !current.pendingTools.length) return current;
      if (prepared.kind !== 'tool') return null;
      intent = prepared;
    } else if (!['executing_tools', 'preparing_context'].includes(current.phase)) return null;
  }
  return null;
}

/** Price the complete next request, preserving actual history and tool controls.
 * The quote assumes no intervening Host changes; the final planner stays authoritative. */
export async function quoteArtifactRequestCapacity(context: PortContext, snapshot: RunSnapshot, config: RunConfiguration,
  intent: EffectIntent, tokens: Tokens | undefined, digest: Digest): Promise<ArtifactRequestCapacity | null> {
  if (config.sourceReadPolicy !== 'studio-source-read/v1' || !config.contextPolicy || !tokens?.countMessage
    || tokens.tokenizerId !== config.contextPolicy.tokenizerId || tokens.tokenizerDigest !== config.contextPolicy.tokenizerDigest) return null;
  const declaration = [...snapshot.messages].reverse().find(message => message.role === 'assistant' && message.toolCalls?.length);
  const calls = declaration?.toolCalls;
  if (!calls?.length || !snapshot.pendingTools.length || calls.some(call => !['ArtifactRead', 'ArtifactSearch'].includes(call.name))) return null;
  const closed = calls.length - snapshot.pendingTools.length, index = snapshot.messages.indexOf(declaration!);
  const sealed = snapshot.messages.slice(index + 1);
  if (closed < 0 || canonical(calls.slice(closed)) !== canonical(snapshot.pendingTools) || sealed.length !== closed
    || sealed.some((message, i) => message.role !== 'tool' || message.callId !== calls[i]!.callId)) return null;
  const messageCount = async (message: Message) => count(await tokens.countMessage!({ ...context, profile: config.profile,
    message: copy(message), purpose: 'task', maxInlineImageBytes: config.limits.maxInlineImageBytes }));
  const project = async (results: Map<string, ToolResult>) => {
    const future = projectArtifactRequest(snapshot, config, intent, results, digest);
    if (!future) return null;
    return planNativeContext(future, config, modelToolCatalog(future, config), requestCounters(context, config, tokens, future, digest), digest, false, false);
  };
  try {
    const projected = await project(new Map());
    if (projected?.action !== 'ready' || !projected.admission) return null;
    const pending = new Set(snapshot.pendingTools.map(call => call.callId));
    const synthetic = projected.messages.filter(message => message.role === 'tool' && message.callId && pending.has(message.callId));
    let syntheticCost = 0, sealedCost = 0;
    for (const message of synthetic) syntheticCost += await messageCount(message);
    for (const message of sealed) sealedCost += await messageCount(message);
    if (synthetic.length !== pending.size || !Number.isSafeInteger(syntheticCost) || !Number.isSafeInteger(sealedCost)) return null;
    const fixed = projected.admission.countedInputTokens - syntheticCost;
    const available = config.profile.contextWindow - config.profile.maxOutputTokens - fixed;
    const units = Math.min(Math.floor(available / pending.size), Math.floor((available + sealedCost) / calls.length));
    if (!Number.isSafeInteger(units) || units <= 0) return null;
    return { resultMessageUnits: units, groupSize: calls.length,
      countResult: (call, result) => messageCount({ role: 'tool', name: call.name, callId: call.callId,
        content: result.context?.content ?? canonical(result.content) }),
      admits: async results => { try { return (await project(results))?.action === 'ready'; } catch { return false; } },
    };
  } catch { context.signal.throwIfAborted(); return null; }
}
