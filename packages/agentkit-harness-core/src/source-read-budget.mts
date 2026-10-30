import type { ContextPort, Message, ModelRequest, RunConfiguration, RunSnapshot, SourceReadBudget, SourceReadQuote, ToolCall } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { contextSummaryMessage } from './context-planning.mjs';
import { CAPTURED_SOURCE_MEDIA_TYPE } from './captured-source.mjs';

export const SOURCE_READ_POLICY = 'studio-source-read/v1' as const;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const checked = (value: number) => { invariant(positive(value), 'source_read_counter_invalid'); return value; };
const signed = (value: number) => { invariant(Number.isSafeInteger(value), 'source_read_counter_invalid'); return value; };
const declared = (snapshot: RunSnapshot) => [...snapshot.messages].reverse().find(message => message.role === 'assistant' && message.toolCalls?.length);
function readers(message: Message, config: Pick<RunConfiguration, 'tools'>): ToolCall[] {
  return (message.toolCalls ?? []).filter(call => config.tools.some(tool => tool.name === call.name && tool.readOnly
    && (tool.contextRole === 'workspace_read' || tool.name === 'ArtifactRead' && tool.contextRole === 'artifact_read')));
}

/** Measure after the response, before its receipt commit. Failure cannot relabel a
 * known model response as a retryable model error or cause a second generation. */
export async function prepareSourceReadQuote(before: RunSnapshot, after: RunSnapshot, config: RunConfiguration,
  request: ModelRequest, tokens: ContextPort['tokens'], digest: (value: unknown) => string): Promise<SourceReadQuote | null> {
  if (config.sourceReadPolicy !== SOURCE_READ_POLICY || after.phase !== 'executing_tools') return null;
  const assistant = declared(after); if (!assistant) return null;
  const calls = readers(assistant, config); if (!calls.length) return null;
  const policy = config.contextPolicy!;
  const quote: SourceReadQuote = { policy: SOURCE_READ_POLICY, status: 'unavailable', reason: 'source_read_budget_unavailable',
    configDigest: before.configDigest, goalRevision: before.goalRevision, batchDigest: digest(assistant),
    tokenizerId: policy.tokenizerId, tokenizerDigest: policy.tokenizerDigest, readerCallIds: calls.map(call => call.callId),
    countedInputTokens: 0, fixedUnits: 0, mandatoryUnits: 0, prospectiveRefUnits: 0, summaryUnits: 0,
    availableUnits: 0, maxSourceUnits: 0, maxResultUnits: 0 };
  try {
    invariant(tokens?.countMessage && tokens.tokenizerId === policy.tokenizerId
      && tokens.tokenizerDigest === policy.tokenizerDigest, 'source_read_counter_unavailable');
    const countMessage = async (message: Message) => checked(await tokens.countMessage!({ ...request,
      purpose: request.purpose === 'delivery_review' ? 'delivery_review' : 'task', message: copy(message) }));
    const countText = async (text: string) => checked(await tokens.countText({ ...request, text }));
    quote.countedInputTokens = checked(await tokens.countRequest({ ...request, purpose: request.purpose ?? 'task',
      maxOutputTokens: request.profile.maxOutputTokens }));
    let messageUnits = 0;
    for (const message of request.messages) messageUnits = checked(messageUnits + await countMessage(message));
    quote.fixedUnits = checked(quote.countedInputTokens - messageUnits);
    const feedback = new Set((before.hookState?.feedback ?? []).map(canonical));
    const guidance = new Set(before.pendingGuidanceIds ?? []);
    let mandatory = quote.fixedUnits;
    for (const message of request.messages) if (message.role === 'system' || message.persistent
      || message.role === 'user' && (!message.kind || message.content === before.goal || message.kind === 'context_source')
      || message.kind === 'guidance' && message.inputId !== undefined && guidance.has(message.inputId)
      || feedback.has(canonical(message))) mandatory = checked(mandatory + await countMessage(message));
    if (!request.messages.some(message => message.role === 'user' && message.content === before.goal))
      mandatory = checked(mandatory + await countMessage({ role: 'user', content: before.goal }));
    mandatory = checked(mandatory + await countMessage(assistant));
    quote.mandatoryUnits = mandatory;
    const producers = calls.filter(call => call.name !== 'ArtifactRead');
    if (producers.length) quote.prospectiveRefUnits = await countText(canonical({ artifact_refs: producers.map(() => ({
      uri: 'artifact://' + 'a'.repeat(245), digest: 'sha256:' + 'a'.repeat(64), mediaType: CAPTURED_SOURCE_MEDIA_TYPE,
      sizeBytes: Number.MAX_SAFE_INTEGER,
    })) }));
    const allWorkspace = calls.every(call => config.tools.find(tool => tool.name === call.name)?.contextRole === 'workspace_read');
    if (!allWorkspace) quote.summaryUnits = checked(Math.min(policy.summaryMaxTokens, config.profile.maxOutputTokens)
      + await countMessage(contextSummaryMessage('')));
    quote.availableUnits = signed(config.profile.contextWindow - config.profile.maxOutputTokens - mandatory - quote.prospectiveRefUnits);
    quote.maxSourceUnits = checked(Math.floor(quote.availableUnits / 2 / calls.length));
    let framing = 0;
    for (const call of calls) framing = Math.max(framing, await countMessage({ role: 'tool', callId: call.callId, name: call.name, content: '' }));
    quote.maxResultUnits = checked(Math.floor((quote.availableUnits - quote.summaryUnits) / calls.length) - framing);
    quote.status = 'ready'; quote.reason = null;
  } catch { /* Capacity failure never discards the already known model response. */ }
  return quote;
}

/** Derive the same immutable allowance after dispatch splits, Hooks or a cold restart.
 * Current-intent/fence authority is checked separately by the invoking Host. */
export function sourceReadBudgetFor(snapshot: RunSnapshot, config: RunConfiguration, call: ToolCall,
  digest: (value: unknown) => string): SourceReadBudget | undefined {
  if (config.sourceReadPolicy !== SOURCE_READ_POLICY) return undefined;
  return sourceReadBudgetForState(snapshot, config, declared(snapshot), call, digest);
}

/** The dispatch guard uses the same quote validator without loading transcript
 * history. The declaration witness comes from an atomic current-authority read. */
export function sourceReadBudgetForState(snapshot: Pick<RunSnapshot, 'sourceReadQuote' | 'configDigest' | 'goalRevision'>,
  config: Pick<RunConfiguration, 'sourceReadPolicy' | 'tools' | 'contextPolicy' | 'limits'>,
  assistant: Message | null | undefined, call: ToolCall, digest: (value: unknown) => string): SourceReadBudget | undefined {
  if (config.sourceReadPolicy !== SOURCE_READ_POLICY) return undefined;
  const definition = config.tools.find(tool => tool.name === call.name);
  if (!definition?.sourceObservationPolicy && call.name !== 'ArtifactRead') return undefined;
  const quote = snapshot.sourceReadQuote, policy = config.contextPolicy;
  if (!quote || quote.status !== 'ready' || quote.policy !== SOURCE_READ_POLICY || !policy || !assistant
    || quote.configDigest !== snapshot.configDigest || quote.goalRevision !== snapshot.goalRevision
    || quote.batchDigest !== digest(assistant) || quote.tokenizerId !== policy.tokenizerId || quote.tokenizerDigest !== policy.tokenizerDigest
    || canonical(quote.readerCallIds) !== canonical(readers(assistant, config).map(item => item.callId))
    || !quote.readerCallIds.includes(call.callId) || !positive(quote.maxSourceUnits) || !positive(quote.maxResultUnits)) return undefined;
  return { policy: 'agentkit.source-page-budget/v1', quoteDigest: digest(quote), counterId: quote.tokenizerId,
    tokenizerDigest: quote.tokenizerDigest, sourceGroupSize: quote.readerCallIds.length, maxSourceUnits: quote.maxSourceUnits,
    maxResultUnits: quote.maxResultUnits, maxResultBytes: config.limits.maxToolResultBytes };
}
