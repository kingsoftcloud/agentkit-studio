import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentStore, normalizeAgentBindings } from '../src/agent-store.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('new local Agents default to Native while explicit runtimes and saved revisions stay intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-default-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root });
  assert.equal((await store.create({ name: 'Default' })).spec.runtime.type, 'harness');
  for (const type of ['dsh-native', 'codex', 'harness']) {
    const original = await store.create({ name: type, spec: { runtime: { type, marker: 'explicit' } } });
    assert.deepEqual(original.spec.runtime, { type, marker: 'explicit' });
    await store.update(original.metadata.id, { name: 'Edited', expectedRevision: 1 });
    const reopened = createAgentStore({ storeDir: root });
    assert.deepEqual((await reopened.get(original.metadata.id)).spec.runtime, original.spec.runtime);
    assert.deepEqual((await reopened.getRevision(original.metadata.id, 1)).spec.runtime, original.spec.runtime);
  }
});

test('new Native Revisions pin strict policy while historical frozen revisions retain their old behavior', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-native-policy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root });
  const created = await store.create({ name: 'New Native', runtimeType: 'harness' });
  assert.deepEqual(created.spec.bindings.nativeAgentPolicy,
    { contract: 'agentkit.native-agent-policy/v1', mode: 'strict', rules: {} });
  assert.deepEqual(created.bindings.nativeAgentPolicy, created.spec.bindings.nativeAgentPolicy);
  const custom = { contract: 'agentkit.native-agent-policy/v1', mode: 'custom', rules: { save_crm: 'ask' } };
  const explicit = await store.create({ name: 'Custom Native', runtimeType: 'harness', bindings: { nativeAgentPolicy: custom } });
  assert.deepEqual(explicit.spec.bindings.nativeAgentPolicy, custom);

  const agentId = 'ar-local-aaaaaaaaaaaaaaaa';
  await writeFile(join(root, `${agentId}.json`), JSON.stringify({
    metadata: { id: agentId, name: 'Historical Native', revision: 1 },
    spec: { runtime: { type: 'harness' }, bindings: { policyTemplate: 'strict' } },
    bindings: { policyTemplate: 'strict' },
  }));
  assert.equal((await store.get(agentId)).spec.bindings.nativeAgentPolicy, undefined);
  const updated = await store.update(agentId, { name: 'New Revision', expectedRevision: 1 });
  assert.equal((await store.getRevision(agentId, 1)).spec.bindings.nativeAgentPolicy, undefined);
  assert.deepEqual(updated.spec.bindings.nativeAgentPolicy, created.spec.bindings.nativeAgentPolicy);
});

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

test('a stale approved Skill binding cannot replace a newer Agent spec or create a revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cas-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root }), first = await store.create({ name: 'original', runtimeType: 'harness' });
  const latest = await store.update(first.metadata.id, { expectedRevision: 1, spec: { instructions: { system: 'new user edit' } } });
  await assert.rejects(store.update(first.metadata.id, { expectedRevision: 1,
    spec: { ...first.spec, bindings: { skills: ['skill-approved-1.0.0'] } } }), {
    code: 'AGENT_EXPECTED_REVISION_CONFLICT', details: { agentId: first.metadata.id, expectedRevision: 1, actualRevision: 2 },
  });
  assert.deepEqual(await store.get(first.metadata.id), latest);
  assert.equal((await store.listRevisions(first.metadata.id)).length, 2);
  assert.deepEqual(await store.getRevision(first.metadata.id, 1), first);
});

test('separate Host processes competing for one expected revision publish exactly one new revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cas-process-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root }), first = await store.create({ name: 'before' });
  const url = new URL('../src/agent-store.mjs', import.meta.url).href;
  const code = `import {readFileSync} from 'node:fs'; import {once} from 'node:events';
    import {createAgentStore} from ${JSON.stringify(url)};
    const {root,id,name}=JSON.parse(readFileSync(0,'utf8'));
    const go=once(process,'message'); process.send('ready'); await go;
    try { const row=await createAgentStore({storeDir:root}).update(id,{name,expectedRevision:1});
      console.log(JSON.stringify({ok:true,revision:row.metadata.revision})); }
    catch(error) {console.log(JSON.stringify({ok:false,code:error.code}));}
    process.disconnect();`;
  function start(name) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '', errors = ''; child.stdout.on('data', part => { output += part; }); child.stderr.on('data', part => { errors += part; });
    const ready = new Promise((yes, no) => { child.once('message', yes); child.once('error', no); });
    const result = new Promise((yes, no) => { child.once('error', no); child.once('close', status => {
      try { assert.equal(status, 0, errors); yes(JSON.parse(output)); } catch (error) { no(error); }
    }); });
    child.stdin.end(JSON.stringify({ root, id: first.metadata.id, name })); return { child, ready, result };
  }
  const a = start('a'), b = start('b'); await Promise.all([a.ready, b.ready]); a.child.send('go'); b.child.send('go');
  const results = await Promise.all([a.result, b.result]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).code, 'AGENT_EXPECTED_REVISION_CONFLICT');
  assert.equal((await store.get(first.metadata.id)).metadata.revision, 2);
  assert.deepEqual((await store.listRevisions(first.metadata.id)).map(row => row.metadata.revision), [1, 2]);
});

test('process death while holding the publication lock does not block the next Agent update', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cas-crash-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root }), first = await store.create({ name: 'before' });
  await mkdir(join(root, '.mutation-locks'));
  const code = `import {DatabaseSync} from 'node:sqlite'; import {readFileSync} from 'node:fs';
    const db=new DatabaseSync(JSON.parse(readFileSync(0,'utf8'))); db.exec('BEGIN IMMEDIATE'); process.exit(39);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', input: JSON.stringify(join(root, '.mutation-locks', `${first.metadata.id}.sqlite`)),
  });
  assert.equal(child.status, 39, child.stderr);
  const updated = await store.update(first.metadata.id, { name: 'after', expectedRevision: 1 });
  assert.equal(updated.metadata.revision, 2); assert.equal(updated.metadata.name, 'after');
});

test('an invalid expected revision is rejected without changing the Agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cas-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root }), first = await store.create({ name: 'before' });
  for (const expectedRevision of [0, -1, 1.5, '1', null])
    await assert.rejects(store.update(first.metadata.id, { name: 'must not change', expectedRevision }), { code: 'INVALID_EXPECTED_AGENT_REVISION' });
  assert.deepEqual(await store.get(first.metadata.id), first);
});

test('lost live authority while queued on publication lock cannot create a new Agent revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-guard-lock-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createAgentStore({ storeDir: root }), first = await store.create({ name: 'before' });
  await mkdir(join(root, '.mutation-locks'));
  const db = new DatabaseSync(join(root, '.mutation-locks', `${first.metadata.id}.sqlite`));
  db.exec('BEGIN IMMEDIATE'); let current = true;
  const pending = store.update(first.metadata.id, { name: 'late forbidden', expectedRevision: 1 }, { assertCurrent: () => current });
  await new Promise(resolve => setTimeout(resolve, 35)); current = false; db.exec('ROLLBACK'); db.close();
  await assert.rejects(pending, { code: 'AGENT_UPDATE_AUTHORITY_LOST' });
  assert.deepEqual(await store.get(first.metadata.id), first);
  assert.deepEqual(await store.listRevisions(first.metadata.id), [first]);
  await assert.rejects(store.update(first.metadata.id, { name: 'async guard forbidden' }, { assertCurrent: async () => true }), { code: 'AGENT_UPDATE_AUTHORITY_LOST' });
  assert.deepEqual(await store.get(first.metadata.id), first);
});
