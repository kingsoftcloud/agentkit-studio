import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AGENTKIT_STUDIO_MARK_BODY, AGENTKIT_STUDIO_MARK_SVG } from '../src/brand.js';
import { normalizeModelEndpoint } from '../src/model-endpoint.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fragments = [
  '01-loader-and-primitives.js',
  '02-credential-onboarding.js',
  '02-start-checks.js',
  '02-overview-and-selector.js',
  '02-native-authoring.js',
  '02-codex-tool-nodes.js',
  '03-agents-and-authoring.js',
  '04-create-edit-and-resources.js',
  '05-resource-workspaces.js',
  '05-cloud-deployments.js',
  '06-schedule-delivery.js',
  '06-automation-and-operations.js',
  '07-channels-and-shell.js',
  '07-form-styles.js',
  '08-settings-and-entry.js',
];
const sources = await Promise.all(fragments.map(name => readFile(resolve(root, 'src/client-fragments', name), 'utf8')));
const source = (await readFile(resolve(root, 'src/client.js'), 'utf8')) + sources.join('\n')
  .replaceAll("'__AGENTKIT_STUDIO_MARK_BODY__'", JSON.stringify(AGENTKIT_STUDIO_MARK_BODY))
  .replaceAll("'__AGENTKIT_STUDIO_MARK_SVG__'", JSON.stringify(AGENTKIT_STUDIO_MARK_SVG))
  .replaceAll('__AGENTKIT_MODEL_ENDPOINT_NORMALIZER__', normalizeModelEndpoint.toString());
if (!source.includes("window.__ModuleLoader__.load({")) throw new Error('client bundle lost the DSH ModuleLoader registration');
if (!source.includes("id: '@kingsoftcloud/agentkit-studio'")) throw new Error('client bundle lost the Studio module id');
// DSH loads the packed browser entry as one script. Keep that artifact small
// enough for the client-size gate while retaining readable, independently
// testable source fragments in the repository.
// Transitional 3A composition: migrated code follows real ES module imports.
// The remaining page fragments are removed in 3C.
const result = await build({
  stdin: { contents: source, resolveDir: resolve(root, 'src'), sourcefile: 'client.js', loader: 'js' },
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'none', write: false, metafile: true,
});
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/client.js'), result.outputFiles[0].text);
await mkdir(resolve(root, '.artifacts/client'), { recursive: true });
await writeFile(resolve(root, '.artifacts/client/metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
