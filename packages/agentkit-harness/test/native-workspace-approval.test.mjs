import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';
import { sessionKeyFor } from '../src/native/workspace-state.mjs';
import { WorkspaceStateStore } from '../src/native/workspace-state.mjs';

function baseSetup() {
  const base = mkdtempSync(join(tmpdir(), 'nws-approval-'));
  const workspaceRoot = join(base, 'workspace');
  const stateDir = join(base, 'state');
  mkdirSync(workspaceRoot, { recursive: true });
  return { base, workspaceRoot, stateDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function req(tools, name, args, { sessionId = 's1', signal, interaction, callId = 'c1' } = {}) {
  return tools.execute({
    call: { callId, name, arguments: args },
    definition: tools.definitions.find((d) => d.name === name),
    operationKey: 'op',
    signal: signal || new AbortController().signal,
    sessionId,
    interaction,
  });
}

test('default authorize allows read-only tools without approval', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    writeFileSync(join(workspaceRoot, 'a.txt'), 'x\n');
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' }); // default authorize
    const read = await req(tools, 'read_workspace_file', { path: 'a.txt' });
    assert.equal(read.status, 'ok');
    const list = await req(tools, 'list_workspace_files', {});
    assert.equal(list.status, 'ok');
    const status = await req(tools, 'workspace_status', {});
    assert.equal(status.status, 'ok');
  } finally { cleanup(); }
});

test('default authorize requires approval for mutating tools and never mutates before approval', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' });
    assert.equal(w.status, 'approval_required');
    assert.ok(w.interactionId);
    assert.equal(w.content.code, 'approval_required');
    assert.equal(existsSync(join(workspaceRoot, 'x.txt')), false);
  } finally { cleanup(); }
});

test('custom authorize allow proceeds and deny blocks without mutating', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const allow = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const ok = await req(allow, 'write_workspace_file', { path: 'a.txt', content: 'z\n' });
    assert.equal(ok.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'a.txt'), 'utf-8'), 'z\n');
    const deny = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's2', authorize: async () => 'deny' });
    const blocked = await req(deny, 'write_workspace_file', { path: 'b.txt', content: 'z\n' }, { sessionId: 's2' });
    assert.equal(blocked.status, 'error');
    assert.equal(blocked.content.code, 'policy_denied');
    assert.equal(existsSync(join(workspaceRoot, 'b.txt')), false);
  } finally { cleanup(); }
});

test('a correct approval reply completes the mutation', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' });
    const approved = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'approve' },
    });
    assert.equal(approved.status, 'ok');
    assert.equal(readFileSync(join(workspaceRoot, 'x.txt'), 'utf-8'), 'y\n');
  } finally { cleanup(); }
});

test('approval is bound to the callId: a mismatched callId is rejected', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' });
    const mismatch = await tools.execute({
      call: { callId: 'other-call', name: 'write_workspace_file', arguments: { path: 'x.txt', content: 'y\n' } },
      definition: tools.definitions.find((d) => d.name === 'write_workspace_file'),
      operationKey: 'op', signal: new AbortController().signal, sessionId: 's1',
      interaction: { interactionId: w.interactionId, callId: 'other-call', decision: 'approve' },
    });
    assert.equal(mismatch.status, 'error');
    assert.equal(mismatch.content.code, 'interaction_binding_mismatch');
  } finally { cleanup(); }
});

test('an unknown interactionId is rejected as unknown or expired', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' });
    const bogus = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: 'not-a-real-id', callId: 'c1', decision: 'approve' },
    });
    assert.equal(bogus.status, 'error');
    assert.equal(bogus.content.code, 'interaction_unknown_or_expired');
    // the real interactionId still works (bogus did not consume it)
    const approved = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'approve' },
    });
    assert.equal(approved.status, 'ok');
  } finally { cleanup(); }
});

test('approval is bound to the arguments: changed arguments are rejected', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'v1\n' });
    const changed = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'DIFFERENT\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'approve' },
    });
    assert.equal(changed.status, 'error');
    assert.equal(changed.content.code, 'interaction_binding_mismatch');
    assert.equal(existsSync(join(workspaceRoot, 'x.txt')), false);
  } finally { cleanup(); }
});

test('a deny decision rejects the mutation and consumes the approval', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' });
    const denied = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'deny' },
    });
    assert.equal(denied.status, 'error');
    assert.equal(denied.content.code, 'policy_denied');
    assert.equal(existsSync(join(workspaceRoot, 'x.txt')), false);
    // the approval is consumed; a second attempt is unknown/expired
    const again = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'approve' },
    });
    assert.equal(again.status, 'error');
    assert.equal(again.content.code, 'interaction_unknown_or_expired');
  } finally { cleanup(); }
});

test('an unrecognized decision does not consume the approval and can be retried', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' });
    const unknown = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'maybe' },
    });
    assert.equal(unknown.status, 'error');
    assert.equal(unknown.content.code, 'interaction_binding_mismatch');
    const approved = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'approve' },
    });
    assert.equal(approved.status, 'ok');
  } finally { cleanup(); }
});

test('an approval interaction without a prior approval_required is rejected', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const r = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: 'never-issued', callId: 'c1', decision: 'approve' },
    });
    assert.equal(r.status, 'error');
    assert.equal(r.content.code, 'interaction_unknown_or_expired');
  } finally { cleanup(); }
});

test('an expired pending approval is rejected after a restart', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    const tools1 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const w = await req(tools1, 'write_workspace_file', { path: 'x.txt', content: 'y\n' });
    // tamper the persisted pending to be already expired
    const pendingPath = join(stateDir, sessionKeyFor('s1'), 'pending-approvals.json');
    const data = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    for (const key of Object.keys(data.entries)) data.entries[key].expiresAt = 1;
    writeFileSync(pendingPath, JSON.stringify(data));
    // restart: a new instance loads the expired pending from disk
    const tools2 = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1' });
    const r = await req(tools2, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, {
      interaction: { interactionId: w.interactionId, callId: 'c1', decision: 'approve' },
    });
    assert.equal(r.status, 'error');
    assert.equal(r.content.code, 'interaction_unknown_or_expired');
    assert.equal(existsSync(join(workspaceRoot, 'x.txt')), false);
  } finally { cleanup(); }
});

test('WorkspaceStateStore expires pending approvals at the store level', () => {
  const base = mkdtempSync(join(tmpdir(), 'nws-approval-exp-'));
  const stateDir = join(base, 'state');
  try {
    const store = new WorkspaceStateStore(stateDir, 's1');
    const pending = store.addPending({ callId: 'c', name: 'write_workspace_file', argumentsDigest: 'd', ttlMs: -1000 });
    assert.ok(pending.interactionId);
    assert.equal(store.getPending(pending.interactionId), undefined); // already expired
    assert.equal(store.consumePending(pending.interactionId), undefined);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('an aborted signal cancels a mutating tool before authorization runs', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    let authorizeCalls = 0;
    const tools = createNativeWorkspaceTools({
      workspaceRoot, stateDir, sessionId: 's1',
      authorize: async () => { authorizeCalls += 1; return 'allow'; },
    });
    const r = await req(tools, 'write_workspace_file', { path: 'x.txt', content: 'y\n' }, { signal: AbortSignal.abort() });
    assert.equal(r.status, 'error');
    assert.equal(r.content.code, 'canceled');
    assert.equal(authorizeCalls, 0);
    assert.equal(existsSync(join(workspaceRoot, 'x.txt')), false);
  } finally { cleanup(); }
});

test('an aborted signal cancels a search before it runs', async () => {
  const { workspaceRoot, stateDir, cleanup } = baseSetup();
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(workspaceRoot, `f${i}.txt`), 'match line\n');
    const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir, sessionId: 's1', authorize: async () => 'allow' });
    const r = await req(tools, 'search_workspace_files', { query: 'match' }, { signal: AbortSignal.abort() });
    assert.equal(r.status, 'error');
    assert.equal(r.content.code, 'canceled');
  } finally { cleanup(); }
});
