import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'nws-sec-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
  let seq = 0;
  const call = (name, args) => tools.execute({
    call: { callId: `c-${name}-${++seq}`, name, arguments: args },
    definition: tools.definitions.find((d) => d.name === name),
    operationKey: `op-${name}`,
    signal: new AbortController().signal,
    sessionId: 's1',
  });
  return { base, workspaceRoot, call, tools, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('read_workspace_file rejects parent-directory traversal', async () => {
  const { call, base, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(base, 'secret.txt'), 'private');
    writeFileSync(join(workspaceRoot, 'a.txt'), 'ok\n');
    const r = await call('read_workspace_file', { path: '../secret.txt' });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'path_escape');
    // a normalized inward '..' that stays inside is allowed
    mkdirSync(join(workspaceRoot, 'sub'), { recursive: true });
    const inward = await call('read_workspace_file', { path: 'sub/../a.txt' });
    assert.equal(inward.status, 'ok');
    assert.equal(inward.content.content, '1 | ok');
  } finally { cleanup(); }
});

test('write_workspace_file rejects traversal and never creates files outside the root', async () => {
  const { call, base, workspaceRoot, cleanup } = setup();
  try {
    const r = await call('write_workspace_file', { path: '../escape.txt', content: 'x\n' });
    assert.equal(r.status, 'error');
    assert.equal(r.content.error_type, 'path_escape');
    assert.equal(existsSync(join(base, 'escape.txt')), false);
  } finally { cleanup(); }
});

test('edit and delete reject traversal too', async () => {
  const { call, base, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(base, 'outside.txt'), 'x\n');
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x\n');
    await call('read_workspace_file', { path: 'a.txt' });
    const edit = await call('edit_workspace_file', { path: '../outside.txt', old_text: 'x', new_text: 'y' });
    assert.equal(edit.status, 'error');
    assert.equal(edit.content.error_type, 'path_escape');
    const del = await call('delete_workspace_file', { path: '../outside.txt' });
    assert.equal(del.status, 'error');
    assert.equal(del.content.error_type, 'path_escape');
    assert.equal(existsSync(join(base, 'outside.txt')), true);
  } finally { cleanup(); }
});

test('a symlink inside the workspace pointing outside is refused for read, write and delete', async () => {
  const { call, base, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(base, 'secret.txt'), 'do-not-disclose');
    symlinkSync(join(base, 'secret.txt'), join(workspaceRoot, 'link.txt'));
    const read = await call('read_workspace_file', { path: 'link.txt' });
    assert.equal(read.status, 'error');
    assert.equal(read.content.error_type, 'path_escape');
    const write = await call('write_workspace_file', { path: 'link.txt', content: 'x\n' });
    assert.equal(write.status, 'error');
    assert.equal(write.content.error_type, 'path_escape');
    // the outside secret must be untouched
    assert.equal(readFileSync(join(base, 'secret.txt'), 'utf-8'), 'do-not-disclose');
    const del = await call('delete_workspace_file', { path: 'link.txt' });
    assert.equal(del.status, 'error');
    assert.equal(del.content.error_type, 'path_escape');
  } finally { cleanup(); }
});

test('a symlinked directory pointing outside is refused for listing and nested reads', async () => {
  const { call, base, workspaceRoot, cleanup } = setup();
  try {
    mkdirSync(join(base, 'outside'), { recursive: true });
    writeFileSync(join(base, 'outside/leak.txt'), 'leak\n');
    symlinkSync(join(base, 'outside'), join(workspaceRoot, 'dir'));
    const list = await call('list_workspace_files', { path: 'dir' });
    assert.equal(list.status, 'error');
    assert.equal(list.content.error_type, 'path_escape');
    const nested = await call('read_workspace_file', { path: 'dir/leak.txt' });
    assert.equal(nested.status, 'error');
    assert.equal(nested.content.error_type, 'path_escape');
  } finally { cleanup(); }
});

test('a symlink that stays inside the workspace is followed', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'real.txt'), 'payload\n');
    symlinkSync(join(workspaceRoot, 'real.txt'), join(workspaceRoot, 'link.txt'));
    const r = await call('read_workspace_file', { path: 'link.txt' });
    assert.equal(r.status, 'ok');
    assert.equal(r.content.content, '1 | payload');
    // writing through the inside symlink updates the real target
    await call('read_workspace_file', { path: 'link.txt' });
    const w = await call('write_workspace_file', { path: 'link.txt', content: 'updated\n' });
    assert.equal(w.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'real.txt'), 'utf-8'), 'updated\n');
  } finally { cleanup(); }
});

test('delete_workspace_file refuses to delete the workspace root', async () => {
  const { call, workspaceRoot, cleanup } = setup();
  try {
    const r = await call('delete_workspace_file', { path: '.' });
    assert.equal(r.status, 'error');
    assert.match(r.content.error_message, /root/);
    assert.equal(existsSync(workspaceRoot), true);
  } finally { cleanup(); }
});

test('observe returns unavailable when the workspace root is missing', async () => {
  const { tools, base, cleanup } = setup();
  try {
    rmSync(join(base, 'workspace'), { recursive: true, force: true });
    const obs = await tools.observe({ operationKey: 'op', sessionId: 's1', signal: new AbortController().signal });
    assert.equal(obs.status, 'unavailable');
    assert.equal(obs.reason, 'workspace_missing');
    assert.equal(obs.revision, null);
  } finally { cleanup(); }
});

test('observe does not follow an escaping symlink and stays ok', async () => {
  const { tools, base, workspaceRoot, cleanup } = setup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x\n');
    writeFileSync(join(base, 'secret.txt'), 'secret');
    symlinkSync(join(base, 'secret.txt'), join(workspaceRoot, 'link.txt'));
    const obs = await tools.observe({ operationKey: 'op', sessionId: 's1', signal: new AbortController().signal });
    assert.equal(obs.status, 'ok');
    assert.match(obs.revision, /^sha256:/);
  } finally { cleanup(); }
});
