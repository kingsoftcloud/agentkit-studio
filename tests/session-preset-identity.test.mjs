import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dshPresetId } from '../src/agent-preset-admission.mjs';
import { agentFromSessionPreset as resolve } from '../src/client/state/conversation-agent.mjs';
test('Agent identity follows the durable preset after workspace cancellation and reload', () => {
  const agents = [{ metadata: { id: 'blind-b' } }, { id: '测试/Agent' }];
  assert.equal(resolve(dshPresetId('blind-b', 3, 'frozen-build'), agents), 'blind-b');
  assert.equal(resolve(dshPresetId('测试/Agent', 2), agents), '测试/Agent');
  assert.equal(resolve('standard', agents), null);
  assert.equal(resolve(undefined, agents), null);
});
