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
