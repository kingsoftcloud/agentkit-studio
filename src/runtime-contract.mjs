/** Studio's small routing contract; transcript ownership stays with each runtime. */
import { DSH_ASSISTANT_STREAM_FRAME_TYPES, DSH_SESSION_EVENT_TYPES } from './host/dsh-session-contract.mjs';
import { NATIVE_DSH_TURN_CONTRACT } from '@kingsoftcloud/agentkit-harness-node/native/dsh-turn-contract';
import { STUDIO_RUNTIME_TYPES, isRoutableRuntimeType } from './runtime-types.mjs';

/**
 * The runtime registry, re-exported as part of the public contract.
 *
 * The sets and predicates themselves live in `./runtime-types.mjs` because the
 * browser bundle may not depend on `src/host/` (this file reads the session
 * event vocabulary from there). Everything a Host or a caller needs is exported
 * from here; `src/client/theme.mjs` imports the dependency-free module directly.
 */
export {
  STUDIO_RUNTIME_TYPES,
  STUDIO_PORTABLE_RUNTIME_TYPES,
  isPortableRuntimeType,
  STUDIO_EXPERIMENTAL_RUNTIME_TYPES,
  STUDIO_ROUTABLE_RUNTIME_TYPES,
  STUDIO_MANAGED_RUNTIME_TYPES,
  STUDIO_TEAM_RUNTIME_TYPES,
  STUDIO_PROCESS_RUNTIME_TYPES,
  STUDIO_NATIVE_TURN_RUNTIME_TYPES,
  STUDIO_INVOCATION_CONTEXT_RUNTIME_TYPES,
  STUDIO_RUNTIME_SETS,
  isStudioRuntimeType,
  isRoutableRuntimeType,
  isManagedRuntimeType,
  isTeamRuntimeType,
  isProcessRuntimeType,
  isNativeTurnRuntimeType,
  isInvocationContextRuntimeType,
} from './runtime-types.mjs';

export const STUDIO_RUNTIME_CONTRACT_VERSION = 'agentkit.studio.runtime/v1';
export const STUDIO_CANONICAL_IDENTIFIERS = Object.freeze(['agentId', 'revision', 'buildId', 'sessionId', 'runId']);
export const STUDIO_ENTITY_CONTRACT = Object.freeze({
  Agent: Object.freeze({ id: 'agentId', revision: 'revision' }),
  Revision: Object.freeze({ id: 'revision', parent: 'agentId' }),
  Build: Object.freeze({ id: 'buildId', agent: 'agentId', revision: 'revision' }),
  Session: Object.freeze({ id: 'sessionId', build: 'buildId', agent: 'agentId', revision: 'revision' }),
  Run: Object.freeze({ id: 'runId', session: 'sessionId', build: 'buildId', agent: 'agentId', revision: 'revision' }),
});
export const STUDIO_RUNTIME_CAPABILITY_MATRIX = Object.freeze({
  'dsh-native': Object.freeze({
    owner: 'dsh', execution: 'native', contract: STUDIO_RUNTIME_CONTRACT_VERSION,
    capabilities: Object.freeze(['session', 'session-events', 'stream', 'cancel', 'replay', 'persistence', 'build-binding']),
    eventOwner: 'dsh-session', streamOwner: 'dsh-agent/assistant-stream',
  }),
  harness: Object.freeze({
    owner: 'ksadk-harness', execution: 'native-kernel', contract: NATIVE_DSH_TURN_CONTRACT,
    capabilities: Object.freeze(['native-run', 'durable-receipts', 'tool-approval', 'cancel', 'resume', 'child-tasks']),
    eventOwner: 'native-run-store', streamOwner: 'native-model-port',
  }),
  ksxc: Object.freeze({
    owner: 'studio', execution: 'ksxc-app-server', contract: 'studio.ksxc.adapter/v1',
    capabilities: Object.freeze(['session', 'stream', 'cancel', 'replay', 'build-binding']),
    eventOwner: 'studio-ksxc-adapter', streamOwner: 'ksxc-turn/item',
  }),
  codex: Object.freeze({
    owner: 'studio', execution: 'codex-app-server', contract: 'studio.codex.adapter/v1',
    capabilities: Object.freeze(['session', 'stream', 'cancel', 'replay', 'build-binding']),
    eventOwner: 'studio-codex-adapter', streamOwner: 'codex-turn/item',
  }),
});

/** Reject a runtime type the Host cannot route.
 *
 * Accepts the experimental engine as well as the public set: the value is
 * routable locally even though the Agent form does not offer it. Callers that
 * need the narrower public rule use `isStudioRuntimeType` directly. */
export function assertStudioRuntimeType(runtimeType) {
  const value = String(runtimeType || '').trim();
  if (!isRoutableRuntimeType(value)) throw Object.assign(new Error(`Unsupported Studio runtime: ${value || '(empty)'}`), { code: 'RUNTIME_UNSUPPORTED' });
  return value;
}

export function studioRunIdentity(value = {}) {
  const identity = Object.fromEntries(STUDIO_CANONICAL_IDENTIFIERS.map(key => [key, String(value[key] || '').trim()]));
  if (!identity.agentId || !identity.sessionId || !identity.runId) {
    throw Object.assign(new Error('Studio run identity requires agentId, sessionId and runId'), { code: 'RUN_IDENTITY_INVALID' });
  }
  if (!/^\d+$/.test(String(value.revision ?? '')) || Number(value.revision) < 1) {
    throw Object.assign(new Error('Studio run identity requires a positive revision'), { code: 'RUN_IDENTITY_INVALID' });
  }
  if (!identity.buildId) throw Object.assign(new Error('Studio run identity requires buildId'), { code: 'RUN_IDENTITY_INVALID' });
  return Object.freeze({ ...identity, revision: Number(value.revision) });
}

export function assertStudioRunBinding(value = {}, expected = {}) {
  const identity = studioRunIdentity(value);
  for (const key of ['agentId', 'sessionId']) {
    const expectedValue = String(expected[key] || '').trim();
    if (expectedValue && identity[key] !== expectedValue) {
      throw Object.assign(new Error(`Studio run identity ${key} does not match bound route`), { code: 'RUN_IDENTITY_MISMATCH' });
    }
  }
  return identity;
}

export function studioRuntimeContract() {
  return Object.freeze({
    version: STUDIO_RUNTIME_CONTRACT_VERSION,
    runtimes: STUDIO_RUNTIME_TYPES,
    identifiers: STUDIO_CANONICAL_IDENTIFIERS,
    entities: STUDIO_ENTITY_CONTRACT,
    dshSessionEvents: DSH_SESSION_EVENT_TYPES,
    dshAssistantStreamFrames: DSH_ASSISTANT_STREAM_FRAME_TYPES,
    matrix: STUDIO_RUNTIME_CAPABILITY_MATRIX,
  });
}
