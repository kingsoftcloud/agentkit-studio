import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgentStore} from '../src/agent-store.mjs';
import {createStudioBuild} from '../src/studio-build.mjs';
import {restoreLocalPresets} from '../src/preset-recovery.mjs';

test('verified older builds recover both the frozen Build and the original revision preset', async () => {
  const root=await mkdtemp(join(tmpdir(),'preset-recovery-'));
  try {
    const store=createAgentStore({storeDir:join(root,'agents')}),build=createStudioBuild({storeDir:root});
    const first=await store.create({name:'Original',spec:{instructions:{system:'original'}}});
    await build.build({agentId:first.metadata.id,agentName:first.metadata.name,revision:1,spec:first.spec,bindings:first.bindings,metadata:first.metadata});
    await store.update(first.metadata.id,{name:'Latest',spec:{instructions:{system:'latest'}}});
    await rm(join(root,'agents','revisions'),{recursive:true,force:true}); // pre-history installation
    const admitted=[];
    await restoreLocalPresets({store,build,admission:{ensure:async (_id,{agent})=>admitted.push(agent)}});
    assert.equal(admitted.length,3);
    assert.equal(admitted.find(agent=>agent.metadata.revision===1&&!agent.buildId).spec.instructions.system,'original');
    assert.equal(admitted.find(agent=>agent.metadata.revision===2).spec.instructions.system,'latest');
    assert.ok(admitted.some(agent=>agent.buildId));
    assert.equal((await store.getRevision(first.metadata.id,1)).metadata.name,'Original');
  } finally {await rm(root,{recursive:true,force:true});}
});
