import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
test('independent manifest checker accepts each profile and refuses tampering without credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'manifest-checker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../scripts/verify-agent-manifest.mjs', import.meta.url));
  for (const name of ['dsh-native', 'harness', 'codex']) {
    const path = join(root, `${name}.yaml`);
    const raw = `name: worker\nframework: ${name}\nartifact_type: ManagedRuntime\nruntime:\n  name: ${name}\n  version: fixture-1\nmodel: fixture\nprompt: private-prompt-canary\n`;
    const digest = createHash('sha256').update(raw).digest('hex');
    const env = { AGENTENGINE_MANAGED_RUNTIME_NAME: name, AGENTENGINE_MANAGED_RUNTIME_VERSION: 'fixture-1',
      AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANIFEST_SHA256: digest };
    await writeFile(path, raw);
    const result = await execute(process.execPath, [entry, '--manifest', path], { env });
    assert.deepEqual(JSON.parse(result.stdout), { event: 'manifest.verified', sha256: digest });
    await writeFile(path, raw + '# tampered\n');
    await assert.rejects(execute(process.execPath, [entry, '--manifest', path], { env }), error =>
      error.code === 1 && error.stderr.includes('MANAGED_MANIFEST_DIGEST_MISMATCH') && !error.stderr.includes('private-prompt-canary'));
  }
});
