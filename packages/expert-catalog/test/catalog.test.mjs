import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpertCatalog, exportTemplateDefinition } from '../src/catalog.mjs';
import { seed } from '../src/seed.mjs';
import { apply } from '../src/index.mjs';

test('bundled catalog is complete, immutable to consumers, and version-addressed', () => {
  const source = structuredClone(seed), catalog = createExpertCatalog(source);
  assert.equal(catalog.list().items.length, 18);
  assert.equal(catalog.list().categories.length, 6);
  const draft = catalog.prepare('knowledge-assistant');
  assert.deepEqual(draft.requirements.map(row => row.kind), ['knowledge-base']);
  assert.match(draft.templateSource.digest, /^sha256:[a-f0-9]{64}$/);
  draft.spec.instructions.system = 'consumer edit';
  source.items[0].name = 'external mutation';
  assert.notEqual(catalog.prepare('knowledge-assistant').spec.instructions.system, 'consumer edit');
  assert.notEqual(catalog.list().items[0].name, 'external mutation');
  assert.throws(() => catalog.prepare({ id: 'knowledge-assistant', version: '0.0.0' }), { code: 'TEMPLATE_VERSION_UNAVAILABLE' });
  assert.throws(() => catalog.prepare({ id: 'knowledge-assistant', digest: 'tampered' }), { code: 'TEMPLATE_VERSION_UNAVAILABLE' });
});

test('invalid or private seed definitions fail before distribution', () => {
  for (const mutate of [item => { item.spec.bindings.modelProfileId = 'author-model'; }, item => { item.spec.bindings.plugins = [{ config: { secret: 'private' } }]; }, item => { item.spec.memory.providerRef = 'private-instance'; }]) {
    const source = structuredClone(seed); mutate(source.items[0]);
    assert.throws(() => createExpertCatalog(source), { code: 'TEMPLATE_PRIVATE_BINDING' });
  }
  const duplicate = structuredClone(seed); duplicate.items.push(duplicate.items[0]);
  assert.throws(() => createExpertCatalog(duplicate), { code: 'TEMPLATE_DUPLICATE' });
  const incomplete = structuredClone(seed); incomplete.items[0].examples = [];
  assert.throws(() => createExpertCatalog(incomplete), { code: 'TEMPLATE_DEFINITION_INVALID' });
});

test('Revision export keeps authoring fields and converts private bindings to requirements', () => {
  const agent = { metadata: { id: 'author-agent', name: 'Reusable', userId: 'author-user' }, spec: {
    runtime: { type: 'harness', workspace: '/private/work' }, description: 'Example', instructions: { system: 'Role', task: 'Method' },
    bindings: { modelProfileId: 'model-secret', modelProfileIds: ['model-secret'], tools: [], mcpServers: [{ resourceId: 'author-mcp' }], skills: [], plugins: [{ enabled: true, config: { apiKey: 'secret-value', binding: { connectionRef: 'author-account', resource: { kind: 'memory-instance', id: 'author-memory' } } } }] },
    memory: { enabled: true, providerRef: 'private-provider', recall: { enabled: true }, write: { mode: 'explicit_only' } },
  } };
  const original = structuredClone(agent), exported = exportTemplateDefinition(agent);
  assert.equal(exported.spec.instructions.task, 'Method');
  assert.equal(exported.spec.memory.write.mode, 'explicit_only');
  assert.deepEqual(exported.requirements.map(item => item.kind), ['model', 'mcp', 'memory-instance']);
  assert.doesNotMatch(JSON.stringify(exported), /author-|secret-value|model-secret|private/);
  assert.deepEqual(agent, original);
  agent.spec.bindings.plugins.push({ pluginRef: 'unsupported' });
  assert.throws(() => exportTemplateDefinition(agent), { code: 'TEMPLATE_RESOURCE_UNSUPPORTED' });
});

test('independent DSH plugin registers its catalog service', async () => {
  const services = new Map();
  await apply({ provide: (name, value) => services.set(name, value) });
  assert.equal(services.get('studioTemplates').list().items.length, 18);
});
