import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStudioRoutes } from '../src/host/routes/index.mjs';
import { createControlPlaneDispatcher } from '../src/host/routes/dispatcher.mjs';
import { STUDIO_OPERATION_IDS } from '../src/contracts/operations.mjs';
import { createHostRouteFixture, normalizeRouteValue, compactRouteCalls } from './fixtures/host-route-fixture.mjs';

const recording = JSON.parse(await readFile(new URL('./fixtures/host-route-contracts.json', import.meta.url), 'utf8'));
// The legacy server-only tool catalog explicitly selects dsh-native; the new
// harness merged catalog has its own native-tool-catalog.test.mjs assertions.
// Local update recordings additionally require live publication authority.
assert.equal(recording.baselineCommit, 'c6f97fbf36351875967fbb2ce30dc0097a8ebf63');
const legacyIds = [...new Set(recording.cases.map(item => item.endpoint))].sort();
// Native and DSH task controls are new operations with separate product-route
// tests and mounted Host verification; absent from this fixed legacy recording.
assert.deepEqual(legacyIds, [...STUDIO_OPERATION_IDS].filter(id => !/^(templates|platform|teams|team-templates|template-resources|template-workflows)\//.test(id)).filter(id => !['agents/execution-policy', 'agents/execution-policy-set', 'schedules/delivery-targets', 'host/compatibility', 'host/computer', 'assistant/catalog', 'assistant/close', 'assistant/execute', 'assistant/setup-options', 'assistant/setup-start', 'assistant/setup-status', 'sessions/native-resource-retire', 'sessions/native-inject', 'sessions/native-child-tasks', 'sessions/native-child-promote', 'sessions/native-child-history', 'sessions/native-child-result', 'sessions/native-child-file', 'sessions/native-command-output', 'sessions/native-child-send', 'sessions/native-child-cancel', 'sessions/native-recovery-status', 'sessions/native-recovery-resume', 'sessions/native-recovery-reconcile', 'sessions/native-background-review', 'sessions/native-workspace-repair', 'sessions/native-conversation-status', 'sessions/native-conversation-rewind', 'sessions/native-conversation-workspace-preview', 'sessions/native-a2a-control', 'sessions/dsh-a2a-history', 'sessions/dsh-a2a-control'].includes(id)).sort());
for (const item of recording.cases) {
  test(`${item.endpoint}: ${item.mode} retains fixed-ref envelope and adapter calls`, async () => {
    const fixture = createHostRouteFixture(item.mode);
    const owner = new AbortController();
    const routes = createStudioRoutes(fixture.ctx, fixture.deps);
    const dispatch = createControlPlaneDispatcher({ bridge: { signal: owner.signal }, serverClientPromise: fixture.deps.serverClientPromise, routes });
    const payload = item.payload || recording.payload;
    const result = await dispatch(item.endpoint, payload);
    assert.deepEqual(normalizeRouteValue(result), item.result);
    assert.deepEqual(compactRouteCalls(fixture.calls, payload), item.calls);
  });
}
