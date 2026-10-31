import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeWorkspaceContextBinding, admitNativeWorkspaceContext, ensureNativeWorkspaceContext, validateNativeWorkspaceContext } from '../src/native/workspace-context.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-workspace-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const execution = join(root, 'execution'), storage = join(root, 'session-storage');
  await mkdir(execution); await mkdir(storage);
  let cwd = storage, changes = 0;
  const binding = nativeWorkspaceContextBinding(execution), signal = new AbortController().signal;
  const directory = { get: () => cwd, set: async value => { changes++; cwd = value; }, ensure: async () => cwd };
  return { binding, directory, signal, execution, storage, changes: () => changes, current: () => cwd };
}

test('context discovery is aligned to the execution workspace rather than the Session storage directory', async t => {
  const f = await fixture(t);
  await ensureNativeWorkspaceContext(f);
  assert.equal(f.current(), f.binding.workspaceRoot); assert.equal(f.changes(), 1);
});

test('initial context provenance remains frozen after the execution owner aligns the Session directory', async t => {
  const f = await fixture(t), admitted = admitNativeWorkspaceContext(f.binding, f.directory);
  assert.notEqual(admitted.sourceRoot, admitted.workspaceRoot);
  await ensureNativeWorkspaceContext({ ...f, binding: admitted });
  assert.equal(f.current(), admitted.workspaceRoot);
  assert.notEqual(admitted.sourceRoot, admitted.workspaceRoot);
  assert.equal(Object.hasOwn(f.binding, 'sourceRoot'), false);
});

test('an aligned directory and directory aliases do not emit extra transitions', async t => {
  const f = await fixture(t), alias = join(f.storage, 'alias');
  await symlink(f.execution, alias);
  await ensureNativeWorkspaceContext({ ...f, directory: { ...f.directory, get: () => alias } });
  assert.equal(f.changes(), 0);
  await f.directory.set(f.binding.workspaceRoot);
  await ensureNativeWorkspaceContext(f); assert.equal(f.changes(), 1);
});

test('historical absence invokes no new Host directory capability', async () => {
  await ensureNativeWorkspaceContext({ binding: undefined });
});

test('a disappeared Session directory can recover to the still-bound execution root', async t => {
  const f = await fixture(t);
  const directory = { ...f.directory, get: () => join(f.storage, 'deleted-session-directory') };
  await ensureNativeWorkspaceContext({ ...f, directory });
  assert.equal(f.current(), f.binding.workspaceRoot); assert.equal(f.changes(), 1);
});

test('context owner refusal and cancellation stop preparation without calling mutation tools', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureNativeWorkspaceContext({ ...f,
    directory: { ...f.directory, set: async () => { throw Error('Host refused context binding'); } } }), /Host refused/);
  const abort = new AbortController(); abort.abort(Error('Canceled before preparation'));
  await assert.rejects(ensureNativeWorkspaceContext({ ...f, signal: abort.signal }), /Canceled before preparation/);
  assert.equal(f.changes(), 0);
});

test('a context owner that changes the target cannot silently redirect scoped instructions', async t => {
  const f = await fixture(t);
  await assert.rejects(ensureNativeWorkspaceContext({ ...f,
    directory: { ...f.directory, ensure: async () => f.storage } }), /directory_changed/);
});

test('a context binding cannot contain permissions or relative execution paths', async t => {
  const f = await fixture(t);
  assert.throws(() => validateNativeWorkspaceContext({ ...f.binding, permissions: ['filesystem:*'] }), /binding_invalid/);
  assert.throws(() => validateNativeWorkspaceContext({ ...f.binding, workspaceRoot: 'relative' }), /binding_invalid/);
});
