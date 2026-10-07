import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dshModelSelection } from '../src/agent-preset-admission.mjs';

test('shipped preset hook reads model configuration values, including gateway models', async () => {
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('getModelSelection: async agent => {') + 'getModelSelection: '.length, source.indexOf('    getSkillDefinitions:')).trim().replace(/,$/, '');
  const settings = { modelProfiles: [{ id: 'gateway', modelName: 'model-a', default: true }] };
  const models = { settings: async () => settings, profile: async id => ({ id: 'gateway', modelName: id }) };
  const archived = [];
  const select = new Function('configurationPromise', 'models', 'dshModelSelection', 'codexModels', 'codexModelSelection', 'agentStorePromise', `return (${body});`)(Promise.resolve({ describe: async () => settings }), models, dshModelSelection,undefined,undefined,Promise.resolve({captureRevision:async record=>archived.push(record)}));
  assert.deepEqual(await select({ metadata: { local: true }, spec: { runtime: { type: 'harness' }, bindings: { modelProfileId: 'model-a' } } }), { provider: 'agentkit-studio-gateway', model: 'model-a' });
  assert.deepEqual(await select({ metadata: { local: true }, spec: { runtime: { type: 'harness' }, bindings: { modelProfileId: 'model-b' } } }), { provider: 'agentkit-studio-gateway', model: 'model-b' });
  assert.equal(archived.length,2);
});
