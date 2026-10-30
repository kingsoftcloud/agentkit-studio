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
test('the product Host defaults new revisions and actual Build archives to Native while preserving legacy rollback and frozen pins', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-product-default-')); t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { runtime: { type: 'harness' }, bindings: {} }, input = { agentId: 'ar-local-default', agentName: 'Default',
    revision: 1, metadata: { local: true }, spec };
  const { build } = await createBuildServices({ storeDir: root }).studioBuildPromise;
  const { build: rollback } = await createBuildServices({ storeDir: root, env: { AGENTKIT_STUDIO_NATIVE_HARNESS: 'legacy' } }).studioBuildPromise;
  const modern = await build.build(input), old = await rollback.build(input);
  assert.notEqual(modern.id, old.id);
  assert.equal(selectedNativeBuildContract(await build.resolve(input.agentId, modern.id)), native);
  assert.equal(selectedNativeBuildContract(await build.resolve(input.agentId, old.id), nativeHarnessHostContract()), undefined);
  assert.equal(selectedNativeBuildContract(await rollback.resolve(input.agentId, modern.id), nativeHarnessHostContract({ AGENTKIT_STUDIO_NATIVE_HARNESS: 'legacy' })), native);
  for (const [env, expected] of [[{}, native], [{ AGENTKIT_STUDIO_NATIVE_HARNESS: '' }, native],
    [{ AGENTKIT_STUDIO_NATIVE_HARNESS: native }, native], [{ AGENTKIT_STUDIO_NATIVE_HARNESS: 'legacy' }, undefined]]) {
    const registered = [], agent = { metadata: { id: input.agentId, local: true, revision: 1 }, spec };
    const admission = new DshPresetAdmission({ nativeEngineContract: nativeHarnessHostContract(env), getAgent: async () => agent,
      registry: { register: async value => { registered.push(value); return () => {}; } } });
    try { await admission.ensure(input.agentId);
      assert.equal(registered[0].plugins.find(plugin => plugin.id === 'studio-runtime').config.nativeEngineContract, expected);
    } finally { await admission.dispose(); }
  }
  for (const runtime of ['dsh-native', 'codex']) assert.equal(buildExecutionEngine({ runtime: { type: runtime } }, nativeHarnessHostContract()), undefined);
  for (const value of ['future/v2', 'false', false, null])
    assert.throws(() => nativeHarnessHostContract({ AGENTKIT_STUDIO_NATIVE_HARNESS: value }), /Unsupported Native Harness engine contract/);
});

test('actual archives pin the engine and produce different Build IDs for the same revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-build-engine-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = { agentId: 'ar-local-engine', agentName: 'Engine', revision: 1, metadata: { local: true },
    spec: { runtime: { type: 'harness' }, bindings: {} } };
  const plain = createStudioBuild({ storeDir: root }), enabled = createStudioBuild({ storeDir: root, nativeEngineContract: native });
  const legacy = await plain.build(input), modern = await enabled.build(input);
  assert.notEqual(legacy.id, modern.id); assert.equal((await enabled.build(input)).id, modern.id);
  // Reopen through the opposite default: the actual archive stays authoritative.
  const old = await enabled.resolve(input.agentId, legacy.id), current = await plain.resolve(input.agentId, modern.id);
  assert.equal(selectedNativeBuildContract(old, native), undefined); assert.equal(selectedNativeBuildContract(current), native);
  assert.deepEqual(current.executionEngine, buildExecutionEngine(input.spec, native));
  await assert.rejects(plain.build({ ...input, executionEngine: current.executionEngine }), { code: 'BUILD_ENGINE_BINDING_CHANGED' });
});
test('preset admission uses the frozen engine while live revisions retain the explicit Host default', async () => {
  for (const [pin, liveDefault, expected] of [[native, undefined, native], [undefined, native, undefined]]) {
    const registered = [], spec = { runtime: { type: 'harness' }, bindings: {} };
    const agent = { metadata: { id: 'engine', local: true, revision: 1 }, spec,
      buildId: 'build_0123456789abcdef0123', executionEngine: buildExecutionEngine(spec, pin) };
    const admission = new DshPresetAdmission({ nativeEngineContract: liveDefault, getAgent: async () => agent,
      registry: { register: async value => { registered.push(value); return () => {}; } } });
    await admission.ensure('engine');
    assert.equal(registered[0].plugins.find(p => p.id === 'studio-runtime').config.nativeEngineContract, expected);
    await admission.dispose();
  }
});
test('unknown engine versions, altered contracts and old unpinned builds cannot opt in through ambient flags', () => {
  const spec = { runtime: { type: 'harness' } }, agent = { spec, buildId: 'build_0123456789abcdef0123' };
  assert.equal(selectedNativeBuildContract(agent, native), undefined);
  for (const changed of [{ engine: 'future-engine' }, { turnContract: 'future-turn' }, { jsonCodec: 'future-codec' }, { extra: true }])
    assert.throws(() => selectedNativeBuildContract({ ...agent, executionEngine: { ...buildExecutionEngine(spec, native), ...changed } }),
      { code: 'STUDIO_BUILD_ENGINE_UNSUPPORTED' });
  assert.equal(selectedNativeBuildContract({ spec }, native), native);
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
