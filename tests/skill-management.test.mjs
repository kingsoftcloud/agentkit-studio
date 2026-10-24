import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentStore } from '../src/agent-store.mjs';
import { createSkillDiscovery } from '../src/skill-discovery.mjs';
import { createStudioSkillManagement } from '../src/skill-management.mjs';
import { createDshNodeSkillManagement } from '../src/providers/dsh-node-skill-management.mjs';

const manifest = name => Buffer.from(`---\nname: ${name}\ndescription: Unicode 技能 😀\nversion: 1.2.3\n---\nInstructions`);
const snapshot = (commit = 'a'.repeat(40), name = 'fixed-skill') => ({ repository: { owner: 'owner', name: 'repo', url: 'https://github.com/owner/repo' },
  commit, candidates: [{ candidateId: `candidate-${commit[0]}`, path: '', files: [
    { path: 'SKILL.md', bytes: manifest(name) }, { path: 'assets/.binary', bytes: Buffer.from([0, 255, 128, 13, 10]) },
    { path: 'scripts/never-run.mjs', bytes: Buffer.from('throw new Error("installation must not execute this")') },
  ] }] });
const jsonFiles = root => readdirSync(root, { recursive: true }).filter(path => path.endsWith('.json'))
  .map(path => ({ path: join(root, path), bytes: readFileSync(join(root, path)), value: JSON.parse(readFileSync(join(root, path), 'utf8')) }));

async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-management-'))), workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state');
  mkdirSync(workspaceRoot); mkdirSync(stateDir);
  const agents = createAgentStore({ storeDir: join(root, 'agents') }), first = await agents.create({ name: 'fixed agent', runtimeType: 'harness' });
  const skillDiscovery = createSkillDiscovery({ storeDir: join(root, 'skills') });
  let inspections = 0, sourceValue = snapshot(), policy = 'workspace-write', approval = async () => 'allowed-once';
  const source = { search: async query => ({ repositories: [{ full_name: query }] }), inspect: async () => {
    inspections++; const intent = jsonFiles(stateDir).find(item => item.value.phase === 'executing');
    assert.ok(intent, 'durable original intent must precede network');
    assert.equal(intent.value.request.agentId, first.metadata.id);
    assert.equal(intent.value.request.sessionId, 'session-1');
    for (const field of ['scope', 'runId', 'executionFence', 'turnId']) assert.equal(Object.hasOwn(intent.value.request, field), false);
    return sourceValue;
  } };
  const options = { workspaceRoot, stateDir, agentId: first.metadata.id, skillDiscovery, agents, source };
  const management = createStudioSkillManagement(options), owners = [];
  const create = overrides => {
    const port = createDshNodeSkillManagement({ workspaceRoot, stateDir, agentId: first.metadata.id, agentRevision: 1, buildId: 'build-1', management,
      ctx: { sandboxPolicy: { resolve: () => ({ mode: policy }) }, approval: { request: input => approval(input) } }, ...overrides });
    owners.push(port); return port;
  };
  const port = create(); let serial = 0;
  const exec = (name, args, extra = {}) => ({ name, arguments: args, callId: `call-${++serial}`, signal: new AbortController().signal,
    agent: { session: { id: 'session-1' } }, ...extra });
  const invoke = (name, args, invocation = exec(name, args), owner = port) => owner.execute(name, args, invocation);
  const inspect = async () => {
    const result = await invoke('skill_discover_github', { source: 'https://github.com/owner/repo' });
    assert.equal(result.status, 'ok', JSON.stringify(result)); return result.content;
  };
  t.after(async () => { await Promise.all(owners.map(owner => owner.close())); rmSync(root, { recursive: true, force: true }); });
  return { root, workspaceRoot, stateDir, agents, first, skillDiscovery, management, options, create, port, exec, invoke, inspect,
    get inspections() { return inspections; }, source: value => { sourceValue = value; },
    policy: value => { policy = value; }, approval: fn => { approval = fn; } };
}

function cold(h, name, args, callId, extra = {}) {
  const child = spawnSync(process.execPath, [new URL('./fixtures/skill-management-owner.mjs', import.meta.url).pathname], {
    input: JSON.stringify({ root: h.root, agentId: h.first.metadata.id, name, args, callId, ...extra }), encoding: 'utf8', timeout: extra.timeoutMs ?? 20000,
    env: { ...process.env, STUDIO_PYTHON: '/python-unavailable' },
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message); const value = JSON.parse(child.stdout); assert.notEqual(value.pid, process.pid); return value.result;
}

test('inspection survives another Node PID; install uses exact cached binary and binds only a new immutable Agent revision', async t => {
  const h = await setup(t), inspection = await h.inspect();
  assert.equal(h.inspections, 1); assert.equal(inspection.commit, 'a'.repeat(40));
  assert.equal(inspection.candidates[0].fileCount, 3); assert.equal(Object.hasOwn(inspection.candidates[0], 'files'), false);
  h.source(snapshot('b'.repeat(40), 'changed-source'));
  const args = { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId };
  const installed = cold(h, 'skill_install', args, 'cold-install'); assert.equal(installed.status, 'ok', JSON.stringify(installed));
  const resource = installed.content.installed_resource, directory = await h.skillDiscovery.resolveInstalled(resource.resourceId);
  assert.equal(resource.name, 'fixed-skill'); assert.deepEqual(readFileSync(join(directory, 'assets/.binary')), Buffer.from([0, 255, 128, 13, 10]));
  assert.match(readFileSync(join(directory, 'scripts/never-run.mjs'), 'utf8'), /must not execute/);
  assert.equal((await h.agents.get(h.first.metadata.id)).metadata.revision, 1);
  const records = jsonFiles(h.stateDir).map(item => [item.path, item.bytes.toString()]);
  assert.deepEqual(cold(h, 'skill_install', args, 'cold-install'), installed);
  assert.deepEqual(jsonFiles(h.stateDir).map(item => [item.path, item.bytes.toString()]), records);
  const binding = { resource_id: resource.resourceId }, bound = cold(h, 'skill_bind_agent', binding, 'cold-bind');
  assert.equal(bound.status, 'ok', JSON.stringify(bound)); assert.equal(bound.content.revision, 2); assert.equal(bound.content.effective_from, 'next_run');
  assert.deepEqual(await h.agents.getRevision(h.first.metadata.id, 1), h.first);
  const current = await h.agents.get(h.first.metadata.id);
  assert.deepEqual(current.spec.bindings.skills, [{ resourceId: resource.resourceId, enabled: true }]);
  const pointer = statSync(join(h.root, 'agents', `${h.first.metadata.id}.json`));
  const revision = statSync(join(h.root, 'agents/revisions', h.first.metadata.id, '2.json'));
  assert.notEqual(pointer.ino, revision.ino, 'editable pointer cannot mutate immutable revision through a shared inode');
  const again = cold(h, 'skill_bind_agent', binding, 'new-bind-call'); assert.equal(again.content.already_bound, true);
  assert.equal((await h.agents.listRevisions(h.first.metadata.id)).length, 2); assert.equal(h.inspections, 1);
});

test('1000-file inspection with a 9MiB binary survives cold installation using small v2 indexes and verified raw blobs', async t => {
  const h = await setup(t), source = snapshot(), files = source.candidates[0].files;
  const large = Buffer.alloc(9 * 1024 * 1024 + 1, 0xff);
  files.push({ path: 'assets/large.bin', bytes: large }, { path: 'scripts/review.SH', bytes: Buffer.from('exit 99') });
  for (let i = files.length; i < 1000; i++) files.push({ path: `assets/file-${i}.txt`, bytes: Buffer.from('immutable shared bytes') });
  files.push({ path: 'node_modules/ignored.js', bytes: large }, { path: 'dist/SKILL.md', bytes: manifest('excluded') });
  files[0].bytes = Buffer.concat([files[0].bytes, Buffer.from('\nUse CURL https://example.test for network access')]);
  h.source(source); const inspection = await h.inspect(), candidate = inspection.candidates[0];
  assert.equal(candidate.fileCount, 1000); assert.ok(candidate.totalBytes > 9 * 1024 * 1024);
  assert.equal(candidate.status, 'ready'); assert.deepEqual(candidate.risk, { containsScripts: true,
    scripts: ['scripts/review.SH'], networkMarkers: ['https://', 'curl ', 'network'], requiresReview: true });
  const records = jsonFiles(h.stateDir), index = records.find(item => item.value.token === inspection.inspectionToken);
  assert.equal(index.value.snapshot.storageContract, 'agentkit.skill-inspection-blobs/v2');
  assert.ok(records.every(record => record.bytes.length < 1024 * 1024), 'raw resources must not expand JSON records');
  assert.ok(records.every(record => !record.bytes.includes(Buffer.from('"body":'))));
  const result = cold(h, 'skill_install', { inspection_token: inspection.inspectionToken, candidate_id: candidate.candidateId }, 'large-cold', { timeoutMs: 60000 });
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const path = await h.skillDiscovery.resolveInstalled(result.content.installed_resource.resourceId);
  assert.deepEqual(readFileSync(join(path, 'assets/large.bin')), large);
  assert.equal(readdirSync(path, { recursive: true }).filter(file => statSync(join(path, file)).isFile()).length, 1000);
  assert.equal(readdirSync(path).includes('node_modules'), false); assert.equal(readdirSync(path).includes('dist'), false);
  assert.equal(h.inspections, 1);
});

test('invalid candidates remain visible for review but cannot be installed alongside a healthy sibling', async t => {
  const h = await setup(t), source = snapshot();
  source.candidates.push({ candidateId: 'bad', path: 'bad', status: 'invalid', files: [],
    diagnostics: [{ code: 'skill_github_manifest_invalid', message: 'untrusted secret must not be echoed' }] });
  h.source(source); const inspection = await h.inspect(), invalid = inspection.candidates.find(item => item.candidateId === 'bad');
  assert.equal(invalid.status, 'invalid'); assert.deepEqual(invalid.risk, { requiresReview: true });
  assert.equal(JSON.stringify(invalid).includes('untrusted secret'), false);
  const result = cold(h, 'skill_install', { inspection_token: inspection.inspectionToken,
    candidate_ids: inspection.candidates.map(item => item.candidateId) }, 'partial-cold');
  assert.equal(result.status, 'error'); assert.equal(result.content.installed.length, 1);
  assert.deepEqual(result.content.failures, [{ candidate_id: 'bad', ok: false, error_type: 'skill_management_candidate_invalid' }]);
  assert.equal((await h.skillDiscovery.listInstalled()).total, 1);
});

for (const corrupt of ['blob', 'detail']) test(`corrupted cached ${corrupt} never publishes an installed resource`, async t => {
  const h = await setup(t), inspection = await h.inspect(), records = jsonFiles(h.stateDir);
  const index = records.find(item => item.value.token === inspection.inspectionToken);
  const detail = records.find(item => item.value.candidateId === inspection.candidates[0].candidateId);
  const path = corrupt === 'detail' ? detail.path
    : join(dirname(index.path), '..', 'blobs', detail.value.files[0].sha256);
  writeFileSync(path, corrupt === 'detail' ? JSON.stringify({ ...detail.value, version: '9.9.9' }) : Buffer.from('tampered bytes'));
  await assert.rejects(h.management.execute('skill_install', { inspection_token: inspection.inspectionToken,
    candidate_id: inspection.candidates[0].candidateId }, { signal: new AbortController().signal, assertCurrent: () => true }),
  { code: 'skill_management_inspection_invalid' });
  assert.equal((await h.skillDiscovery.listInstalled()).total, 0);
});

for (const boundary of ['candidate', 'repository']) test(`${boundary} byte limit counts logical files despite deduplicated storage and never publishes a token`, async t => {
  const h = await setup(t), source = snapshot(), bytes = Buffer.alloc(9 * 1024 * 1024, 0xab);
  source.candidates = Array.from({ length: boundary === 'candidate' ? 1 : 3 }, (_, index) => ({
    candidateId: `candidate-${index}`, path: `skill-${index}`, files: [{ path: 'SKILL.md', bytes: manifest(`skill-${index}`) },
      ...Array.from({ length: boundary === 'candidate' ? 12 : 8 }, (_, file) => ({ path: `asset-${file}`, bytes }))],
  }));
  h.source(source); const result = await h.invoke('skill_discover_github', { source: 'https://github.com/owner/repo' });
  assert.equal(result.status, 'uncertain');
  assert.equal(jsonFiles(h.stateDir).filter(item => item.value.token).length, 0);
  assert.equal((await h.skillDiscovery.listInstalled()).total, 0);
});

test('known same-name conflict is partial; explicit overwrite keeps older resource bytes and bindings valid', async t => {
  const h = await setup(t), first = await h.inspect();
  const install = inspection => h.invoke('skill_install', { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId });
  const original = await install(first); assert.equal(original.status, 'ok');
  const oldId = original.content.installed_resource.resourceId, oldPath = await h.skillDiscovery.resolveInstalled(oldId), before = readFileSync(join(oldPath, 'SKILL.md'));
  await h.invoke('skill_bind_agent', { resource_id: oldId });
  h.source(snapshot('b'.repeat(40))); const second = await h.inspect(), conflict = await install(second);
  assert.equal(conflict.status, 'error'); assert.equal(conflict.content.failures[0].error_type, 'SKILL_ALREADY_EXISTS');
  const replacement = await h.invoke('skill_install', { inspection_token: second.inspectionToken, candidate_id: second.candidates[0].candidateId, overwrite: true });
  assert.equal(replacement.status, 'ok'); assert.notEqual(replacement.content.installed_resource.resourceId, oldId);
  assert.equal((await h.skillDiscovery.listInstalled()).total, 2); assert.deepEqual(readFileSync(join(oldPath, 'SKILL.md')), before);
  assert.equal((await h.agents.get(h.first.metadata.id)).spec.bindings.skills[0].resourceId, oldId);
});

test('policy denial and malformed calls have no inspection or durable execution effect; exact approval identity is preserved', async t => {
  const h = await setup(t); h.policy('read-only'); h.approval(async () => 'rejected');
  const args = { source: 'https://github.com/owner/repo' }, invocation = h.exec('skill_discover_github', args);
  assert.equal((await h.invoke(invocation.name, args, invocation)).content.error_type, 'STUDIO_NATIVE_PERMISSION_DENIED');
  assert.equal(h.inspections, 0); assert.equal(jsonFiles(h.stateDir).length, 0);
  let approved = 0; h.approval(async input => { approved++; assert.equal(input.agent, invocation.agent); assert.equal(input.callId, invocation.callId); return 'allowed-once'; });
  assert.equal((await h.invoke(invocation.name, args, invocation)).status, 'ok'); assert.equal(approved, 1);
  const count = jsonFiles(h.stateDir).length;
  assert.equal((await h.invoke('skill_install', { inspection_token: 'bad' })).status, 'error');
  assert.equal(jsonFiles(h.stateDir).length, count);
});

test('revision, Build, session and original argument drift cannot reuse one accepted call', async t => {
  const h = await setup(t), args = { source: 'https://github.com/owner/repo' }, invocation = h.exec('skill_discover_github', args);
  assert.equal((await h.invoke(invocation.name, args, invocation)).status, 'ok');
  for (const overrides of [{ agentRevision: 2 }, { buildId: 'build-2' }]) {
    assert.equal((await h.invoke(invocation.name, args, h.exec(invocation.name, args, { callId: invocation.callId }), h.create(overrides))).content.error_type,
      'dsh_node_command_call_identity_conflict');
  }
  const changed = { source: args.source, ref: 'other' };
  assert.equal((await h.invoke(invocation.name, changed, h.exec(invocation.name, changed, { callId: invocation.callId }))).content.error_type, 'dsh_node_command_call_identity_conflict');
  assert.equal(h.inspections, 1);
});

for (const cause of ['cancel', 'retire', 'authority']) test(`noncooperative discovery ${cause} cannot publish late snapshot or replay`, async t => {
  const h = await setup(t); let enter, deliver;
  const entered = new Promise(resolve => { enter = resolve; }), response = new Promise(resolve => { deliver = resolve; });
  const management = createStudioSkillManagement({ ...h.options, source: { search: async () => ({}), inspect: () => { enter(); return response; } } });
  const owner = h.create({ management }), controller = new AbortController(), args = { source: 'https://github.com/owner/repo' };
  const invocation = h.exec('skill_discover_github', args, { signal: controller.signal }), pending = h.invoke(invocation.name, args, invocation, owner);
  await entered;
  if (cause === 'cancel') controller.abort();
  if (cause === 'retire') void owner.close();
  if (cause === 'authority') invocation.callId = 'forged';
  // A drifted authority is checked at the next boundary; cancellation/retirement settle even without a cooperative transport.
  if (cause === 'authority') deliver(snapshot());
  const result = await pending; assert.equal(result.status, 'uncertain', JSON.stringify(result));
  deliver(snapshot()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(jsonFiles(h.stateDir).filter(item => item.value.token).length, 0);
  const retry = h.exec('skill_discover_github', args, { callId: 'call-1' });
  assert.deepEqual(await h.invoke(retry.name, args, retry, h.create()), result);
});

for (const operation of ['install', 'bind']) test(`actual SIGKILL after Skill ${operation} publication never repeats unknown effects in a cold Node PID`, { timeout: 25000 }, async t => {
  const h = await setup(t), inspection = await h.inspect();
  const installArgs = { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId };
  let args = installArgs;
  if (operation === 'bind') {
    const installed = await h.invoke('skill_install', installArgs); assert.equal(installed.status, 'ok'); args = { resource_id: installed.content.installed_resource.resourceId };
  }
  const name = operation === 'bind' ? 'skill_bind_agent' : 'skill_install', callId = `crash-${operation}`;
  const child = fork(new URL('./fixtures/skill-management-owner.mjs', import.meta.url), [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  const published = Promise.race([once(child, 'message'), once(child, 'exit').then(() => assert.fail(errors || 'child exited before publication'))]);
  child.stdin.end(JSON.stringify({ root: h.root, agentId: h.first.metadata.id, name, args, callId, killAfterEffect: true }));
  assert.equal((await published)[0].published, true); const exited = once(child, 'exit'); child.kill('SIGKILL');
  assert.equal((await exited)[1], 'SIGKILL');
  const before = jsonFiles(h.root).map(item => [item.path, item.bytes.toString()]);
  const result = cold(h, name, args, callId); assert.equal(result.status, 'uncertain'); assert.equal(result.content.evidence_incomplete, true);
  assert.deepEqual(jsonFiles(h.root).map(item => [item.path, item.bytes.toString()]), before);
  assert.equal((await h.skillDiscovery.listInstalled()).total, 1);
  assert.equal((await h.agents.get(h.first.metadata.id)).metadata.revision, operation === 'bind' ? 2 : 1);
});

test('owner-store failure after Agent publication remains uncertain and cannot be reported executed:false or replayed', async t => {
  const h = await setup(t), inspection = await h.inspect();
  const installed = await h.invoke('skill_install', { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId });
  const args = { resource_id: installed.content.installed_resource.resourceId }, invocation = h.exec('skill_bind_agent', args);
  let affected;
  const management = { ...h.management, execute: async (...input) => {
    const result = await h.management.execute(...input);
    affected = dirname(jsonFiles(h.stateDir).find(item => item.value.request?.call?.callId === invocation.callId).path);
    chmodSync(affected, 0o755); return result;
  } };
  const result = await h.invoke(invocation.name, args, invocation, h.create({ management }));
  assert.equal(result.status, 'uncertain'); assert.equal(Object.hasOwn(result.content, 'executed'), false);
  assert.equal((await h.agents.get(h.first.metadata.id)).metadata.revision, 2);
  chmodSync(affected, 0o700);
  const coldResult = cold(h, invocation.name, args, invocation.callId); assert.equal(coldResult.status, 'uncertain');
  assert.equal((await h.agents.listRevisions(h.first.metadata.id)).length, 2);
});

test('different Agents keep inspection tokens private but share identical immutable installed content', async t => {
  const h = await setup(t), inspection = await h.inspect();
  const installed = await h.invoke('skill_install', { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId });
  const other = await h.agents.create({ name: 'other', runtimeType: 'codex' });
  const manager = createStudioSkillManagement({ ...h.options, agentId: other.metadata.id, source: { search: async () => ({}), inspect: async () => snapshot() } });
  const request = { signal: new AbortController().signal, assertCurrent: () => true };
  await assert.rejects(manager.execute('skill_install', { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId }, request), { code: 'ENOENT' });
  const own = await manager.execute('skill_discover_github', { source: 'https://github.com/owner/repo' }, request);
  const again = await manager.execute('skill_install', { inspection_token: own.inspectionToken, candidate_id: own.candidates[0].candidateId }, request);
  assert.equal(again.ok, true); assert.deepEqual(again.installed_resource, installed.content.installed_resource);
  assert.equal((await h.skillDiscovery.listInstalled()).total, 1);
  assert.equal((await h.agents.get(other.metadata.id)).metadata.revision, 1);
});

test('two independent Node Hosts publish different Skills concurrently without losing either catalog entry', { timeout: 25000 }, async t => {
  const h = await setup(t), first = await h.inspect(); h.source(snapshot('b'.repeat(40), 'second-skill')); const second = await h.inspect();
  function start(inspection, callId) {
    const child = fork(new URL('./fixtures/skill-management-owner.mjs', import.meta.url), [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = '', errors = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    const ready = once(child, 'message'), exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ root: h.root, agentId: h.first.metadata.id, name: 'skill_install', callId, waitForGo: true,
      args: { inspection_token: inspection.inspectionToken, candidate_id: inspection.candidates[0].candidateId } }));
    return { child, ready, result: exited.then(([code]) => { assert.equal(code, 0, errors); return JSON.parse(output); }) };
  }
  const a = start(first, 'parallel-a'), b = start(second, 'parallel-b');
  await Promise.all([a.ready, b.ready]); a.child.send('go'); b.child.send('go');
  const results = await Promise.all([a.result, b.result]); assert.notEqual(results[0].pid, results[1].pid);
  assert.ok(results.every(value => value.result.status === 'ok'), JSON.stringify(results));
  assert.deepEqual((await h.skillDiscovery.listInstalled()).items.map(item => item.name).sort(), ['fixed-skill', 'second-skill']);
});
