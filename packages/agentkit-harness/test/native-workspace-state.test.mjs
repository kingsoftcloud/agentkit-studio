import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';

function baseSetup() {
  const base = mkdtempSync(join(tmpdir(), 'nws-state-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  return { base, workspaceRoot, stateDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function makeCall(tools, sessionId) {
  let seq = 0;
  return (name, args, { signal, interaction } = {}) => tools.execute({
    call: { callId: `c-${name}-${++seq}`, name, arguments: args },
    definition: tools.definitions.find((d) => d.name === name),
    operationKey: `op-${name}`,
    signal: signal || new AbortController().signal,
    sessionId,
    interaction,
  });
}

test('read state is persisted and survives an instance restart', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'hello\n');
    const tools1 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call1 = makeCall(tools1, 's1');
    // read records the revision to disk
    const read = await call1('read_workspace_file', { path: 'a.txt' });
    assert.equal(read.status, 'ok');
    assert.ok(existsSync(join(stateDir, 's1', 'read-state.json')));
    // simulate a restart: a brand new instance with the same stateDir + sessionId
    const tools2 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call2 = makeCall(tools2, 's1');
    const edit = await call2('edit_workspace_file', { path: 'a.txt', old_text: 'hello', new_text: 'world' });
    assert.equal(edit.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'world\n');
  } finally { cleanup(); }
});

test('without persisted state a restart rejects edits as unread', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'hello\n');
    // a fresh instance that never read the file cannot edit it
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call = makeCall(tools, 's1');
    const edit = await call('edit_workspace_file', { path: 'a.txt', old_text: 'hello', new_text: 'world' });
    assert.equal(edit.status, 'error');
    assert.equal(edit.content.error_type, 'file_not_read');
  } finally { cleanup(); }
});

test('read state is isolated per session', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'orig\n');
    const toolsA = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'A', authorize: async () => 'allow' });
    const toolsB = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'B', authorize: async () => 'allow' });
    const callA = makeCall(toolsA, 'A');
    const callB = makeCall(toolsB, 'B');
    await callA('read_workspace_file', { path: 'a.txt' });
    // session B never read the file in its own state directory
    const editB = await callB('edit_workspace_file', { path: 'a.txt', old_text: 'orig', new_text: 'B' });
    assert.equal(editB.status, 'error');
    assert.equal(editB.content.error_type, 'file_not_read');
    // session A can still edit using its own recorded state
    const editA = await callA('edit_workspace_file', { path: 'a.txt', old_text: 'orig', new_text: 'A' });
    assert.equal(editA.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'A\n');
    // state files live in separate per-session directories
    assert.ok(existsSync(join(stateDir, 'A', 'read-state.json')));
    assert.ok(!existsSync(join(stateDir, 'B', 'read-state.json')));
  } finally { cleanup(); }
});

test('pending approvals are persisted and can be approved after a restart', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    // default authorize returns approval_required for mutating tools
    const tools1 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const wreq = await tools1.execute({
      call: { callId: 'cw', name: 'write_workspace_file', arguments: { path: 'x.txt', content: 'y\n' } },
      definition: tools1.definitions.find((d) => d.name === 'write_workspace_file'),
      operationKey: 'op', signal: new AbortController().signal, sessionId: 's1',
    });
    assert.equal(wreq.status, 'approval_required');
    assert.ok(wreq.interactionId);
    assert.ok(existsSync(join(stateDir, 's1', 'pending-approvals.json')));
    // restart: a new instance loads the persisted pending approval
    const tools2 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const approved = await tools2.execute({
      call: { callId: 'cw', name: 'write_workspace_file', arguments: { path: 'x.txt', content: 'y\n' } },
      definition: tools2.definitions.find((d) => d.name === 'write_workspace_file'),
      operationKey: 'op', signal: new AbortController().signal, sessionId: 's1',
      interaction: { interactionId: wreq.interactionId, callId: 'cw', decision: 'approve' },
    });
    assert.equal(approved.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'x.txt'), 'utf-8'), 'y\n');
  } finally { cleanup(); }
});

test('pending approvals are isolated per session and cannot be cross-approved', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const toolsA = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'A' });
    const wreq = await toolsA.execute({
      call: { callId: 'cw', name: 'write_workspace_file', arguments: { path: 'x.txt', content: 'y\n' } },
      definition: toolsA.definitions.find((d) => d.name === 'write_workspace_file'),
      operationKey: 'op', signal: new AbortController().signal, sessionId: 'A',
    });
    assert.equal(wreq.status, 'approval_required');
    // session B cannot use session A's interactionId
    const toolsB = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 'B' });
    const cross = await toolsB.execute({
      call: { callId: 'cw', name: 'write_workspace_file', arguments: { path: 'x.txt', content: 'y\n' } },
      definition: toolsB.definitions.find((d) => d.name === 'write_workspace_file'),
      operationKey: 'op', signal: new AbortController().signal, sessionId: 'B',
      interaction: { interactionId: wreq.interactionId, callId: 'cw', decision: 'approve' },
    });
    assert.equal(cross.status, 'error');
    assert.equal(cross.content.code, 'interaction_unknown_or_expired');
  } finally { cleanup(); }
});

test('persisted read state is keyed by relative path and round-trips mtime/size/sha', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'content\n');
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call = makeCall(tools, 's1');
    await call('read_workspace_file', { path: 'a.txt' });
    const raw = JSON.parse(readFileSync(join(stateDir, 's1', 'read-state.json'), 'utf-8'));
    assert.equal(raw.version, 'native-workspace-read-state/v1');
    assert.equal(raw.sessionId, 's1');
    const entry = raw.entries['a.txt'];
    assert.ok(entry);
    assert.equal(entry.path, 'a.txt');
    assert.equal(entry.canonicalPath, realpathSync(join(workspaceRoot, 'a.txt')));
    assert.equal(entry.partial, false);
    assert.equal(typeof entry.mtimeNs, 'string'); // BigInt serialized as string
    assert.match(entry.contentSha256, /^[0-9a-f]{64}$/);
  } finally { cleanup(); }
});
