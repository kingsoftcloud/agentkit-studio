import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const fragmentDir = fileURLToPath(new URL('../src/client-fragments/', import.meta.url));
const fragmentSource = (await Promise.all((await readdir(fragmentDir)).filter(name => name.endsWith('.js')).sort().map(name => readFile(resolve(fragmentDir, name), 'utf8')))).join('\n');
const migratedPaths = ['remote/host-client.mjs', 'state/conversation-agent.mjs', 'state/native-authoring.mjs', 'dsh/native-authoring.mjs', 'theme.mjs', 'components/primitives.mjs', 'components/form-styles.mjs', 'components/resource-dialog.mjs', 'state/product-versions.mjs', 'pages/studio-settings.mjs', 'pages/agents.mjs', 'pages/platform-resource-picker.mjs', 'pages/agent-form.mjs', 'pages/agent-edit.mjs'];
const clientSource = fragmentSource + '\n' + (await Promise.all(migratedPaths.map(path => readFile(new URL('../src/client/' + path, import.meta.url), 'utf8')))).join('\n');

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
  assert.match(clientSource, /hostRemote\.syncModelCredential\(\)/);
  assert.match(clientSource, /models\/sync-credential/);
});

test('model settings hydrate gateway modality metadata and repair the DSH route', () => {
  assert.match(clientSource, /hydrateModelInputs\s*=\s*async profiles/);
  assert.match(clientSource, /hostRemote\.modelCatalog\(profile\.id\)/);
  assert.match(clientSource, /input:\s*model\.input/);
  assert.match(clientSource, /dshModel\.applyProfiles\(\{ profiles: discoveredProfiles/);
});
