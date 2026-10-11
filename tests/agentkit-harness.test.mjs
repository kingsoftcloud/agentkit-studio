import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentKitHarness } from '../src/providers/agentkit-harness.mjs';
import { DSH_SESSION_EVENT_TYPES } from '../packages/agentkit-harness/src/contract.mjs';

test('Studio export is the DSH-backed Harness facade', () => {
  assert.equal(AgentKitHarness.name, 'AgentKitHarnessService');
  assert.ok(DSH_SESSION_EVENT_TYPES.includes('assistant/message'));
  assert.throws(() => new AgentKitHarness({}), /DSH AgentRegistry/);
});
