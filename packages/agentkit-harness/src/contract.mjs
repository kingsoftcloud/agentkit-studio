/**
 * The public contract of the AgentKit Harness DSH plugin.
 *
 * Session identity, durable events, persistence and assistant streaming are
 * deliberately named after the DSH contracts. This package does not invent
 * a second event envelope or a second session store.
 */

export const HARNESS_CONTRACT_VERSION = 'agentkit.harness/dsh-plugin/v1';

/** DSH's durable message and lifecycle event names used by the Harness. */
export const DSH_SESSION_EVENT_TYPES = Object.freeze([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'system/message',
  'request/header',
  'request/context',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'approval/asked',
  'approval/decided',
  'agent/inbox/spliced',
  'agent-preset/selected',
]);

/** DSH's process-local assistant stream frame names. */
export const DSH_ASSISTANT_STREAM_FRAME_TYPES = Object.freeze(['start', 'chunk', 'end']);

/** Capabilities owned by DSH services rather than reimplemented by Studio. */
export const HARNESS_RUNTIME_CAPABILITIES = Object.freeze([
  'dsh-session',
  'dsh-session-events',
  'dsh-assistant-stream',
  'dsh-cancel',
  'dsh-resume',
  'dsh-persistence',
]);

export function assertDshHarnessContext(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new TypeError('AgentKit Harness requires a DSH context');
  if (!ctx.agents || typeof ctx.agents.create !== 'function' || typeof ctx.agents.resume !== 'function') {
    throw new TypeError('AgentKit Harness requires the DSH AgentRegistry and AgentLoop plugins');
  }
  if (!ctx.sessions || typeof ctx.sessions.get !== 'function' || typeof ctx.sessions.list !== 'function') {
    throw new TypeError('AgentKit Harness requires the DSH SessionStore plugin');
  }
  return ctx;
}

export function assertDshStreamFrame(frame) {
  if (!frame || typeof frame !== 'object' || !DSH_ASSISTANT_STREAM_FRAME_TYPES.includes(frame.type)) {
    throw new TypeError(`Unsupported DSH assistant stream frame: ${String(frame?.type || '')}`);
  }
  return frame;
}

export function runtimeContract() {
  return Object.freeze({
    version: HARNESS_CONTRACT_VERSION,
    sessionEvents: DSH_SESSION_EVENT_TYPES,
    assistantStreamFrames: DSH_ASSISTANT_STREAM_FRAME_TYPES,
    capabilities: HARNESS_RUNTIME_CAPABILITIES,
    persistenceOwner: 'dsh-session-persistence',
    llmStreamOwner: 'dsh-llm',
  });
}
