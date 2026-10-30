import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioNativeBackgroundAdmission } from '../src/host/services/native-background-admission.mjs';

test('background completion cannot open a turn during cleanup or after a cut awaiting its first rebased Run', async () => {
  let head = { conversationBranch: { generation: 0 } }, pending = true, reads = 0;
  const marker = { seq: 3, type: 'user/message', data: { source: { kind: 'agentkit-native-conversation-rewind', nativeRewind: {
    contract: 'native-conversation-rewind/v1', sessionId: 'session', commandId: 'cut', expectedHeadRunId: 'run',
    targetMessageId: 'input', generation: 1, seed: {} } } } };
  const session = { id: 'session', snapshotEvents: () => [marker], isOwnSeq: () => true };
  const lifetime = new AbortController(), active = new Set();
  const admit = createStudioNativeBackgroundAdmission({ ctx: {}, store: { sessionHead: () => head,
    load() { reads++; throw Error('past branch fence'); } }, workspaceId: 'workspace', lifetime, active,
    isRewinding: () => pending });
  const request = { agent: { session }, agentId: 'agent', sourceRunId: 'run', taskId: 'a'.repeat(64) };
  await assert.rejects(admit(request), { code: 'studio_native_background_conversation_rewind_pending' }); assert.equal(reads, 0);
  pending = false;
  await assert.rejects(admit(request), { code: 'studio_native_background_conversation_rewind_pending' }); assert.equal(reads, 0);
  head = { conversationBranch: { generation: 1 } };
  await assert.rejects(admit(request), /past branch fence/); assert.equal(reads, 1, 'consumed branch resumes normal authoritative task admission');
  assert.equal(active.size, 0);
});
