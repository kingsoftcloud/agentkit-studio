import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { sessionKeyFor } from '../src/native/workspace-state.mjs';
import { createHash } from 'node:crypto';

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
    assert.ok(existsSync(join(stateDir, sessionKeyFor('s1'), 'read-state.json')));
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

test('conversation rewind drops removed-branch read authority, but keeps fresh reads across cold continuation', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'original\n');
    const options = { workspaceRoot, stateDir, sessionId: 'rewind', authorize: async () => 'allow' };
    const before = createNativeWorkspaceTools(options);
    assert.equal((await makeCall(before, 'rewind')('read_workspace_file', { path: 'a.txt' })).status, 'ok');
    const branch = { commandId: 'first-rewind', generation: 1 };
    const after = createNativeWorkspaceTools(options), call = makeCall(after, 'rewind');
    after.adoptConversationBranch(branch);
    const removedRead = await call('edit_workspace_file', { path: 'a.txt', old_text: 'original', new_text: 'wrong' });
    assert.equal(removedRead.status, 'error'); assert.equal(removedRead.content.error_type, 'file_not_read');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf8'), 'original\n');
    assert.equal((await call('read_workspace_file', { path: 'a.txt' })).status, 'ok');
    const cold = createNativeWorkspaceTools(options), coldCall = makeCall(cold, 'rewind');
    cold.adoptConversationBranch(branch);
    assert.equal((await coldCall('edit_workspace_file', { path: 'a.txt', old_text: 'original', new_text: 'fresh' })).status, 'ok');
    cold.adoptConversationBranch({ commandId: 'root-rewind', generation: 2 });
    const rooted = await coldCall('edit_workspace_file', { path: 'a.txt', old_text: 'fresh', new_text: 'wrong' });
    assert.equal(rooted.content.error_type, 'file_not_read');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf8'), 'fresh\n');
  } finally { cleanup(); }
});

test('conversation read state fences stale and competing generations without clearing current reads', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'original');
    const options = { workspaceRoot, stateDir, sessionId: 'rewind', authorize: async () => 'allow' };
    const tools = createNativeWorkspaceTools(options), call = makeCall(tools, 'rewind');
    tools.adoptConversationBranch({ commandId: 'current', generation: 2 });
    await call('read_workspace_file', { path: 'a.txt' });
    for (const branch of [{ commandId: 'old', generation: 1 }, { commandId: 'different', generation: 2 }])
      assert.throws(() => tools.adoptConversationBranch(branch), { code: 'workspace_read_branch_conflict' });
    assert.throws(() => tools.adoptConversationBranch({ commandId: 'invalid', generation: 0 }), { code: 'workspace_read_branch_invalid' });
    assert.equal((await call('edit_workspace_file', { path: 'a.txt', old_text: 'original', new_text: 'current' })).status, 'ok');
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, sessionKeyFor('rewind'), 'read-state.json'), 'utf8')).conversationBranch,
      { commandId: 'current', generation: 2 });
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
    // state files live in separate per-session directories keyed by a sha256
    // digest of the session id, so neither session's directory can collide
    // with or traverse into the other's.
    assert.ok(existsSync(join(stateDir, sessionKeyFor('A'), 'read-state.json')));
    assert.ok(!existsSync(join(stateDir, sessionKeyFor('B'), 'read-state.json')));
    assert.notEqual(sessionKeyFor('A'), sessionKeyFor('B'));
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
    assert.ok(existsSync(join(stateDir, sessionKeyFor('s1'), 'pending-approvals.json')));
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

test('persisted read state is keyed by relative path and round-trips mtime/size/sha with correct numeric window fields', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'line1\nline2\nline3\nline4\n');
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call = makeCall(tools, 's1');
    // a partial read exercises the startLine/endLine/totalLines fields that were
    // previously serialized as null due to a snake_case/camelCase mismatch
    await call('read_workspace_file', { path: 'a.txt', start_line: 2, end_line: 3 });
    const raw = JSON.parse(readFileSync(join(stateDir, sessionKeyFor('s1'), 'read-state.json'), 'utf-8'));
    assert.equal(raw.version, 'native-workspace-read-state/v1');
    assert.equal(raw.sessionId, 's1');
    const entry = raw.entries['a.txt'];
    assert.ok(entry);
    assert.equal(entry.path, 'a.txt');
    assert.equal(entry.canonicalPath, realpathSync(join(workspaceRoot, 'a.txt')));
    assert.equal(entry.partial, true);
    assert.equal(typeof entry.mtimeNs, 'string'); // BigInt serialized as string
    assert.match(entry.contentSha256, /^[0-9a-f]{64}$/);
    // the read window must round-trip as real numbers, not null/NaN
    assert.equal(entry.startLine, 2);
    assert.equal(entry.endLine, 3);
    assert.equal(entry.totalLines, 4);
    // after a restart, the persisted window is still correct and a full re-read
    // (which overwrites the partial state) reports partial=false end-to-end
    const tools2 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const call2 = makeCall(tools2, 's1');
    await call2('read_workspace_file', { path: 'a.txt' });
    const raw2 = JSON.parse(readFileSync(join(stateDir, sessionKeyFor('s1'), 'read-state.json'), 'utf-8'));
    const entry2 = raw2.entries['a.txt'];
    assert.equal(entry2.partial, false);
    assert.equal(entry2.startLine, 1);
    assert.equal(entry2.endLine, 4);
    assert.equal(entry2.totalLines, 4);
  } finally { cleanup(); }
});
