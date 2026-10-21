// Pure Native local-memory configuration helper for the Studio Agent form.
//
// The browser bundle (scripts/build-client.mjs) forbids imports from
// src/host, src/providers and packages/agentkit-harness, so this module is
// deliberately dependency-free: it only mirrors the policy defaults documented
// in src/providers/native-memory.mjs (studioNativeMemoryPolicy) and
// docs/native-memory.md, and shapes the form state <-> Agent spec mapping.
//
// Semantics summary (see docs/native-memory.md):
//   providerRef 'local-default'  -> Harness-local SQLite memory. Recall and the
//     PreCompact flush hook only act on this provider, and recall further
//     requires runtime.type === 'harness'. No cloud memory-instance binding.
//   providerRef 'binding://platform-memory-instance' -> cloud memory via AICP;
//     the local recall/flush hooks skip it. Requires a memory-instance binding.
//   recall.enabled is INDEPENDENT of memory.enabled (policy default true). The
//     form must not equate them on save.
//   write.mode: 'off' | 'explicit_only' | 'candidate'. 'off' is only meaningful
//     for the local provider; the template authoring service still rejects it,
//     so the form only offers it on the local path (harness, blank/edit).
//   context.rollout.memoryWrite: 'off' | 'shadow' | 'enabled', default 'shadow'.
//     'shadow' only evaluates candidate decisions and never writes. 'enabled'
//     is the only value that actually persists candidates.
//   flushAfterTurn is carried in the policy binding but its consumer is not yet
//     implemented; the UI must not claim after-turn auto-save works.

export const MEMORY_PROVIDER_LOCAL = 'local-default';
export const MEMORY_PROVIDER_CLOUD = 'binding://platform-memory-instance';

export const MEMORY_SCOPES_DEFAULT = Object.freeze(['workspace', 'agent', 'user']);
export const MEMORY_RECALL_DEFAULTS = Object.freeze({ enabled: true, maxTokens: 1600, topK: 8, minScore: 0.45 });
export const MEMORY_WRITE_DEFAULTS = Object.freeze({ mode: 'candidate', flushBeforeCompaction: true, flushAfterTurn: true });
export const MEMORY_ROLLOUT_DEFAULT = 'shadow';

export const MEMORY_WRITE_MODES = Object.freeze(['off', 'explicit_only', 'candidate']);
export const MEMORY_ROLLOUTS = Object.freeze(['off', 'shadow', 'enabled']);

const isMemoryInstanceBinding = binding => binding?.config?.binding?.resource?.kind === 'memory-instance';

/** Which memory sources the form may offer. The local provider is Harness-only
 *  and the template authoring service rejects enabled-without-cloud-binding,
 *  so local-default is only offered for a harness Agent that is not a cloud
 *  edit and not a template seed. Cloud memory-instance binding stays available
 *  for every non-cloudEditing authoring path. */
export function memorySourceContext({ runtime, cloudEditing, creationSeed } = {}) {
  const canLocal = runtime === 'harness' && !cloudEditing && !creationSeed;
  const canCloud = !cloudEditing;
  return { canLocal, canCloud };
}

/** Read an Agent spec into form state, backfilling every Native memory field
 *  from the original spec so editing/template-seed preserves prior choices. */
export function readAgentMemoryConfig({ spec = {}, runtime, cloudEditing, creationSeed, editing = false } = {}) {
  const memory = spec.memory || {};
  const recall = memory.recall || {};
  const write = memory.write || {};
  const rollout = spec.context?.rollout?.memoryWrite;
  const bindings = spec.bindings || {};
  const memoryInstanceBound = (bindings.plugins || []).some(isMemoryInstanceBinding);
  // The stored source is the user's choice (defaulting to local, the policy's
  // default providerRef); the form gates it by runtime via effectiveMemorySource
  // so switching a blank Agent from dsh-native to harness lands on local memory
  // without forcing a cloud binding.
  const source = memory.providerRef === MEMORY_PROVIDER_CLOUD || memoryInstanceBound
    ? 'cloud'
    : 'local';
  return {
    enabled: Boolean(memory.enabled),
    source,
    providerRef: memory.providerRef || MEMORY_PROVIDER_LOCAL,
    scopes: Array.isArray(memory.scopes) ? [...memory.scopes] : [...MEMORY_SCOPES_DEFAULT],
    recallEnabled: recall.enabled ?? MEMORY_RECALL_DEFAULTS.enabled,
    recallMaxTokens: recall.maxTokens ?? MEMORY_RECALL_DEFAULTS.maxTokens,
    recallTopK: recall.topK ?? MEMORY_RECALL_DEFAULTS.topK,
    recallMinScore: recall.minScore ?? MEMORY_RECALL_DEFAULTS.minScore,
    writeMode: write.mode || (editing ? MEMORY_WRITE_DEFAULTS.mode : 'explicit_only'),
    writeFlushBeforeCompaction: write.flushBeforeCompaction ?? MEMORY_WRITE_DEFAULTS.flushBeforeCompaction,
    writeFlushAfterTurn: write.flushAfterTurn ?? MEMORY_WRITE_DEFAULTS.flushAfterTurn,
    rollout: rollout || MEMORY_ROLLOUT_DEFAULT,
    memoryInstanceBound,
  };
}

/** Whether enabling memory forces a cloud memory-instance binding on this path.
 *  Local-default (harness, blank/edit) needs no binding; every other enabled
 *  path requires one, matching the template authoring service. */
export function memoryRequiresCloudBinding({ state, ctx, memoryInstanceBound }) {
  if (!state?.enabled) return false;
  if (ctx.canLocal && state.source !== 'cloud') return false;
  return true;
}

/** Clamp a numeric field to its policy range so the form never emits an invalid
 *  spec. Returns the fallback when the input is not a finite number. */
export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
export function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Validate the editable numeric/enum fields against studioNativeMemoryPolicy. */
export function validateAgentMemoryConfig(state) {
  const errors = [];
  if (!Number.isSafeInteger(state.recallMaxTokens) || state.recallMaxTokens < 0)
    errors.push({ field: 'recallMaxTokens', message: '召回最大 token 数需为不小于 0 的整数。' });
  if (!Number.isSafeInteger(state.recallTopK) || state.recallTopK < 1 || state.recallTopK > 64)
    errors.push({ field: 'recallTopK', message: '召回条数需为 1–64 之间的整数。' });
  if (!Number.isFinite(state.recallMinScore) || state.recallMinScore < 0 || state.recallMinScore > 1)
    errors.push({ field: 'recallMinScore', message: '最低相似度需为 0–1 之间的数值。' });
  if (!MEMORY_WRITE_MODES.includes(state.writeMode))
    errors.push({ field: 'writeMode', message: '记忆写入方式无效。' });
  if (!MEMORY_ROLLOUTS.includes(state.rollout))
    errors.push({ field: 'rollout', message: '记忆写入开关无效。' });
  return { ok: errors.length === 0, errors };
}

/** Build the memory spec block + context rollout + filtered platform plugins
 *  for saving. Preserves every original field the user did not change, keeps
 *  recall.enabled independent of memory.enabled, routes providerRef by source,
 *  and writes context.rollout.memoryWrite only on the local path (cloud keeps
 *  its original rollout untouched, matching prior behavior). */
export function writeAgentMemoryConfig({ state, originalSpec = {}, platformBindings = [], runtime, cloudEditing, creationSeed }) {
  const ctx = memorySourceContext({ runtime, cloudEditing, creationSeed });
  const memoryInstanceBound = (platformBindings || []).some(isMemoryInstanceBinding);
  const useLocal = state.enabled && ctx.canLocal && state.source !== 'cloud';
  const providerRef = state.enabled && state.source === 'cloud' && memoryInstanceBound
    ? MEMORY_PROVIDER_CLOUD
    : MEMORY_PROVIDER_LOCAL;
  const originalMemory = originalSpec.memory || {};
  const originalRecall = originalMemory.recall || {};
  const originalWrite = originalMemory.write || {};
  const memory = {
    ...originalMemory,
    providerRef,
    enabled: state.enabled,
    scopes: Array.isArray(originalMemory.scopes) && originalMemory.scopes.length ? originalMemory.scopes : [...MEMORY_SCOPES_DEFAULT],
  };
  if (useLocal) {
    memory.recall = {
      ...originalRecall,
      enabled: Boolean(state.recallEnabled),
      maxTokens: clampInt(state.recallMaxTokens, 0, Number.MAX_SAFE_INTEGER, MEMORY_RECALL_DEFAULTS.maxTokens),
      topK: clampInt(state.recallTopK, 1, 64, MEMORY_RECALL_DEFAULTS.topK),
      minScore: clampFloat(state.recallMinScore, 0, 1, MEMORY_RECALL_DEFAULTS.minScore),
    };
    memory.write = {
      ...originalWrite,
      mode: state.writeMode,
      flushBeforeCompaction: Boolean(state.writeFlushBeforeCompaction),
      flushAfterTurn: Boolean(state.writeFlushAfterTurn),
    };
  } else {
    // Cloud / non-local path preserves the original recall/write shape; only the
    // enabled flag, providerRef, independent recall.enabled and write.mode move
    // with the form. rollout stays whatever the original spec carried.
    memory.recall = { ...originalRecall, enabled: Boolean(state.recallEnabled) };
    memory.write = { ...originalWrite, mode: state.writeMode };
  }
  // A local-default Agent must not carry a dangling memory-instance binding;
  // cloud keeps every platform binding as-is.
  const plugins = useLocal
    ? (platformBindings || []).filter(binding => !isMemoryInstanceBinding(binding))
    : (platformBindings || []);
  const rollout = useLocal ? state.rollout : (originalSpec.context?.rollout?.memoryWrite ?? MEMORY_ROLLOUT_DEFAULT);
  return { memory, rollout, plugins, useLocal, providerRef, memoryInstanceBound };
}
