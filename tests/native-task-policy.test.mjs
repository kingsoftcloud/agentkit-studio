import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNativeTaskPolicy } from '../src/providers/native-task-policy.mjs';
import { studioBrowserDefinition } from '../packages/agentkit-harness/src/native/browser-workspace-protocol.mjs';
import { browserTaskTools, webObservationDue } from '../packages/agentkit-harness-core/dist/index.mjs';
import { fixture, tool } from '../packages/agentkit-harness-core/test/fixtures.mjs';

test('Studio explicitly pins source suffixes and activates only the owned browser tool', () => {
  const definition = studioBrowserDefinition(), policy = bindNativeTaskPolicy({ tools: [definition] });
  assert.equal(policy.limits.verificationIdleToolCalls, 4);
  assert.deepEqual(policy.workspaceObservationPolicy.pathSuffixes, ['.html', '.htm', '.js', '.jsx', '.css', '.ts', '.tsx']);
  policy.workspaceObservationPolicy.pathSuffixes.pop();
  assert.equal(bindNativeTaskPolicy({ tools: [definition] }).workspaceObservationPolicy.pathSuffixes.at(-1), '.tsx');
  for (const tools of [[], [{ ...definition, observationRole: 'none' }], [{ ...definition, name: 'external_browser' }]]) {
    const inactive = bindNativeTaskPolicy({ tools });
    assert.equal(inactive.workspaceObservationPolicy, null);
    assert.equal(inactive.limits.verificationReserveModelCalls, 0);
    assert.equal(inactive.limits.browserObservationIntervalToolCalls, 0);
    assert.equal(inactive.limits.verificationIdleToolCalls, 0);
  }
});
test('Build-pinned Native call counts keep null unbounded and zero tools disabled', () => {
  for (const [maxModelCalls, expected] of [[null, 6], [1, 1], [8, 1], [20, 4], [40, 6]]) {
    const policy = bindNativeTaskPolicy({ tools: [studioBrowserDefinition()], nativeLimits: { maxModelCalls, maxToolCalls: 0 } });
    assert.equal(policy.limits.maxModelCalls, maxModelCalls); assert.equal(policy.limits.maxToolCalls, 0);
    assert.equal(policy.limits.verificationReserveModelCalls, expected);
    assert.equal(policy.limits.maxOutputRestarts, maxModelCalls === null || maxModelCalls >= 20 ? 1 : 0);
  }
  for (const nativeLimits of [null, [], true, { maxModelCalls: 0 }, { maxModelCalls: '8' }, { maxModelCalls: 1.5 },
    { maxToolCalls: -1 }, { maxToolCalls: false }, { verificationReserveModelCalls: 0 }, { maxModelCalls: Infinity }]) {
    assert.throws(() => bindNativeTaskPolicy({ tools: [], nativeLimits }), /studio_native_execution_limits_invalid/);
  }
});
test('the bound Studio profile actually restricts core tools when web observation is due', () => {
  const browser = studioBrowserDefinition(), write = tool({ name: 'write', readOnly: false, concurrentSafe: false });
  const binding = bindNativeTaskPolicy({ tools: [browser, write] });
  const { config, snapshot: state } = fixture({ tools: [browser, write], ...binding });
  const due = { ...state, lastWebMutationToolCall: 1, usage: { ...state.usage, toolCalls: 13 } };
  assert.equal(webObservationDue(due, config), true);
  assert.deepEqual(browserTaskTools(due, config, config.tools).map(tool => tool.name), [browser.name]);
});
