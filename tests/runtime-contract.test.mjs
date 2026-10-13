import test from 'node:test';
import assert from 'node:assert/strict';
import { DSH_ASSISTANT_STREAM_FRAME_TYPES, DSH_SESSION_EVENT_TYPES, HARNESS_CONTRACT_VERSION } from '../packages/agentkit-harness/src/contract.mjs';
import { STUDIO_CANONICAL_IDENTIFIERS, STUDIO_ENTITY_CONTRACT, STUDIO_RUNTIME_CAPABILITY_MATRIX, STUDIO_RUNTIME_TYPES, assertStudioRunBinding, studioRunIdentity, studioRuntimeContract } from '../src/runtime-contract.mjs';

test('P0-0 freezes the three runtime names and shared identity fields', () => {
  assert.deepEqual(STUDIO_RUNTIME_TYPES, ['dsh-native', 'harness', 'codex']);
  assert.deepEqual(STUDIO_CANONICAL_IDENTIFIERS, ['agentId', 'revision', 'buildId', 'sessionId', 'runId']);
  assert.equal(STUDIO_ENTITY_CONTRACT.Run.build, 'buildId');
  assert.equal(STUDIO_RUNTIME_CAPABILITY_MATRIX.harness.contract, HARNESS_CONTRACT_VERSION);
  assert.equal(STUDIO_RUNTIME_CAPABILITY_MATRIX.harness.eventOwner, 'dsh-session');
  assert.equal(STUDIO_RUNTIME_CAPABILITY_MATRIX.harness.streamOwner, 'dsh-agent/assistant-stream');
});

test('P0-0 rejects a run that cannot be tied to a frozen Build and Session', () => {
  assert.deepEqual(studioRunIdentity({ agentId: 'a', revision: 2, buildId: 'b', sessionId: 's', runId: 'r' }), {
    agentId: 'a', revision: 2, buildId: 'b', sessionId: 's', runId: 'r',
  });
  assert.throws(() => studioRunIdentity({ agentId: 'a', revision: 2, sessionId: 's', runId: 'r' }), { code: 'RUN_IDENTITY_INVALID' });
});

test('P0-0 rejects a run whose route agent or session does not match', () => {
  const identity = { agentId: 'agent-a', revision: 2, buildId: 'build-a', sessionId: 'session-a', runId: 'run-a' };
  assert.deepEqual(assertStudioRunBinding(identity, { agentId: 'agent-a', sessionId: 'session-a' }), { ...identity });
  assert.throws(() => assertStudioRunBinding(identity, { agentId: 'agent-b', sessionId: 'session-a' }), { code: 'RUN_IDENTITY_MISMATCH' });
  assert.throws(() => assertStudioRunBinding(identity, { agentId: 'agent-a', sessionId: 'session-b' }), { code: 'RUN_IDENTITY_MISMATCH' });
  assert.throws(() => assertStudioRunBinding({ ...identity, revision: 0 }, { agentId: 'agent-a' }), { code: 'RUN_IDENTITY_INVALID' });
});

test('P0-0 exposes DSH stream/event vocabularies rather than a Studio envelope', () => {
  const contract = studioRuntimeContract();
  assert.deepEqual(contract.dshSessionEvents, DSH_SESSION_EVENT_TYPES);
  assert.deepEqual(contract.dshAssistantStreamFrames, DSH_ASSISTANT_STREAM_FRAME_TYPES);
  assert.equal(Object.hasOwn(contract, 'studioEventTypes'), false);
});
