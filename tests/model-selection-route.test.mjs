import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentModelSelection } from '../src/host/services/model-selection.mjs';
import { dshModelSelection } from '../src/agent-preset-admission.mjs';

test('shipped preset hook reads model configuration values, including gateway models', async () => {
  const settings = { modelProfiles: [{ id: 'gateway', modelName: 'model-a', default: true }] };
  const models = { settings: async () => settings, profile: async id => ({ id: 'gateway', modelName: id }) };
  const archived = [];
  const select = createAgentModelSelection({ models, dshModelSelection, agentStorePromise: Promise.resolve({ captureRevision: async record => archived.push(record) }) });
  assert.deepEqual(await select({ metadata: { local: true }, spec: { runtime: { type: 'harness' }, bindings: { modelProfileId: 'model-a' } } }), { provider: 'agentkit-studio-gateway', model: 'model-a' });
  assert.deepEqual(await select({ metadata: { local: true }, spec: { runtime: { type: 'harness' }, bindings: { modelProfileId: 'model-b' } } }), { provider: 'agentkit-studio-gateway', model: 'model-b' });
  assert.equal(archived.length,2);
});

test('team runtime identities select a model without archiving a synthetic local Agent revision', async () => {
  const settings = { modelProfiles: [{ id: 'gateway', modelName: 'model-a', default: true }] };
  const models = { settings: async () => settings, profile: async id => ({ id: 'gateway', modelName: id }) };
  const archived = [];
  const select = createAgentModelSelection({ models, dshModelSelection, agentStorePromise: Promise.resolve({ captureRevision: async record => archived.push(record) }) });
  assert.deepEqual(await select({ metadata: { id: 'team-role-0123456789abcdef01234567', local: true }, spec: { runtime: { type: 'dsh-native' }, bindings: { modelProfileId: 'model-a' } } }), { provider: 'agentkit-studio-gateway', model: 'model-a' });
  assert.equal(archived.length, 0);
});

test('unbound Team roles use the configured default model route', async () => {
  const settings = { modelProfiles: [
    { id: 'default', modelName: 'deepseek-v4.1-flash-1017', default: true },
    { id: 'other', modelName: 'other-model' },
  ] };
  const models = { settings: async () => settings };
  const select = createAgentModelSelection({ models, dshModelSelection, agentStorePromise: Promise.resolve({ captureRevision: async () => {} }) });
  assert.deepEqual(await select({
    metadata: { id: 'team-role-0123456789abcdef01234567', local: true },
    spec: { runtime: { type: 'dsh-native' }, bindings: {} },
  }), { provider: 'agentkit-studio-default', model: 'deepseek-v4.1-flash-1017' });
});

test('API-created ManagedRuntime without a model does not emit an invalid Session selection', async () => {
  const select = createAgentModelSelection({
    models: { settings: async () => ({ modelProfiles: [] }) },
    dshModelSelection,
    CLOUD_PROVIDER: 'agentkit-studio-cloud',
    agentStorePromise: Promise.resolve({ captureRevision: async () => {} }),
  });
  assert.equal(await select({
    source: 'agentengine-managed-runtime',
    metadata: { id: 'ar-managed', local: false },
    deployment: { DeploymentType: 'ManagedRuntime' },
    spec: { runtime: { type: 'dsh-native' }, bindings: { plugins: [] } },
  }), undefined);
});
