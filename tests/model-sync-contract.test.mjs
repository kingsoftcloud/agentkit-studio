import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientSource = await readFile(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8');

test('model save synchronizes the DSH default model namespace', () => {
  assert.match(clientSource, /DSH_DEFAULT_MODEL_SETTINGS_NS\s*=\s*'agent-default-model'/);
  assert.match(clientSource, /settings\.mutate\(\s*DSH_DEFAULT_MODEL_SETTINGS_NS/);
  assert.match(clientSource, /path:\s*\['provider'\]/);
  assert.match(clientSource, /path:\s*\['model'\]/);
});

test('Studio Host model defaults synchronize before the settings modal is opened', () => {
  assert.match(clientSource, /syncModelFromStudioHost\s*=\s*async/);
  assert.match(clientSource, /const settings = await hostRemote\.settings\(\)/);
  assert.match(clientSource, /void syncModelFromStudioHost\(\)/);
  assert.match(clientSource, /ctx\.on\('connection\/reset', \(\) => \{ void syncModelFromStudioHost\(\); \}\)/);
});
