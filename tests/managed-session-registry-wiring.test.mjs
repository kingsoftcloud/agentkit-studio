/** Guard against a half fix: every consumer of the managed session registry must
 * resolve the same Agent-scoped directory.
 *
 * AGENTKIT_HOME is version-scoped (versions/<sha256(VersionId)>/agentkit), so a
 * consumer that reads the registry from it opens a fresh, empty directory after
 * every accepted UpdateAgent. The Session actions then write to the Agent-scoped
 * registry while resource identity resolution reads the empty version directory,
 * and the turn fails with 托管资源缺少可核对的会话归属.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = name => readFile(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

const CONSUMERS = [
  ['frozen-build-runtime.mjs', 'the Session actions'],
  ['host/bootstrap.mjs', 'resource identity resolution'],
];

for (const [file, purpose] of CONSUMERS) {
  test(`${file} resolves the Agent-scoped managed session registry (${purpose})`, async () => {
    const text = await source(file);
    assert.match(text, /AGENTKIT_MANAGED_SESSIONS/,
      `${file} must consume the Agent-scoped registry exported by managed-runtime-host.mjs`);
    assert.match(text, /AGENTKIT_MANAGED_SESSIONS\s*\|\|\s*join\([^)]*AGENTKIT_HOME[^)]*managed-sessions/,
      `${file} must keep the version-scoped path only as a fallback`);
  });
}

test('managed-runtime-host exports the Agent-scoped registry outside the version directory', async () => {
  const text = await source('managed-runtime-host.mjs');
  // The exported path is <state>/managed-sessions, not versions/<sha>/agentkit/...
  assert.match(text, /AGENTKIT_MANAGED_SESSIONS: managedSessions/);
  assert.match(text, /const managedSessions = await adoptManagedSessions\(\{ root, versions \}\)/);
});
