import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentStore, normalizeAgentBindings } from '../src/agent-store.mjs';

test('editing and reopening preserve immutable Agent revisions for older native Sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-revisions-'));
  try {
    const store = createAgentStore({storeDir:root});
    const first = await store.create({name:'Before',spec:{instructions:{system:'r1'},bindings:{modelProfileId:'model-a'}}});
    await store.update(first.metadata.id,{name:'After',spec:{instructions:{system:'r2'},bindings:{modelProfileId:'model-b'}}});
    const reopened = createAgentStore({storeDir:root});
    assert.equal((await reopened.getRevision(first.metadata.id,1)).spec.instructions.system,'r1');
    assert.equal((await reopened.getRevision(first.metadata.id,2)).spec.instructions.system,'r2');
    assert.equal((await reopened.listRevisions(first.metadata.id)).length,2);
    await assert.rejects(()=>reopened.captureRevision({...first,spec:{instructions:{system:'changed'}}}),{code:'AGENT_REVISION_CONFLICT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

const cloudSkillSpace = 'bcb4df65-2448-4c8a-99ca-62a12d26bce9';

test('legacy UUID Skill binding is migrated to a cloud Skill Space while local IDs stay local', () => {
  const bindings = normalizeAgentBindings({ skills: [cloudSkillSpace, 'local-skill-1'], mcpServers: [] });
  assert.deepEqual(bindings.skills, ['local-skill-1']);
  assert.equal(bindings.plugins[0].config.binding.resource.kind, 'skill-space');
  assert.equal(bindings.plugins[0].config.binding.resource.id, cloudSkillSpace);
});

test('Agent Store normalizes legacy records on read and persists the normalized shape on update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentkit-store-'));
  try {
    const agentId = 'ar-local-aaaaaaaaaaaaaaaa';
    await writeFile(join(root, `${agentId}.json`), JSON.stringify({
      metadata: { id: agentId, name: 'legacy', revision: 1 },
      spec: { runtime: { type: 'dsh-native' }, bindings: { skills: [cloudSkillSpace] } },
      bindings: { skills: [cloudSkillSpace] },
    }));
    const store = createAgentStore({ storeDir: root });
    const read = await store.get(agentId);
    assert.equal(read.spec.bindings.skills.length, 0);
    assert.equal(read.spec.bindings.plugins[0].config.binding.resource.id, cloudSkillSpace);
    const updated = await store.update(agentId, { description: 'migrated' });
    assert.equal(updated.bindings.plugins[0].config.binding.resource.kind, 'skill-space');
    const persisted = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, `${agentId}.json`), 'utf8'));
    assert.equal(persisted.bindings.skills.length, 0);
    assert.equal(persisted.bindings.plugins[0].config.binding.resource.id, cloudSkillSpace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
