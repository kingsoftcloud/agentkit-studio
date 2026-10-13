import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DshPresetAdmission,dshPresetId} from '../src/agent-preset-admission.mjs';
import {createAgentStore} from '../src/agent-store.mjs';
import {createStudioBuild} from '../src/studio-build.mjs';
import {restoreLocalPresets,createStartupReconciler} from '../src/preset-recovery.mjs';

test('verified older builds recover both the frozen Build and the original revision preset', async () => {
  const root=await mkdtemp(join(tmpdir(),'preset-recovery-'));
  try {
    const store=createAgentStore({storeDir:join(root,'agents')}),build=createStudioBuild({storeDir:root});
    const first=await store.create({name:'Original',spec:{instructions:{system:'original'}}});
    await build.build({agentId:first.metadata.id,agentName:first.metadata.name,revision:1,spec:first.spec,bindings:first.bindings,metadata:first.metadata});
    await store.update(first.metadata.id,{name:'Latest',spec:{instructions:{system:'latest'}}});
    await rm(join(root,'agents','revisions'),{recursive:true,force:true}); // pre-history installation
    const admitted=[], options=[];
    await restoreLocalPresets({store,build,admission:{ensure:async (_id,request)=>{options.push(request); admitted.push(request.agent)}}});
    assert.equal(admitted.length,3);
    assert.equal(admitted.find(agent=>agent.metadata.revision===1&&!agent.buildId).spec.instructions.system,'original');
    assert.equal(admitted.find(agent=>agent.metadata.revision===2).spec.instructions.system,'latest');
    assert.ok(admitted.some(agent=>agent.buildId));
    assert.ok(options.every(request=>request.allowUnavailableResources === true));
    assert.equal((await store.getRevision(first.metadata.id,1)).metadata.name,'Original');
  } finally {await rm(root,{recursive:true,force:true});}
});


test('startup restores the exact historical preset even when its resources cannot be probed', async () => {
  const row = { metadata: { id: 'ar-local-0123456789abcdef', revision: 2, local: true },
    spec: { runtime: { type: 'dsh-native' }, bindings: { skills: ['retired-skill'] } } };
  const presets = new Map();
  const admission = new DshPresetAdmission({ getAgent: async () => row,
    registry: { register: async preset => { presets.set(preset.id, preset); return () => presets.delete(preset.id); } },
    getSkillDefinitions: async () => { throw new Error('Skill Space unavailable'); } });
  await restoreLocalPresets({ store: { list: async () => [row], captureRevision: async () => {}, listRevisions: async () => [row] },
    build: { list: async () => [] }, admission });
  const presetId = dshPresetId(row.metadata.id, 2);
  assert.ok(presets.has(presetId), `agent-preset/not-found: Unknown agent preset: ${presetId}`);
  assert.equal(presets.get(presetId).plugins[0].config.agentRevision, 2);
  await admission.dispose();
});

for (const earlyRegistry of [true, false]) test(`startup waits for local restoration with registry arriving ${earlyRegistry ? 'before' : 'after'} admission`, async () => {
  let admission, release;
  const admitted = [];
  const row = { metadata: { id: 'ar-local-0123456789abcdef', revision: 1 } };
  const gate = new Promise(resolve => { release = resolve; });
  const reconciler = createStartupReconciler({
    store: Promise.resolve({ list: async () => [row], captureRevision: async () => {}, listRevisions: async () => [row] }),
    build: Promise.resolve({ build: { list: async () => [] } }),
    getAdmission: () => admission,
    deployments: () => new Promise(() => {}), // offline cloud cannot delay local readiness
  });
  if (earlyRegistry) await reconciler.run();
  admission = { registry: {}, ensure: async (id) => { await gate; admitted.push(id); } };
  let ready = false;
  const first = reconciler.run().then(() => { ready = true; });
  const second = reconciler.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(admitted, [row.metadata.id]);
});

test('a replacement registry recovers while the retiring registry is still settling', async () => {
  let release;
  const oldGate = new Promise(resolve => { release = resolve; });
  const row = { metadata: { id: 'ar-local-0123456789abcdef', revision: 1 } };
  const admitted = [];
  const reconciler = createStartupReconciler({
    store: Promise.resolve({ list: async () => [row], captureRevision: async () => {}, listRevisions: async () => [row] }),
    build: Promise.resolve({ build: { list: async () => [] } }), deployments: () => new Promise(() => {}),
  });
  const old = reconciler.run({ registry: {}, ensure: () => oldGate });
  await reconciler.run({ registry: {}, ensure: async id => { admitted.push(id); } });
  assert.deepEqual(admitted, [row.metadata.id]);
  release();
  await old;
});
