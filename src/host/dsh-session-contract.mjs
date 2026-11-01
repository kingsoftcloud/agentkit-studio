/** DSH event vocabulary consumed by Studio Host projections. */
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
