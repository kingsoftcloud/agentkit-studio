import type { Json, Message, ObjectValue, ToolDefinition } from './contracts.mjs';
import { canonical, copy } from './values.mjs';
import { parseNativeJson } from './model-json.mjs';

const object = (value: Json | undefined): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
function failedObservation(content: string): boolean {
  try {
    const receipt = parseNativeJson(content);
    return object(receipt) && (receipt.ok === false || object(receipt.content) && receipt.content.ok === false);
  } catch { return false; }
}

/** Disposable request projection. Original transcript and durable receipts stay intact. */
export function projectOldToolResults(messages: Message[], refs: string[], groups: number[][], tools: ToolDefinition[],
  protectedIndexes: ReadonlySet<number>, keepRecent: number, digest: (value: unknown) => string):
  { messages: Message[]; clearedIndexes: number[]; clearedCallIds: string[] } {
  const projected = copy(messages), protectedSet = new Set(protectedIndexes);
  const definitions = new Map(tools.map(tool => [tool.name, tool]));
  const batches = groups.filter(group => messages[group[0]!]!.toolCalls?.length);
  for (const group of batches.slice(-keepRecent)) for (const index of group) protectedSet.add(index);
  const clearedIndexes: number[] = [], clearedCallIds: string[] = [];
  for (const group of batches) {
    if (group.some(index => protectedSet.has(index))) continue;
    const calls = new Map(messages[group[0]!]!.toolCalls!.map(call => [call.callId, call]));
    for (const index of group.slice(1)) {
      const message = messages[index]!, call = message.callId ? calls.get(message.callId) : undefined;
      const definition = call ? definitions.get(call.name) : undefined;
      if (message.role !== 'tool' || !call || message.name !== call.name || !definition || message.toolOutcome !== 'ok'
        || message.persistent || message.media?.length || definition.contextRetention === 'persistent'
        || definition.contextRole === 'task_planning' || definition.observationRole === 'browser'
        || definition.delegatedReadOnly || failedObservation(message.content)) continue;
      const edited = projected[index]!;
      edited.content = canonical({ type: 'historical_tool_result_cleared', source_message_ref: refs[index]!, payload_digest: digest(message.content) });
      delete edited.providerReplay; delete edited.replayToolIds; delete edited.presentation;
      clearedIndexes.push(index); clearedCallIds.push(call.callId);
    }
  }
  return { messages: projected, clearedIndexes, clearedCallIds };
}
