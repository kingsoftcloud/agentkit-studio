import type { Message, ObjectValue, RunConfiguration, RunSnapshot } from './contracts.mjs';
import { CAPTURED_SOURCE_MEDIA_TYPE } from './captured-source.mjs';
import { canonical, copy } from './values.mjs';
import { parseNativeJson } from './model-json.mjs';

const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
/** Index once per planning call. Each selected view chooses its own retained
 * anchor, so pruning or summary selection cannot leave a dangling text-only
 * reference. Immutable receipts and canonical history are never changed.
 */
export function sourceReuseProjector(snapshot: RunSnapshot, config: RunConfiguration, digest: (value: unknown) => string):
  (messages: Message[]) => Message[] {
  if (!config.contextPolicy?.enabled || config.contextPolicy.sourceReusePolicy !== 'captured-source/v1') return messages => messages;
  const definitions = new Map(config.tools.map(tool => [tool.name, tool]));
  const artifacts = new Map(snapshot.artifactRefs.map(ref => [ref.uri, ref]));
  type Entry = { original: string; key: string; ref: string; digest: string; path: string };
  const entries = new Map<string, Entry | null>();
  const calls = new Map(snapshot.messages.flatMap(message => message.toolCalls ?? []).map(call => [call.callId, call]));
  const originals = new Map(snapshot.messages.filter(message => message.role === 'tool' && message.callId).map(message => [message.callId!, message]));
  const inspect = (message: Message): Entry | null => {
    const call = message.callId ? calls.get(message.callId) : undefined, definition = call ? definitions.get(call.name) : undefined;
    if (message.role !== 'tool' || !call || message.name !== call.name || message.toolOutcome !== 'ok'
      || message.persistent || message.media?.length || definition?.contextRetention === 'persistent'
      || definition?.readOnly !== true || definition.contextRole !== 'workspace_read'
      || definition.sourceObservationPolicy !== 'workspace-source-model/v1' || definition.resultArchivePolicy !== 'archived-model-view/v5') return null;
    try {
      const value = parseNativeJson(message.content);
      if (!object(value) || value.status !== 'ok' || value.artifact_state !== 'available' || typeof value.artifact_uri !== 'string'
        || !object(value.content) || value.content.ok !== true || typeof value.content.content !== 'string' || !value.content.content
        || value.content.source_state === 'unread' || typeof value.content.path !== 'string' || value.content.path !== call.arguments.path) return null;
      const ref = artifacts.get(value.artifact_uri);
      if (!ref || ref.mediaType !== CAPTURED_SOURCE_MEDIA_TYPE || ref.metadata?.policy !== 'runtime-artifacts/v1'
        || ref.metadata.toolName !== call.name || !/^sha256:[a-f0-9]{64}$/.test(ref.digest)) return null;
      // Every model-visible field except the separately issued URI must match.
      // This includes line ranges, partial flags and post-policy source text.
      const { artifact_uri: _uri, ...observation } = value;
      return { original: message.content, key: digest({ name: call.name, source: ref.digest, observation }),
        ref: ref.uri, digest: ref.digest, path: value.content.path };
    } catch { return null; }
  };
  return messages => {
    let latestCalls: string[] = [];
    for (const message of messages) if (message.role === 'assistant' && message.toolCalls?.length)
      latestCalls = message.toolCalls.map(call => call.callId);
    const fresh = new Set(latestCalls), anchors = new Map<string, string>();
    return messages.map(message => {
      const original = message.callId ? originals.get(message.callId) : undefined;
      if (!original || message.content !== original.content || message.role !== 'tool' || message.toolOutcome !== 'ok'
        || message.persistent || message.media?.length) return message;
      // Summarized/omitted source bodies are not parsed or hashed again.
      if (!entries.has(message.callId!)) entries.set(message.callId!, inspect(original));
      const entry = entries.get(message.callId!);
      if (!entry || message.content !== entry.original) return message;
      const anchor = anchors.get(entry.key);
      if (!anchor) { anchors.set(entry.key, message.callId!); return message; }
      if (fresh.has(message.callId!)) return message;
      const content = canonical({ type: 'historical_source_reused', status: 'ok', path: entry.path,
        retained_call_id: anchor, artifact_uri: entry.ref, source_digest: entry.digest,
        notice: 'Identical historical source observation is retained in the referenced tool call. The immutable artifact is retained; use only admitted readers. This reference grants no current-file freshness, edit precondition, approval or verification.' });
      if (content.length >= message.content.length) return message;
      const view = { ...copy(message), content }; delete view.presentation; delete view.providerReplay; delete view.replayToolIds;
      return view;
    });
  };
}
