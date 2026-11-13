import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeEngineApprovalReply, requestNativeHostApproval } from '../src/providers/native-host-approval.mjs';

test('a live session switch to never is not mislabeled as the user rejecting the tool', async () => {
  let override;
  const agent = { session: {} };
  const request = { toolName: 'native/browser_inspect_workspace', callId: 'browser-1' };
  const service = {
    config: { policy: 'ask' },
    overrideOf: session => { assert.equal(session, agent.session); return override; },
    request: async input => { assert.deepEqual(input, { ...request, agent }); return 'rejected'; },
  };
  assert.deepEqual(nativeEngineApprovalReply(await requestNativeHostApproval(service, agent, request), true),
    { decision: 'deny', denialReason: 'approval_rejected' });
  override = 'never';
  assert.deepEqual(nativeEngineApprovalReply(await requestNativeHostApproval(service, agent, request), true),
    { decision: 'deny', denialReason: 'approval_prompts_disabled' });
});

test('a missing responder or cancelled turn cannot create an approval', async () => {
  assert.deepEqual(nativeEngineApprovalReply(await requestNativeHostApproval(null, {}, {}), true),
    { decision: 'deny', denialReason: 'approval_unavailable' });
  const service = { request: () => assert.fail('do not ask after cancellation') };
  assert.deepEqual(nativeEngineApprovalReply(await requestNativeHostApproval(service, {}, { signal: AbortSignal.abort() }), true),
    { decision: 'deny', denialReason: 'approval_cancelled' });
  assert.equal(nativeEngineApprovalReply('allowed-once', true), 'allow');
});
