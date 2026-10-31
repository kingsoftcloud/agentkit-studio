import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { WorkspaceStateStore, sessionKeyFor } from '../src/native/workspace-state.mjs';
import { publishWorkspaceBytes } from '../src/native/workspace-paths.mjs';

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'native-workspace-review-')), workspaceRoot = join(base, 'workspace'), stateDir = join(base, 'state');
  mkdirSync(workspaceRoot); t.after(() => rmSync(base, { recursive: true, force: true }));
  const create = sessionId => createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId, authorize: async () => 'allow' });
  const execute = (tools, name, args, sessionId = 'session') => tools.execute({ call: { callId: name, name, arguments: args }, sessionId,
    definition: tools.definitions.find(definition => definition.name === name), operationKey: name, signal: new AbortController().signal });
  return { workspaceRoot, stateDir, create, execute, readState: join(stateDir, sessionKeyFor('session'), 'read-state.json') };
}

test('successful create-only publication leaves one target link and no temporary sibling', t => {
  const { workspaceRoot } = setup(t), target = join(workspaceRoot, 'created.txt');
  publishWorkspaceBytes(target, Buffer.from('complete'), { createOnly: true });
  assert.deepEqual(readdirSync(workspaceRoot), ['created.txt']); assert.equal(statSync(target).nlink, 1);
  assert.equal(readFileSync(target, 'utf8'), 'complete');
});

test('corrupt persisted read entries are individually rejected without losing another valid read', async t => {
  const { workspaceRoot, readState, create, execute } = setup(t), tools = create('session');
  for (const path of ['good.txt', 'bad.txt']) {
    writeFileSync(join(workspaceRoot, path), 'original\n');
    assert.equal((await execute(tools, 'read_workspace_file', { path })).status, 'ok');
  }
  const original = JSON.parse(readFileSync(readState, 'utf8'));
  for (const invalid of [null, { mtimeNs: null }, { startLine: null }, { partial: null }, { endLine: 0 },
    { contentSha256: 'not a digest' }, { sizeBytes: -1 }, { path: 'another.txt' }]) {
    const payload = structuredClone(original);
    payload.entries['bad.txt'] = invalid === null ? null : { ...payload.entries['bad.txt'], ...invalid };
    writeFileSync(readState, JSON.stringify(payload));
    const store = new WorkspaceStateStore(join(readState, '..', '..'), 'session');
    assert.ok(store.getReadState('good.txt')); assert.equal(store.getReadState('bad.txt'), undefined);
    const rejected = await execute(create('session'), 'write_workspace_file', { path: 'bad.txt', content: 'must not write' });
    assert.equal(rejected.status, 'error'); assert.equal(rejected.content.error_type, 'file_not_read');
    assert.equal(readFileSync(join(workspaceRoot, 'bad.txt'), 'utf8'), 'original\n');
  }
});

test('an empty file remains a valid complete read after restart', async t => {
  const { workspaceRoot, create, execute } = setup(t); writeFileSync(join(workspaceRoot, 'empty.txt'), '');
  assert.equal((await execute(create('session'), 'read_workspace_file', { path: 'empty.txt' })).content.partial, false);
  const result = await execute(create('session'), 'write_workspace_file', { path: 'empty.txt', content: 'new' });
  assert.equal(result.status, 'ok'); assert.equal(readFileSync(join(workspaceRoot, 'empty.txt'), 'utf8'), 'new');
});

test('invalid session identities cannot alias the default session and requests cannot use another session port', async t => {
  const { create, execute } = setup(t);
  for (const id of ['', '  ', 0, false, null]) assert.throws(() => create(id), /sessionId must be a nonempty string/);
  const tools = create('session');
  const result = await execute(tools, 'workspace_status', {}, 'another');
  assert.equal(result.content.code, 'workspace_session_mismatch');
  assert.equal((await tools.observe({ sessionId: 'another' })).reason, 'workspace_session_mismatch');
});

test('persisted session identities and incomplete approval records are checked on reload', async t => {
  const { stateDir } = setup(t), store = new WorkspaceStateStore(stateDir, 'session');
  const pending = store.addPending({ callId: 'call', name: 'write', argumentsDigest: 'a'.repeat(64) });
  const path = join(stateDir, sessionKeyFor('session'), 'pending-approvals.json'), original = JSON.parse(readFileSync(path, 'utf8'));
  for (const invalid of [{ expiresAt: 'unknown' }, { createdAt: null }, { interactionId: 'different' }, { argumentsDigest: null }]) {
    const payload = structuredClone(original); Object.assign(payload.entries[pending.interactionId], invalid);
    writeFileSync(path, JSON.stringify(payload));
    assert.equal(new WorkspaceStateStore(stateDir, 'session').getPending(pending.interactionId), undefined);
  }
  original.sessionId = 'different'; writeFileSync(path, JSON.stringify(original));
  assert.equal(new WorkspaceStateStore(stateDir, 'session').getPending(pending.interactionId), undefined);
});
