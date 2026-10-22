import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { parseManagedRuntimeManifest, loadManagedRuntimeManifest, MANAGED_MANIFEST_MAX_BYTES } from '../src/managed-runtime-manifest.mjs';

const selection = { runtimeName: 'dsh-native', runtimeVersion: 'studio-test.1' };
const data = runtime => ({ name: 'employee', framework: runtime, artifact_type: 'ManagedRuntime',
  runtime: { name: runtime, version: selection.runtimeVersion }, model: 'example-model', prompt: '按资料回答。\n保留换行。' });
const source = patch => stringify({ ...data('dsh-native'), ...patch });
const digest = value => createHash('sha256').update(value).digest('hex');

for (const runtimeName of ['dsh-native', 'harness', 'codex']) {
  test(`${runtimeName} consumes YAML directly without a portable bundle`, () => {
    assert.deepEqual(parseManagedRuntimeManifest(stringify(data(runtimeName)), { ...selection, runtimeName }), data(runtimeName));
  });
}

test('runtime identity, unconsumed fields and inline model credentials fail closed', () => {
  for (const [patch, code] of [
    [{ framework: 'codex' }, 'MANAGED_RUNTIME_IDENTITY_MISMATCH'],
    [{ runtime: { name: 'dsh-native', version: 'other' } }, 'MANAGED_RUNTIME_IDENTITY_MISMATCH'],
    [{ runtime: { name: 'dsh-native', version: 1 } }, 'MANAGED_MANIFEST_INVALID'],
    [{ artifact_type: 'Code' }, 'MANAGED_RUNTIME_IDENTITY_MISMATCH'],
    [{ model: { api_key: 'do-not-echo' } }, 'MANAGED_MANIFEST_INVALID'],
    [{ skills: ['unimplemented'] }, 'MANAGED_MANIFEST_FIELD_UNSUPPORTED'],
    [{ plugins: [] }, 'MANAGED_MANIFEST_FIELD_UNSUPPORTED'],
  ]) {
    assert.throws(() => parseManagedRuntimeManifest(source(patch), selection), error => error.code === code && !error.message.includes('do-not-echo'));
  }
  assert.throws(() => parseManagedRuntimeManifest(source({}), {}), { code: 'MANAGED_RUNTIME_IDENTITY_INVALID' });
});

test('duplicates, aliases, multiple documents and malformed UTF-8 are refused', () => {
  const alias = source({ prompt: 'short' }).replace('model: example-model', 'model: &model example-model').replace('prompt: short', 'prompt: *model');
  const unknownTag = source({}).replace('model: example-model', 'model: !unknown example-model');
  for (const raw of [source({}) + 'name: other\n', alias, unknownTag, source({}) + '1: invalid\n', source({}) + '---\nname: other\n', Buffer.from([0xff])]) {
    assert.throws(() => parseManagedRuntimeManifest(raw, selection), { code: 'MANAGED_MANIFEST_INVALID' });
  }
  assert.throws(() => parseManagedRuntimeManifest('#'.repeat(MANAGED_MANIFEST_MAX_BYTES + 1), selection), { code: 'MANAGED_MANIFEST_TOO_LARGE' });
  assert.throws(() => parseManagedRuntimeManifest('prompt: [do-not-echo', selection), error => !error.message.includes('do-not-echo'));
});

test('YAML 1.2 model identifiers retain string identity', () => {
  for (const model of ['on', 'NO', '2026-10-18']) {
    assert.equal(parseManagedRuntimeManifest(source({}).replace('model: example-model', `model: ${model}`), selection).model, model);
  }
});

test('ConfigMap symlinks work and exact bytes must match the injected digest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'managed-manifest-')); t.after(() => rm(root, { recursive: true, force: true }));
  const raw = source({}), path = join(root, 'mounted.yaml');
  await writeFile(join(root, 'payload'), raw); await symlink('payload', path);
  const env = { AGENTENGINE_MANAGED_RUNTIME_NAME: selection.runtimeName, AGENTENGINE_MANAGED_RUNTIME_VERSION: selection.runtimeVersion,
    AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1', AGENTENGINE_MANIFEST_SHA256: digest(raw) };
  assert.deepEqual((await loadManagedRuntimeManifest(path, { env })).declaration, data('dsh-native'));
  await writeFile(join(root, 'payload'), raw + '# modified\n');
  await assert.rejects(loadManagedRuntimeManifest(path, { env }), { code: 'MANAGED_MANIFEST_DIGEST_MISMATCH' });
  await assert.rejects(loadManagedRuntimeManifest(path, { env: {} }), { code: 'MANAGED_RUNTIME_IDENTITY_INVALID' });
  await writeFile(join(root, 'payload'), '#'.repeat(MANAGED_MANIFEST_MAX_BYTES + 1));
  await assert.rejects(loadManagedRuntimeManifest(path, { env }), { code: 'MANAGED_MANIFEST_TOO_LARGE' });
});
