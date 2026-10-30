// Private provider replay sealing for the native model adapter.
//
// Ports ksadk.harness.native.model_replay. Private protocol material (chat
// reasoning_content, or Anthropic signed-thinking + tool_use content blocks)
// is bound to the host's pinned profile and echoed only to the same profile on
// the next attempt. It authorizes neither a tool nor a final answer, and never
// enters a public stream event's payload — only ModelResult.providerReplay.
//
// The binding fingerprint is profileId + profileVersion + compatibilityDigest.
// The sealed replay also carries compatibilityDigest explicitly: the kernel's
// boundReplay checks `result.providerReplay.compatibilityDigest ===
// config.profile.compatibilityDigest` and rejects a mismatch, so a replay that
// does not prove its profile lineage cannot authorize history. On input
// re-projection the adapter re-checks the full fingerprint so cross-profile
// private material is dropped, never leaked onto another model's wire.

import { createHash } from 'node:crypto';
import { canonical, modelWireToolCall } from '@kingsoftcloud/agentkit-harness-core';
import { ProtocolError } from './model-normalize.mjs';

const SEALED_KINDS = new Set(['tool_calls', 'final_candidate', 'output_limit']);

export function profileFingerprint(profile) {
  return `${String(profile?.profileId ?? '')}\0${String(profile?.profileVersion ?? '')}\0${String(profile?.compatibilityDigest ?? '')}`;
}

// Seal chat reasoning_content replay. The replay carries compatibilityDigest
// for the kernel's boundReplay check and the fingerprint for input re-projection.
export function sealModelReplay(result, profile, reasoningContent) {
  if (profile?.providerReplayMode !== 'reasoning_content') return result;
  if (!SEALED_KINDS.has(result.kind)) return result;
  return {
    ...result,
    providerReplay: {
      version: 'model-replay/v1',
      profileFingerprint: profileFingerprint(profile),
      compatibilityDigest: String(profile.compatibilityDigest ?? ''),
      reasoningContent: String(reasoningContent || ''),
    },
    usageReported: result.usageReported,
  };
}

// Seal Anthropic original content blocks (text + signed thinking + tool_use
// with original provider ids) for anthropic_content replay. The blocks keep
// the provider's original tool_use ids; the kernel later adds replayToolIds to
// the ModelResult if it remaps colliding ids, and the adapter applies that map
// on input re-projection.
export function sealAnthropicReplay(result, profile, contentBlocks) {
  if (profile?.providerReplayMode !== 'anthropic_content') return result;
  if (!SEALED_KINDS.has(result.kind)) return result;
  return {
    ...result,
    providerReplay: {
      version: 'model-replay/v2',
      profileFingerprint: profileFingerprint(profile),
      compatibilityDigest: String(profile.compatibilityDigest ?? ''),
      anthropicContent: Array.isArray(contentBlocks) ? contentBlocks : [],
    },
    usageReported: result.usageReported,
  };
}

// Re-project an assistant message's providerReplay onto the OpenAI chat wire.
// The replay must belong to the current profile (full fingerprint match) or it
// is dropped — cross-profile private reasoning never leaks onto another wire.
// Returns { reasoning_content } to merge into the assistant message, or {}.
export function openAIReplayFields(message, profile) {
  if (profile?.providerReplayMode !== 'reasoning_content') return {};
  const replay = message?.providerReplay;
  if (!replay || replay.version !== 'model-replay/v1') return {};
  if (replay.profileFingerprint !== profileFingerprint(profile)) return {};
  if (!replay.reasoningContent) return {};
  return { reasoning_content: replay.reasoningContent };
}

// Re-project an assistant message's anthropic_content replay onto the Anthropic
// Messages wire. The replay must belong to the current profile; its tool_use
// ids are mapped through message.replayToolIds (original -> canonical) without
// touching the signature or private thinking text. The mapped tool_use blocks
// must pair exactly with the message's sealed toolCalls (id/name/arguments) and
// the text blocks must reconstruct message.content — otherwise the replay is
// inconsistent and dropped (never allowed to inject extra tools or replace a
// sealed call). The original providerReplay object is never mutated.
export function anthropicReplayContent(message, profile) {
  if (profile?.providerReplayMode !== 'anthropic_content') return null;
  const replay = message?.providerReplay;
  if (!replay || replay.version !== 'model-replay/v2') return null;
  if (replay.profileFingerprint !== profileFingerprint(profile)) return null;
  if (!Array.isArray(replay.anthropicContent)) return null;
  const idMap = message.replayToolIds || {};
  let blocks = structuredClone(replay.anthropicContent).map((block) => {
    if (block && block.type === 'tool_use') {
      const mappedId = Object.prototype.hasOwnProperty.call(idMap, block.id) ? idMap[block.id] : block.id;
      return { ...block, id: mappedId };
    }
    return block == null ? block : { ...block };
  });
  if (!validateReplayPairing(blocks, message)) return null;
  const view = message.providerReplayProjection;
  if (view) {
    const contentDigest = createHash('sha256').update(canonical(replay.anthropicContent)).digest('hex');
    if (profile.providerReplayProjectionPolicy !== 'anthropic-client-compaction/v1'
      || view.version !== 'anthropic-client-compaction/v1' || view.profileDigest !== profile.compatibilityDigest
      || view.originalContentDigest !== contentDigest || !/^[0-9a-f]{64}$/.test(view.prefixDigest))
      throw new ProtocolError('anthropic_replay_projection_mismatch');
    blocks = blocks.filter(block => !['thinking', 'redacted_thinking'].includes(block?.type));
  }
  return blocks;
}

// Validate that the replay blocks pair exactly with the sealed message facts:
// text blocks reconstruct message.content, and tool_use blocks (in order)
// match message.toolCalls by callId/name/arguments. A mismatch means the replay
// is not a faithful original of this sealed turn; drop it rather than let it
// inject or replace tool facts.
function validateReplayPairing(blocks, message) {
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  if (text !== (message.content || '')) return false;
  const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
  const calls = message.toolCalls || [];
  if (toolUses.length !== calls.length) return false;
  for (let i = 0; i < toolUses.length; i++) {
    const tu = toolUses[i];
    const call = calls[i] && modelWireToolCall(calls[i]);
    if (!tu || !call) return false;
    if (tu.id !== call.callId) return false;
    if (tu.name !== call.name) return false;
    if (!jsonEqual(tu.input, call.arguments)) return false;
  }
  return true;
}

function jsonEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
  return ka.every((k) => jsonEqual(a[k], b[k]));
}

// True when the message carries a replay that belongs to the given profile.
export function replayMatchesProfile(message, profile) {
  const replay = message?.providerReplay;
  if (!replay) return true;
  return replay.profileFingerprint === profileFingerprint(profile);
}
