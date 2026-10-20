// Private provider replay sealing for the native model adapter.
//
// Ports ksadk.harness.native.model_replay. Private protocol material (chat
// reasoning_content, or Anthropic signed-thinking + tool_use content blocks)
// is bound to the host's pinned profile and echoed only to the same profile on
// the next attempt. It authorizes neither a tool nor a final answer, and never
// enters a public stream event's payload — only ModelResult.providerReplay.
//
// The JS ModelProfile has no digest field, so the binding fingerprint is
// profileId + profileVersion. A replay that does not match the active profile
// is dropped on re-projection (see model-openai-chat / model-anthropic).

const SEALED_KINDS = new Set(['tool_calls', 'final_candidate', 'output_limit']);

export function profileFingerprint(profile) {
  return `${String(profile?.profileId ?? '')}\0${String(profile?.profileVersion ?? '')}`;
}

// Seal chat reasoning_content replay for a reasoning_content profile.
export function sealModelReplay(result, profile, reasoningContent) {
  if (profile?.providerReplayMode !== 'reasoning_content') return result;
  if (!SEALED_KINDS.has(result.kind)) return result;
  return {
    ...result,
    providerReplay: {
      version: 'model-replay/v1',
      profileFingerprint: profileFingerprint(profile),
      reasoningContent: String(reasoningContent || ''),
    },
  };
}

// Seal Anthropic original content blocks (text + signed thinking + tool_use)
// for an anthropic_content profile. The blocks are the provider's original
// content array; the adapter keeps them opaque for round-trip replay.
export function sealAnthropicReplay(result, profile, contentBlocks) {
  if (profile?.providerReplayMode !== 'anthropic_content') return result;
  if (!SEALED_KINDS.has(result.kind)) return result;
  return {
    ...result,
    providerReplay: {
      version: 'model-replay/v2',
      profileFingerprint: profileFingerprint(profile),
      anthropicContent: Array.isArray(contentBlocks) ? contentBlocks : [],
    },
  };
}

// Re-project an assistant message's providerReplay back onto the OpenAI wire:
// reasoning_content is restored so the model sees its prior private reasoning.
export function openAIReplayFields(message) {
  const replay = message?.providerReplay;
  if (!replay || replay.version !== 'model-replay/v1' || !replay.reasoningContent) return {};
  return { reasoning_content: replay.reasoningContent };
}

// Re-project an assistant message's providerReplay back onto the Anthropic
// wire: the original content blocks replace the projected text/tool_use so the
// model sees its signed thinking and tool_use exactly. Returns null when the
// replay is absent or belongs to another profile.
export function anthropicReplayContent(message, profile) {
  const replay = message?.providerReplay;
  if (!replay || replay.version !== 'model-replay/v2') return null;
  if (replay.profileFingerprint !== profileFingerprint(profile)) return null;
  if (!Array.isArray(replay.anthropicContent)) return null;
  return replay.anthropicContent;
}

// Drop a replay that does not match the active profile (cross-profile private
// material never crosses the boundary). Used by OpenAI projection too.
export function replayMatchesProfile(message, profile) {
  const replay = message?.providerReplay;
  if (!replay) return true;
  return replay.profileFingerprint === profileFingerprint(profile);
}
