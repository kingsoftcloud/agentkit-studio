import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManagedRuntimeDefinition } from '../src/managed-runtime-definition.mjs';

const manifest = (memory) => [
  'artifact_type: ManagedRuntime',
  'framework: codex',
  'model: deepseek-v4.1-flash',
  'name: memory-probe',
  'prompt: 你好',
  ...(memory ? ['resources:', '  memory:', `    id: ${memory}`] : []),
  'runtime:',
  '  name: codex',
  '  version: 0.0.8-test',
].join('\n');

async function definition(text) {
  const dir = await mkdtemp(join(tmpdir(), 'managed-memory-'));
  const file = join(dir, 'agentengine.yaml');
  await writeFile(file, `${text}\n`);
  const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
  return loadManagedRuntimeDefinition({
    manifest: file,
    env: {
      AGENTENGINE_AGENT_ID: 'ar-test',
      AGENTENGINE_AGENT_VERSION_ID: 'ver-test',
      AGENTENGINE_MANIFEST_PROTOCOL: 'runtime-manifest/v1',
      AGENTENGINE_MANIFEST_SHA256: sha256,
      AGENTENGINE_MANAGED_RUNTIME_NAME: 'codex',
      AGENTENGINE_MANAGED_RUNTIME_VERSION: '0.0.8-test',
      OPENAI_BASE_URL: 'https://model.example/v1',
      AGENTKIT_MODEL_API_KEY: 'test-key',
    },
  });
}

test('a bound memory library materializes the local memory projection', async () => {
  const runtime = await definition(manifest('mem-abc'));
  assert.deepEqual(runtime.agent.spec.memory, { enabled: true, recall: { enabled: true }, write: { mode: 'candidate' } });
  const binding = runtime.agent.spec.bindings.plugins?.find(item => item?.config?.binding?.resource?.kind === 'memory-instance');
  assert.equal(binding?.config?.binding?.resource?.id, 'mem-abc');
  assert.equal(runtime.agent.bindings.plugins?.length, 1);
});

test('an agent without a memory library keeps no memory projection', async () => {
  const runtime = await definition(manifest(null));
  assert.equal(runtime.agent.spec.memory, undefined);
  assert.equal(runtime.agent.spec.bindings.plugins, undefined);
});
