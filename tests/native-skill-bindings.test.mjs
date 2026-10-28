import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boundSkillResources, loadBoundSkillDefinitions } from '../packages/agentkit-harness/src/skill-bindings.mjs';
import { prepareLocalResourceContext } from '../src/local-runtime.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { runtimeSkill } from '../src/skill-files.mjs';
import { createStudioBuild } from '../src/studio-build.mjs';
import { createPortableBundles, importPortableBundle, loadPortableRuntime } from '../src/portable-bundle.mjs';

const space = (id, enabled = true) => ({ enabled, config: { binding: { resource: { kind: 'skill-space', id } } } });
const bindings = () => ({ skills: ['local', { resourceId: 'shared' }],
  plugins: [space('space-one'), space('shared'), space('disabled', false), space('space-two')] });

test('all explicit Skill Spaces survive in order, with duplicate IDs loaded once and disabled bindings excluded', () => {
  assert.deepEqual(boundSkillResources(bindings()), [
    { kind: 'skill', resourceId: 'local' }, { kind: 'skill', resourceId: 'shared' },
    { kind: 'skill-space', resourceId: 'space-one' }, { kind: 'skill-space', resourceId: 'space-two' },
  ]);
  assert.deepEqual(boundSkillResources({ skills: [{ resourceId: 'off', enabled: false }] }), []);
});

test('an invalid enabled binding cannot silently disappear from admission', () => {
  for (const input of [{ skills: [null] }, { skills: [''] }, { skills: [' spaced '] }, { plugins: [space(undefined)] },
    { skills: 'not-an-array' }, { plugins: {} }])
    assert.throws(() => boundSkillResources(input), { code: 'SKILL_BINDING_INVALID' });
});

test('Harness and Codex context include every bound space and report each actual load once', async () => {
  for (const runtime of ['harness', 'codex']) {
    const calls = [], events = [];
    const result = await prepareLocalResourceContext({ record: { spec: { runtime: { type: runtime }, bindings: bindings() } },
      input: 'all Skills', resourceMode: 'context-only', onResource: value => events.push(value),
      resourceAdapter: { loadSkill: async id => { calls.push(id); return { name: id, content: `Instructions for ${id}` }; } } });
    assert.deepEqual(calls, ['local', 'shared', 'space-one', 'space-two']);
    for (const id of calls) assert.ok(result.resourceContext.includes(`Instructions for ${id}`));
    assert.ok(!result.resourceContext.includes('disabled'));
    assert.deepEqual(events.map(({ kind, resourceId, status }) => ({ kind, resourceId, status })),
      boundSkillResources(bindings()).map(item => ({ ...item, status: 'succeeded' })));
  }
});

test('prompt-only and tools-only preparation never read Skill files', async () => {
  for (const resourceMode of ['prompt-only', 'tools-only']) {
    const result = await prepareLocalResourceContext({ record: { spec: { bindings: bindings() } }, resourceMode,
      resourceAdapter: { loadSkill: () => { throw new Error('unexpected Skill load'); } } });
    assert.equal(result.resourceContext, '');
  }
});

test('a later bound space failure prevents preset registration rather than admitting a partial Skill set', async () => {
  const registered = [], loaded = [];
  const agent = { metadata: { id: 'bound-skills', revision: 1, local: true },
    spec: { runtime: { type: 'harness' }, bindings: { plugins: [space('first'), space('second')] } } };
  const admission = new DshPresetAdmission({ getAgent: async () => agent,
    getSkillDefinitions: value => loadBoundSkillDefinitions(value.spec.bindings, { loadSkill: async id => {
      loaded.push(id);
      if (id === 'second') throw Object.assign(new Error('unavailable'), { code: 'SKILL_UNAVAILABLE' });
      return { definitions: [{ name: 'first', content: 'first' }] };
    } }), registry: { register: async value => { registered.push(value); return () => {}; } } });
  await assert.rejects(admission.ensure(agent.metadata.id), { code: 'SKILL_UNAVAILABLE' });
  assert.deepEqual(loaded, ['first', 'second']);
  assert.deepEqual(registered, []);
  await admission.dispose();
});

test('Native Frozen export/import and actual preset admission preserve multiple spaces after the source is deleted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-skill-bindings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), values = new Map();
  for (const id of ['direct', 'first', 'second']) {
    const directory = join(source, 'skills', id), content = `---\nname: ${id}\ndescription: ${id} summary\n---\n${id} instructions\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), content);
    await writeFile(join(directory, 'reference.txt'), `${id} reference`);
    values.set(id, { name: id, definitions: [runtimeSkill({ name: id, content, path: join(directory, 'SKILL.md') })] });
  }
  const agentId = 'ar-local-1234567890abcdef', native = 'agentkit.native-dsh-turn/v1';
  const spec = { runtime: { type: 'harness' }, bindings: { modelProfileId: 'model', skills: ['direct'],
    plugins: [space('first'), space('second'), space('first')] } };
  const build = createStudioBuild({ storeDir: join(source, 'store'), nativeEngineContract: native });
  const record = await build.build({ agentId, agentName: 'Skills', revision: 1, metadata: { id: agentId, revision: 1, local: true }, spec, bindings: spec.bindings });
  const portable = createPortableBundles({ storeDir: join(source, 'store'), build,
    adapters: { loadSkill: async id => values.get(id) }, configuration: {},
    models: { profile: async id => ({ id, provider: 'openai-compatible', modelName: 'fixture',
      baseUrl: 'https://model.example/v1', credentialName: 'MODEL_TARGET_KEY', apiKey: 'source-secret' }) } });
  const prepared = await portable.prepare(agentId, record.id);
  assert.equal(prepared.skillCount, 3);
  const bytes = Buffer.from((await portable.download(agentId, record.id, prepared.bundleId)).base64, 'base64');
  const target = join(root, 'target'), imported = await importPortableBundle(bytes, target);
  await rm(source, { recursive: true });
  const env = { AGENTKIT_HOME: target, AGENTKIT_RUNTIME_AGENT_ID: agentId, AGENTKIT_RUNTIME_BUILD_ID: imported.buildId };
  for (const requirement of imported.requirements) env[requirement.name] = 'target-secret';
  const runtime = await loadPortableRuntime(target, env);
  const frozen = await createStudioBuild({ storeDir: join(target, 'studio') }).resolve(agentId, imported.buildId);
  const registered = [], loads = [];
  const adapter = { loadSkill: async id => { loads.push(id); return runtime.loadSkill(id); } };
  const admission = new DshPresetAdmission({ getAgent: async () => frozen,
    getSkillDefinitions: value => loadBoundSkillDefinitions(value.spec.bindings, adapter),
    registry: { register: async value => { registered.push(value); return () => {}; } } });
  t.after(() => admission.dispose());
  await admission.ensure(agentId);
  const config = registered[0].plugins.find(item => item.id === 'studio-runtime').config;
  assert.equal(config.nativeEngineContract, native);
  assert.deepEqual(config.skillDefinitions.map(item => item.name), ['direct', 'first', 'second']);
  assert.deepEqual(loads, ['direct', 'first', 'second']);
  for (const definition of config.skillDefinitions) assert.ok(definition.path.startsWith(target));
  const context = await prepareLocalResourceContext({ record: frozen, input: 'read all', resourceMode: 'context-only', resourceAdapter: adapter });
  for (const id of ['direct', 'first', 'second']) assert.ok(context.resourceContext.includes(`${id} instructions`));
  assert.equal(context.resourceContext.includes(source), false);
});
