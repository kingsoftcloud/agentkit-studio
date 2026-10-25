import type { ArtifactRef, Json, Message, ObjectValue, ToolDefinition } from './contracts.mjs';
import { parseNativeJson } from './model-json.mjs';
import { canonical } from './values.mjs';

const object = (value: Json | undefined): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: Json | undefined): value is number | bigint => typeof value === 'bigint' ? value > 0n
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: Json | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Recognize already observed source data under sealed roles. This keeps context;
 * it cannot grant a reference, current-file coverage, or an edit precondition. */
export function sourceWorkingSetGroup(messages: Message[], definitions: ToolDefinition[], artifacts: ArtifactRef[]):
  { identities: string[]; immutable: boolean } | null {
  try {
    const declaration = messages[0], calls = declaration?.toolCalls;
    if (declaration?.role !== 'assistant' || !calls?.length || messages.length !== calls.length + 1
      || new Set(calls.map(call => call.callId)).size !== calls.length) return null;
    const identities = new Set<string>(), byName = new Map(definitions.map(definition => [definition.name, definition]));
    let immutable = true;
    for (const [index, call] of calls.entries()) {
      const message = messages[index + 1]!, definition = byName.get(call.name), args = call.arguments;
      if (message.role !== 'tool' || message.callId !== call.callId || message.name !== call.name || !definition
        || !definition.readOnly && definition.contextRole !== 'task_planning') return null;
      const receipt = parseNativeJson(message.content);
      if (!object(receipt)) return null;
      if (definition.contextRole === 'artifact_read' && call.name === 'ArtifactRead') {
        const ref = artifacts.find(item => item.uri === args.uri), offset = args.offset_chars ?? 0, limit = args.limit_chars ?? 16000;
        if (!ref || receipt.uri !== args.uri || !nonnegative(offset) || !positive(limit) || limit > 32000
          || receipt.offset_chars !== offset || typeof receipt.content !== 'string' || !receipt.content
          || typeof receipt.result_truncated !== 'boolean') return null;
        const size = Array.from(receipt.content).length, end = offset + size;
        if (size > limit || receipt.returned_chars !== size || !Number.isSafeInteger(end)
          || (receipt.next_offset === null ? receipt.result_truncated : receipt.next_offset !== end)) return null;
        identities.add(canonical(['artifact', ref.uri, ref.digest, offset, end]));
        continue;
      }
      immutable = false;
      if (definition.contextRole === 'workspace_search' && call.name === 'ArtifactSearch') {
        const uris = args.uris;
        if (!Array.isArray(uris) || !uris.length || new Set(uris).size !== uris.length
          || uris.some(uri => typeof uri !== 'string' || !artifacts.some(ref => ref.uri === uri))
          || receipt.observation_type !== 'scoped-artifact-search/v1' || typeof args.query !== 'string'
          || receipt.query !== args.query || receipt.complete !== true || receipt.capacity_limited === true
          || !Array.isArray(receipt.results) || receipt.results.length !== uris.length) return null;
        for (const [rowIndex, row] of receipt.results.entries()) {
          if (!object(row) || row.uri !== uris[rowIndex] || row.complete !== true || Object.hasOwn(row, 'code')
            || !['captured_source', 'artifact'].includes(String(row.coordinate_space)) || !Array.isArray(row.matches)
            || row.matches.some(match => !object(match) || !nonnegative(match.offset_chars) || typeof match.excerpt !== 'string'
              || match.excerpt_truncated !== false || match.source_line !== undefined && !positive(match.source_line))) return null;
        }
        identities.add(canonical(['artifact-search', args, uris.map(uri => artifacts.find(ref => ref.uri === uri)!.digest)]));
        continue;
      }
      if (receipt.status !== 'ok') return null;
      if (definition.contextRole === 'task_planning') continue;
      const content = receipt.content;
      if (!object(content) || content.ok !== true) return null;
      if (definition.contextRole === 'workspace_read') {
        if (typeof args.path !== 'string' || !args.path || content.path !== args.path || content.source_state === 'unread'
          || typeof content.content !== 'string' || !content.content) return null;
        const range = content.read_range;
        if (object(range)) {
          if (!positive(range.start) || !positive(range.end) || range.end < range.start) return null;
          identities.add(canonical(['workspace', args.path, range.start, range.end]));
        } else if (range == null) identities.add(canonical(['workspace', args.path, null, null]));
        else return null;
      } else if (definition.contextRole === 'workspace_search') {
        if (typeof args.query !== 'string' || content.query !== args.query || content.searched_path !== (args.path ?? '.')
          || content.truncated !== false || !Array.isArray(content.results) || content.match_count !== content.results.length
          || content.results.some(row => !object(row) || typeof row.path !== 'string' || !row.path || !positive(row.line)
            || typeof row.text !== 'string')) return null;
        identities.add(canonical(['search', args]));
      } else return null;
    }
    return identities.size ? { identities: [...identities], immutable } : null;
  } catch { return null; }
}
