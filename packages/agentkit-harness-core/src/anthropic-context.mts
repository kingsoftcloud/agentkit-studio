import type { Message, ModelProfile, ModelResult, ObjectValue, RunConfiguration, RunSnapshot, ToolDefinition } from './contracts.mjs';
import { canonical, copy, invariant } from './values.mjs';
import { contextSourceDigest, modelContextMessages } from './context-view.mjs';
import { deliveryTaskMessages } from './deadline-delivery.mjs';

type Digest = (value: unknown) => string;
const JOURNAL = 'host_request_guidance';
const POLICY = 'anthropic-client-compaction/v1';
const fingerprint = (p: ModelProfile): string => `${p.profileId}\0${p.profileVersion}\0${p.compatibilityDigest}`;
const thinking = (b: unknown): boolean => !!b && typeof b === 'object'
  && ['thinking', 'redacted_thinking'].includes(String((b as ObjectValue).type));
function replayBlocks(message: Message, profile: ModelProfile): ObjectValue[] | null {
  const replay = message.providerReplay;
  return message.role === 'assistant' && replay?.version === 'model-replay/v2'
    && replay.profileFingerprint === fingerprint(profile) && Array.isArray(replay.anthropicContent)
    ? replay.anthropicContent as ObjectValue[] : null;
}

/** Append current controls once per turn, before context counting and intent creation. */
export function stageOperatorGuidance(snapshot: RunSnapshot, config: RunConfiguration, tools: ToolDefinition[],
  controls: Message[], finalization: boolean, digest: Digest): Message[] | null {
  if (config.profile.operatorGuidancePolicy !== 'journaled-system/v1') return null;
  const content = canonical({ policy: 'journaled-system/v1', admittedTools: tools.map(tool => tool.name),
    finalizationOnly: finalization, controls: controls.map(message => message.content),
    instruction: 'Host execution state only. Tool catalog entries do not grant permission. Use only admitted tools; '
      + (finalization ? 'finish the task without further workspace actions.' : 'follow the current task and actual execution budget.') });
  const key = digest({ runId: snapshot.runId, goalRevision: snapshot.goalRevision,
    modelCall: snapshot.usage.modelCalls, profile: config.profile.compatibilityDigest, content });
  const latest = [...snapshot.messages].reverse().find(message => message.kind === JOURNAL);
  if (latest?.operatorGuidance?.key === key) return null;
  const messages = copy(snapshot.messages);
  if (!messages.length || messages.at(-1)?.role === 'assistant') messages.push({ role: 'user',
    kind: 'host_request_boundary', content: 'Host execution state update.' });
  messages.push({ role: 'system', kind: JOURNAL, content,
    operatorGuidance: { key, profileDigest: config.profile.compatibilityDigest, contentDigest: digest(content) } });
  return messages;
}

/** Bind only the unanswered journal tail to a real admitted input, never to model prose. */
export function bindOperatorInput(messages: Message[], input: Message, profile: ModelProfile): Message {
  if (profile.operatorGuidancePolicy !== 'journaled-system/v1') return input;
  const frames: { key: string; contentDigest: string }[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'system' || message.kind !== JOURNAL) break;
    if (message.operatorGuidance) frames.unshift({ key: message.operatorGuidance.key, contentDigest: message.operatorGuidance.contentDigest });
  }
  return frames.length ? { ...input, operatorInputHistory: { profileDigest: profile.compatibilityDigest, frames } } : input;
}

export function operatorInputView(messages: Message[], profile: ModelProfile, digest: Digest): Message[] {
  const bound = new Map<string, string>();
  for (const input of messages) if (input.operatorInputHistory) {
    invariant(input.role === 'user' && ['guidance', 'steering'].includes(input.kind ?? '')
      && input.operatorInputHistory.profileDigest === profile.compatibilityDigest, 'operator_input_history_mismatch');
    for (const frame of input.operatorInputHistory.frames) bound.set(frame.key, frame.contentDigest);
  }
  return messages.map((source, index) => {
    if (source.kind !== JOURNAL) return copy(source);
    const frame = source.operatorGuidance;
    invariant(source.role === 'system' && frame && frame.profileDigest === profile.compatibilityDigest
      && frame.contentDigest === digest(source.content), 'operator_guidance_mismatch');
    const following = messages.slice(index + 1).find(message => message.role !== 'system');
    const displaced = !['user', 'tool', 'system'].includes(messages[index - 1]?.role ?? '')
      || following !== undefined && following.role !== 'assistant';
    if (!bound.has(frame.key) && !displaced) return copy(source);
    if (bound.has(frame.key)) invariant(bound.get(frame.key) === frame.contentDigest, 'operator_input_history_mismatch');
    return { role: 'user', kind: 'historical_operator_guidance', content: canonical({
      type: 'historical_operator_guidance', authority: 'historical_data_only', content: source.content }) };
  });
}

/** Normalize aliases to provider ids and omit private thinking when binding the input root. */
function prefixPart(message: Message, profile: ModelProfile, ids: Map<string, string>): ObjectValue {
  const blocks = replayBlocks(message, profile);
  if (blocks) {
    for (const block of blocks) if (block.type === 'tool_use' && typeof block.id === 'string')
      ids.set(message.replayToolIds?.[block.id] ?? block.id, block.id);
    return { role: 'assistant', content: copy(blocks.filter(block => !thinking(block))) };
  }
  return { role: message.role, content: message.content,
    ...(message.media?.length ? { media: copy(message.media) } : {}),
    ...(message.role === 'tool' ? { callId: ids.get(message.callId ?? '') ?? message.callId ?? '' } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls.map(call => ({ callId: call.callId, name: call.name, arguments: copy(call.arguments) })) } : {}) };
}
function prefixDigest(messages: Message[], profile: ModelProfile, digest: Digest): string {
  const ids = new Map<string, string>();
  return digest(messages.map(message => prefixPart(message, profile, ids)));
}
function headerDigest(messages: Message[], tools: ToolDefinition[], digest: Digest): string {
  const first = messages.findIndex(message => message.role !== 'system');
  return digest({ instructions: messages.slice(0, first < 0 ? messages.length : first).map(message => message.content),
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) });
}
export function bindAnthropicReplayInput(result: ModelResult, messages: Message[], tools: ToolDefinition[],
  profile: ModelProfile, digest: Digest): ModelResult {
  if (profile.providerReplayProjectionPolicy !== POLICY || result.providerReplay?.version !== 'model-replay/v2'
    || result.providerReplay.profileFingerprint !== fingerprint(profile)) return result;
  return { ...result, providerReplay: { ...copy(result.providerReplay), inputContext: {
    version: 'native-anthropic-input-prefix/v2', messagesDigest: prefixDigest(messages, profile, digest),
    headerDigest: headerDigest(messages, tools, digest) } } };
}

/** A disposable view; source replay and tool receipts remain byte-for-byte intact. */
export function projectAnthropicReplay(messages: Message[], tools: ToolDefinition[], profile: ModelProfile,
  abandoned: string[], digest: Digest): { messages: Message[]; abandoned: string[] } {
  if (profile.providerReplayProjectionPolicy !== POLICY) return { messages: copy(messages), abandoned: [] };
  const discarded = new Set(abandoned), prefix: ObjectValue[] = [], ids = new Map<string, string>();
  const header = headerDigest(messages, tools, digest);
  const output = messages.map(source => {
    const message = copy(source), blocks = replayBlocks(source, profile), replay = source.providerReplay;
    if (blocks?.some(thinking) && replay) {
      const key = digest(replay), context = replay.inputContext as ObjectValue | undefined;
      // A record without an input root cannot establish unchanged signed context.
      if (discarded.has(key) || !context || context.version !== 'native-anthropic-input-prefix/v2'
        || context.messagesDigest !== digest(prefix) || context.headerDigest !== header || source.providerReplayProjection) {
        discarded.add(key);
        message.providerReplayProjection = { version: POLICY, profileDigest: profile.compatibilityDigest,
          originalContentDigest: digest(blocks), prefixDigest: digest(prefix) };
      }
    }
    prefix.push(prefixPart(message, profile, ids));
    return message;
  });
  return { messages: output, abandoned: [...discarded].sort() };
}

/** Persist the exact replay view before a model attempt can be claimed. */
export function captureAnthropicContext(snapshot: RunSnapshot, config: RunConfiguration,
  tools: ToolDefinition[], digest: Digest): Partial<RunSnapshot> {
  if (config.profile.providerReplayProjectionPolicy !== POLICY) return {};
  const messages = operatorInputView(anthropicTaskFeedback(snapshot, config, modelContextMessages(snapshot, digest)), config.profile, digest);
  const projected = projectAnthropicReplay(messages, tools, config.profile, snapshot.abandonedReplayDigests ?? [], digest);
  return { preparedContext: { ...snapshot.preparedContext, messages: projected.messages,
    sourceDigest: contextSourceDigest(snapshot, digest) }, abandonedReplayDigests: projected.abandoned };
}

/** Keep delivery receipt projection, while its system control is already journaled. */
export function anthropicTaskFeedback(snapshot: RunSnapshot, config: RunConfiguration, messages: Message[]): Message[] {
  return deliveryTaskMessages(snapshot, config, copy(messages)).slice(0, messages.length);
}
