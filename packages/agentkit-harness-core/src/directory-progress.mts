import type { EffectIntent, Json, ObjectValue, RunSnapshot, ToolCall, ToolDefinition, ToolResult } from './contracts.mjs';
import { canonical, copy, runKey } from './values.mjs';
import { parseNativeJson } from './model-json.mjs';

function path(value: Json | undefined): string | null {
  if (typeof value !== 'string' || !value || Array.from(value).length > 2048 || value.startsWith('/')
    || value.includes('\\') || value.includes('\0')) return null;
  const parts = value.split('/').filter(part => part && part !== '.');
  return parts.includes('..') ? null : parts.join('/') || '.';
}
const record = (value: Json | undefined): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Json | undefined): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Derive names only from actual committed, locked read-only listings; prose and summaries have no entry point. */
export function advanceDirectoryProgress(snapshot: RunSnapshot, call: ToolCall, result: ToolResult,
  definition: ToolDefinition | undefined, intent: EffectIntent): ObjectValue | null {
  if (!definition?.directoryObservationPolicy || !definition.readOnly || definition.contextRole !== 'workspace_list'
    || result.status !== 'ok' || intent.kind !== 'tool'
    || !intent.operationKey.startsWith(runKey(snapshot.scope, snapshot.runId) + ':effect:')) return null;
  const requested = path(call.arguments.path ?? '.'); if (requested === null) return null;
  let source: Json = result.content;
  // A Host projection preserves its authorized full view separately; private raw Host facts cannot supply names.
  if (result.context) {
    if (!result.archiveContext) return null;
    try { source = parseNativeJson(result.archiveContext.content); } catch { return null; }
  }
  if (!record(source) || source.ok !== true || path(source.path) !== requested || typeof source.truncated !== 'boolean'
    || !Array.isArray(source.entries)) return null;
  const children: string[] = [];
  for (const entry of source.entries) {
    if (!record(entry) || entry.type !== 'file' && entry.type !== 'directory') return null;
    const child = path(entry.path);
    if (child === null || child === requested || child === '.' || requested !== '.' && !child.startsWith(requested + '/')) return null;
    const parts: string[] = child.split('/');
    const parent: string = parts.slice(0, -1).join('/') || '.';
    if (entry.type === 'directory' && parent === requested) children.push(parts.at(-1)!);
  }
  const previous = snapshot.context.directoryProgress;
  const entries = record(previous) && previous.goalRevision === snapshot.goalRevision && Array.isArray(previous.entries)
    ? previous.entries.filter(record).map(copy) : [];
  const old = entries.find(entry => entry.path === requested);
  const item: ObjectValue = { path: requested,
    receipt_refs: [...new Set([...strings(old?.receipt_refs), intent.operationKey])],
    tool_call_ids: [...new Set([...strings(old?.tool_call_ids), call.callId])],
    child_directories: [...new Set([...strings(old?.child_directories), ...children])],
    latest_result_truncated: source.truncated };
  return { goalRevision: snapshot.goalRevision, entries: [...entries.filter(entry => entry.path !== requested), item] };
}

/** Full navigation remains durable; the model quote is bounded and makes no freshness/completeness claim. */
export function directoryProgressQuote(snapshot: RunSnapshot, maximumBytes = 4096): ObjectValue | null {
  const state = snapshot.context.directoryProgress;
  if (!record(state) || state.goalRevision !== snapshot.goalRevision || !Array.isArray(state.entries)) return null;
  const originals = state.entries, entries: ObjectValue[] = [];
  const build = (): ObjectValue => ({ entries, omitted_paths: originals.length - entries.length,
    scope: 'Historically returned directory names only; no current existence, freshness or complete coverage is asserted.' });
  if (new TextEncoder().encode(canonical(build())).byteLength > maximumBytes) return null;
  for (const original of [...originals].reverse()) {
    if (!record(original)) continue;
    const names = strings(original.child_directories), shown: string[] = [];
    const item: ObjectValue = { path: original.path ?? '.', child_directories: shown, omitted_child_directories: names.length,
      receipt_refs: strings(original.receipt_refs).slice(-1), tool_call_ids: strings(original.tool_call_ids).slice(-1),
      latest_result_truncated: original.latest_result_truncated ?? true };
    entries.push(item);
    if (new TextEncoder().encode(canonical(build())).byteLength > maximumBytes) { entries.pop(); break; }
    for (const name of names) {
      shown.push(name); item.omitted_child_directories = names.length - shown.length;
      if (new TextEncoder().encode(canonical(build())).byteLength > maximumBytes) {
        shown.pop(); item.omitted_child_directories = names.length - shown.length; break;
      }
    }
  }
  return build();
}
