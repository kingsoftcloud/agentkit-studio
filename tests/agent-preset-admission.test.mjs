import test from 'node:test';
import assert from 'node:assert/strict';
import { DshPresetAdmission, dshPresetEligibility, dshPresetId, unsupportedDshBindings } from '../src/agent-preset-admission.mjs';

function agent(overrides = {}) {
  return {
    id: 'demo/agent',
    name: 'Demo Agent',
    metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 3 },
    spec: { runtime: { type: 'dsh-native' }, bindings: {}, ...overrides.spec },
    ...overrides,
  };
}

test('dsh preset admission uses a stable revision-scoped id', () => {
  assert.equal(dshPresetId('demo/agent', 3), 'agentkit-studio-agent-demo_2Fagent-r3');
  assert.deepEqual(dshPresetEligibility(agent()), {
    ok: true,
    agentId: 'demo/agent',
    revision: 3,
    presetId: 'agentkit-studio-agent-demo_2Fagent-r3',
    runtime: 'dsh-native',
  });
});

test('resource-bearing or non-DSH revisions fail closed', () => {
  const resourceAgent = agent({ spec: { runtime: { type: 'dsh-native' }, bindings: { modelProfileIds: ['model:one'], mcpServers: [{ resourceId: 'mcp:one' }] } } });
  assert.deepEqual(unsupportedDshBindings(resourceAgent), ['model', 'mcp']);
  assert.equal(dshPresetEligibility(resourceAgent).code, 'STUDIO_PRESET_RESOURCE_UNSUPPORTED');
  assert.equal(dshPresetEligibility(agent({ spec: { runtime: { type: 'codex' }, bindings: {} } })).code, 'STUDIO_PRESET_RUNTIME_UNSUPPORTED');
});

test('admission registers once and unregisters replaced revisions', async () => {
  const registered = [];
  const unregistered = [];
  const registry = {
    async register(definition) {
      registered.push(definition);
      return async () => { unregistered.push(definition.id); };
    },
  };
  const revision = { ...agent(), metadata: { id: 'demo/agent', name: 'Demo Agent', revision: 1 } };
  const admission = new DshPresetAdmission({ registry, getAgent: async () => revision });
  const first = await admission.ensure('demo/agent');
  const reused = await admission.ensure('demo/agent');
  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(registered.length, 1);
  revision.metadata.revision = 2;
  const replaced = await admission.ensure('demo/agent');
  assert.equal(replaced.presetId, dshPresetId('demo/agent', 2));
  assert.deepEqual(unregistered, [dshPresetId('demo/agent', 1)]);
  await admission.dispose();
  assert.deepEqual(unregistered, [dshPresetId('demo/agent', 1), dshPresetId('demo/agent', 2)]);
});

test('admission reports missing registry as typed error', async () => {
  const admission = new DshPresetAdmission({ getAgent: async () => agent() });
  await assert.rejects(admission.ensure('demo/agent'), error => error.code === 'DSH_PRESET_REGISTRY_UNAVAILABLE');
});
