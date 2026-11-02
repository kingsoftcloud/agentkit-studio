import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioNativeChildFile } from '../src/host/services/native-child-file-binding.mjs';
import { createStudioNativeChildWorkspaces } from '../src/providers/native-child-workspace-host.mjs';

const scope = { tenantId: 't', workspaceId: 'w', userId: 'u', agentId: 'parent:child:writer' };
const role = { name: 'writer', tools: ['write_workspace_file'], concurrentSafe: false };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-child-host-'));
  const workspaceRoot = join(root, 'workspace'), stateDir = join(root, 'state'); mkdirSync(workspaceRoot);
  writeFileSync(join(workspaceRoot, 'original.txt'), 'original');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { workspaceRoot, stateDir };
}

test('a reopened Host owner restores the original immutable binding and child edits', t => {
  const options = fixture(t), first = createStudioNativeChildWorkspaces(options);
  const bound = first.bind({ scope, sessionId: 'child-session', role });
  writeFileSync(join(bound.root, 'child.txt'), 'child');
  writeFileSync(join(options.workspaceRoot, 'parent-later.txt'), 'later');
  const reopened = createStudioNativeChildWorkspaces(options);
  const restored = reopened.bind({ scope, sessionId: 'child-session', role, existing: true, expectedBinding: structuredClone(bound.binding) });
  assert.deepEqual(restored.binding, bound.binding); assert.equal(restored.root, bound.root);
  assert.equal(readFileSync(join(restored.root, 'child.txt'), 'utf8'), 'child');
  assert.throws(() => readFileSync(join(restored.root, 'parent-later.txt')), { code: 'ENOENT' });
  assert.equal(restored.observer.observe().status, 'ok');
});

test('continuation cannot create a missing original workspace or accept a changed frozen base', t => {
  const owner = createStudioNativeChildWorkspaces(fixture(t));
  assert.throws(() => owner.bind({ scope, sessionId: 'missing', role, existing: true }), /not_prepared/);
  const original = owner.bind({ scope, sessionId: 'session', role });
  assert.throws(() => owner.bind({ scope, sessionId: 'session', role, existing: true,
    expectedBinding: { ...original.binding, baseRevision: 'sha256:' + '0'.repeat(64) } }), /binding_changed/);
});

test('scope, session and role changes cannot reuse another child isolation', t => {
  const owner = createStudioNativeChildWorkspaces(fixture(t));
  const bound = owner.bind({ scope, sessionId: 'session', role });
  for (const changed of [{ scope: { ...scope, userId: 'other' }, sessionId: 'session', role },
    { scope, sessionId: 'other', role }, { scope, sessionId: 'session', role: { ...role, concurrentSafe: true } }]) {
    assert.throws(() => owner.bind({ ...changed, existing: true, expectedBinding: bound.binding }), /not_prepared/);
  }
});

test('child file views follow each admitted parent workspace rather than the Host launch directory', async t => {
  const { workspaceRoot, stateDir } = fixture(t), peer = join(workspaceRoot, 'peer'); mkdirSync(peer);
  const admitted = new Map();
  for (const [index, root] of [[0, workspaceRoot], [1, peer]]) {
    const owner = createStudioNativeChildWorkspaces({ workspaceRoot: root, stateDir });
    const bound = owner.bind({ scope, sessionId: `session-${index}`, role });
    writeFileSync(join(bound.root, 'answer.txt'), `child-${index}`);
    admitted.set(`child-${index}`, { workspaceRoot: root, assertCurrent: () => true,
      record: { snapshot: { runId: `child-${index}` }, configuration: { hostRecoveryBinding: { childWorkspace: bound.binding } } } });
  }
  const reader = createStudioNativeChildFile({ workspaceRoot, stateDir, resolveOwnedChild: async request => admitted.get(request.childRunId) });
  for (const index of [0, 1, 0]) {
    const page = await reader.read({ agentId: 'parent', sessionId: 'parent-session', runId: 'parent-run', childRunId: `child-${index}`, path: 'answer.txt' });
    assert.equal(page.text, `child-${index}`);
  }
});
