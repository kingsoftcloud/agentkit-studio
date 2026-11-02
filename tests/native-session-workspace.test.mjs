import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindNativeSessionWorkspace } from '../src/providers/native-session-workspace.mjs';

test('two Sessions bind independent physical roots; aliases do not change the owner and invalid paths fail closed', t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'native-session-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b'), alias = join(root, 'alias');
  mkdirSync(a); mkdirSync(b); symlinkSync(b, alias, 'dir');
  const first = { session: { id: 'a' } }, second = { session: { id: 'b' } };
  const paths = new Map([[first.session, a], [second.session, b]]);
  const ctx = { get: key => key === 'workingDirectory' ? { get: session => paths.get(session) } : undefined };
  const one = bindNativeSessionWorkspace({ ctx, agent: first, fallbackRoot: root });
  const two = bindNativeSessionWorkspace({ ctx, agent: second, fallbackRoot: root });
  assert.equal(one.workspaceRoot, a); assert.equal(two.workspaceRoot, b);
  paths.set(second.session, alias); assert.equal(two.assertWorkspace(second), true);
  paths.set(second.session, a); assert.throws(() => two.assertWorkspace(second), { code: 'studio_native_session_workspace_changed' });
  assert.equal(one.assertWorkspace(first), true);
  paths.set(second.session, 'relative');
  assert.throws(() => bindNativeSessionWorkspace({ ctx, agent: second, fallbackRoot: root }), { code: 'studio_native_workspace_path_invalid' });
  const managed = bindNativeSessionWorkspace({ ctx, agent: second, fallbackRoot: a, managed: true });
  assert.equal(managed.workspaceRoot, a); assert.equal(managed.assertWorkspace(second), true);
});
