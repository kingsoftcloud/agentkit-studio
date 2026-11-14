import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioBuild } from '../src/studio-build.mjs';
import { buildExecutionEngine, nativeHarnessHostContract, selectedNativeBuildContract } from '../src/build-engine.mjs';
import { createBuildServices } from '../src/host/services/builds.mjs';
import { DshPresetAdmission } from '../src/agent-preset-admission.mjs';
import { createZip, buildIdFor } from '../src/zip.mjs';
const native = 'agentkit.native-dsh-turn/v1';
test('Harness admissions and actual Build archives use only the independent Native engine', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-product-default-')); t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { runtime: { type: 'harness' }, bindings: {} }, input = { agentId: 'ar-local-default', agentName: 'Default', revision: 1, metadata: { local: true }, spec };
  const { build } = await createBuildServices({ storeDir: root }).studioBuildPromise;
  const modern = await build.build(input);
  assert.equal(selectedNativeBuildContract(await build.resolve(input.agentId, modern.id)), native);
  const reopened = createStudioBuild({ storeDir: root });
  assert.equal((await reopened.build(input)).id, modern.id);
  assert.deepEqual((await reopened.resolve(input.agentId, modern.id)).executionEngine, buildExecutionEngine(spec));
  await assert.rejects(reopened.build({ ...input, executionEngine: { ...buildExecutionEngine(spec), engine: 'retired-engine' } }), { code: 'BUILD_ENGINE_BINDING_CHANGED' });
  for (const env of [{}, { AGENTKIT_STUDIO_NATIVE_HARNESS: '' }, { AGENTKIT_STUDIO_NATIVE_HARNESS: native }]) {
    const registered = [], admission = new DshPresetAdmission({ nativeEngineContract: nativeHarnessHostContract(env), getAgent: async () => ({ metadata: { id: input.agentId, local: true, revision: 1 }, spec }), registry: { register: async value => { registered.push(value); return () => {}; } } });
    try { await admission.ensure(input.agentId); const config = registered[0].plugins.find(plugin => plugin.id === 'studio-runtime').config;
      assert.equal(config.runtime, 'native-engine');
      assert.equal(config.nativeEngineContract, undefined); }
    finally { await admission.dispose(); }
  }
  for (const value of ['legacy', 'future/v2', 'false', false, null]) assert.throws(() => nativeHarnessHostContract({ AGENTKIT_STUDIO_NATIVE_HARNESS: value }), /Unsupported Native Harness engine contract/);
  for (const runtime of ['dsh-native', 'codex']) assert.equal(buildExecutionEngine({ runtime: { type: runtime } }), undefined);
});

test('legacy and unpinned Harness builds cannot be reinterpreted or admitted through ambient defaults', async () => {
  const spec = { runtime: { type: 'harness' }, bindings: {} };
  for (const executionEngine of [undefined, { contract: 'agentkit.build-engine/v1', runtime: 'harness', engine: 'agentkit.harness/dsh-plugin/v1' }]) {
    const agent = { metadata: { id: 'legacy', local: true, revision: 1 }, spec, buildId: 'build_0123456789abcdef0123', executionEngine };
    assert.throws(() => selectedNativeBuildContract(agent, native), { code: 'STUDIO_BUILD_ENGINE_UNSUPPORTED' });
    let registrations = 0;
    const admission = new DshPresetAdmission({ getAgent: async () => agent, registry: { register: async () => { registrations++; return () => {}; } } });
    await assert.rejects(admission.ensure('legacy'), { code: 'STUDIO_BUILD_ENGINE_UNSUPPORTED' });
    assert.equal(registrations, 0); await admission.dispose();
  }
});

test('unknown or altered engine pins fail closed without changing the Native source of truth', () => {
  const spec = { runtime: { type: 'harness' } }, agent = { spec, buildId: 'build_0123456789abcdef0123' };
  for (const changed of [{ engine: 'future-engine' }, { turnContract: 'future-turn' }, { jsonCodec: 'future-codec' }, { extra: true }])
    assert.throws(() => selectedNativeBuildContract({ ...agent, executionEngine: { ...buildExecutionEngine(spec), ...changed } }), { code: 'STUDIO_BUILD_ENGINE_UNSUPPORTED' });
  assert.equal(selectedNativeBuildContract({ spec }), native);
});

test('archive readers reject format downgrades and incomplete engine pins even with a matching content hash', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-build-format-')); t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { runtime: { type: 'harness' } }, agentId = 'ar-local-format', build = createStudioBuild({ storeDir: root });
  const base = { agentId, name: 'Format', revision: 1, bindings: {}, metadata: {}, spec };
  for (const fields of [
    { format: 'agentkit.agent-bundle/v1', executionEngine: buildExecutionEngine(spec, native) },
    { format: 'agentkit.agent-bundle/v2' },
    { format: 'agentkit.agent-bundle/v3', executionEngine: buildExecutionEngine(spec, native) },
    { format: 'agentkit.agent-bundle/v2', executionEngine: { ...buildExecutionEngine(spec, native), engine: 'future' } },
  ]) {
    const identity = { ...base, ...fields }, id = buildIdFor(identity), dir = join(root, 'dist', agentId, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'agent-bundle.zip'), createZip([
      { name: 'agent-bundle/manifest.json', data: JSON.stringify({ ...identity, createdAt: new Date().toISOString() }) },
      { name: 'agent-bundle/spec.json', data: JSON.stringify({ spec, bindings: {} }) },
    ]));
    await assert.rejects(build.resolve(agentId, id), { code: 'BUILD_ARTIFACT_INVALID' });
  }
});
