import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeKernel, MemoryRunStore, emptyUsage } from '@kingsoftcloud/agentkit-harness-core';
import { nativeChildToolDefinitions, childCapabilityDirectory, admitChildCapabilities } from '../src/native/child-tools.mjs';
import { createNativeChildren, nativeChildRoles } from '../src/native/children.mjs';
import { workspaceToolDefinitions } from '../src/native/workspace-tools.mjs';
import { fixture, scope, digest } from '../../agentkit-harness-core/test/fixtures.mjs';

const policy = 'required-tools/v1';
test('role directory reflects explicit available grants and refusal cannot widen them', () => {
  const roles = [{ name: 'reader', tools: ['read_workspace_file'], inheritMcp: false },
    { name: 'researcher', tools: ['read_workspace_file'], inheritMcp: true }];
  const before = structuredClone(roles);
  const directory = childCapabilityDirectory(roles, { tools: ['read_workspace_file', 'mcp_search'], mcpToolNames: ['mcp_search'] });
  assert.deepEqual(admitChildCapabilities(directory, 'reader', ['mcp_search']), {
    code: 'child_capability_unavailable', executed: false, role: 'reader',
    missing_tools: ['mcp_search'], available_tools: ['read_workspace_file'], suitable_roles: ['researcher'],
  });
  assert.equal(admitChildCapabilities(directory, 'researcher', ['mcp_search']), null);
  assert.equal(admitChildCapabilities(directory, 'reader', []), null);
  assert.equal(admitChildCapabilities(directory, 'missing', []).code, 'child_role_unavailable');
  for (const requirements of [undefined, null, 'read_workspace_file', ['a', 'a'], ['bad name'], Array(129).fill('x')])
    assert.equal(admitChildCapabilities(directory, 'reader', requirements).code, 'child_capability_request_invalid');
  assert.deepEqual(roles, before);
  assert.deepEqual(childCapabilityDirectory(roles, { tools: ['read_workspace_file'], mcpToolNames: ['mcp_search'] })
    .find(item => item.role === 'researcher').tools, ['read_workspace_file']);
});

test('legacy child schemas remain unchanged, explicit capability generation requires the declared requirements', () => {
  const legacy = nativeChildToolDefinitions(['reader']);
  assert.equal(legacy[0].parameters.properties.required_tools, undefined);
  assert.deepEqual(legacy[0].parameters.required, ['role', 'task']);
  const modern = nativeChildToolDefinitions(['reader'], 120000, { childCapabilityPolicy: policy,
    capabilities: [{ role: 'reader', tools: ['read_workspace_file'] }] });
  for (const definition of modern.filter(tool => tool.childBudgetPolicy !== 'settle/v1')) {
    assert.ok(definition.parameters.required.includes('required_tools'));
    assert.match(definition.description, /read_workspace_file/);
  }
});

for (const admitted of [false, true]) test(`actual child owner ${admitted ? 'admits a matching role and freezes response continuation' : 'refuses missing capability without a child, reservation or model effect'}`, { timeout: 10000 }, async t => {
  const store = new MemoryRunStore(), roles = nativeChildRoles({ subAgents: [{ name: 'reader', instructions: 'Read assigned evidence.', tools: ['read_workspace_file'] }] });
  let childRequests = 0, bindCalls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const children = await createNativeChildren({ roles, scope, sessionId: 'session', store, tools: workspaceToolDefinitions(),
    hasSkills: false, hasMcp: false, childCapabilityPolicy: policy, outputRecoveryPolicy: 'response-boundary/v2',
    resolveModel: async () => ({ profile: fixture().config.profile, model: { generate: async request => {
      childRequests++; await gate; request.signal.throwIfAborted();
      return { kind: 'final_candidate', text: 'Read result.', toolCalls: [], usage: emptyUsage() };
    } } }), bindTools: () => { bindCalls++; return { tools: { execute: async () => ({ status: 'ok', content: 'read' }) } }; },
    verificationFactory: async () => ({ verify: async () => ({ status: 'passed', evidence: [] }) }),
  });
  t.after(async () => { release(); await children.owner.releaseRun({ scope, runId: 'run' }); });
  const start = nativeChildToolDefinitions(['reader'], 120000, { childCapabilityPolicy: policy,
    capabilities: [{ role: 'reader', tools: ['read_workspace_file'] }] })[0];
  const { config, snapshot } = fixture({ tools: [start], childCapabilityPolicy: policy,
    childLifecyclePolicy: 'owned-background/v2', limits: { maxModelCalls: 12, maxToolCalls: 20, effectTimeoutMs: 130000 } });
  let generated = false, result;
  const parent = new NativeKernel({ store, owner: 'preflight-test', digest,
    ports: { children: children.owner, model: { generate: async () => {
      if (!generated) { generated = true; return { kind: 'tool_calls', text: '', usage: emptyUsage(), toolCalls: [
        { callId: 'start-reader', name: start.name, arguments: { role: 'reader', task: 'Read evidence',
          required_tools: [admitted ? 'read_workspace_file' : 'web_search'] } },
      ] }; }
      return { kind: 'final_candidate', text: 'Admission checked.', toolCalls: [], usage: emptyUsage() };
    } }, tools: { execute: async request => {
      result = await children.owner.start(request);
      parent.submit(scope, 'run', { commandId: 'inspect-boundary', kind: 'pause', payload: {} });
      return result;
    } } } });
  parent.start(snapshot, config); const held = await parent.runUntilIdle(scope, 'run');
  assert.equal(held.phase, 'paused');
  if (!admitted) {
    assert.equal(result.status, 'error'); assert.equal(result.content.executed, false);
    assert.equal(result.content.code, 'child_capability_unavailable');
    assert.deepEqual(result.content.missing_tools, ['web_search']);
    assert.equal(held.childRunIds.length, 0); assert.equal(held.childBudgetReservations.length, 0);
    assert.equal(childRequests, 0); assert.equal(bindCalls, 0);
    assert.equal(store.list({ ...scope, agentId: `${scope.agentId}:child:reader` }).length, 0);
  } else {
    assert.equal(result.status, 'ok'); assert.equal(held.childBudgetReservations.length, 1);
    const reservation = held.childBudgetReservations[0], child = store.load(reservation.childScope, reservation.childRunId);
    assert.equal(child.configuration.outputRecoveryPolicy, 'response-boundary/v2');
    assert.equal(bindCalls, 1);
  }
});
