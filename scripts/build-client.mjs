import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { AGENTKIT_STUDIO_MARK_BODY, AGENTKIT_STUDIO_MARK_SVG } from '../src/brand.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fragments = [
  '01-loader-and-primitives.js',
  '02-credential-onboarding.js',
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
  '08-settings-and-entry.js',
];
const sources = await Promise.all(fragments.map(name => readFile(resolve(root, 'src/client-fragments', name), 'utf8')));
const source = sources.join('\n')
  .replaceAll("'__AGENTKIT_STUDIO_MARK_BODY__'", JSON.stringify(AGENTKIT_STUDIO_MARK_BODY))
  .replaceAll("'__AGENTKIT_STUDIO_MARK_SVG__'", JSON.stringify(AGENTKIT_STUDIO_MARK_SVG));
if (!source.includes("window.__ModuleLoader__.load({")) throw new Error('client bundle lost the DSH ModuleLoader registration');
if (!source.includes("id: '@kingsoftcloud/agentkit-studio'")) throw new Error('client bundle lost the Studio module id');
// DSH loads the packed browser entry as one script. Keep that artifact small
// enough for the client-size gate while retaining readable, independently
// testable source fragments in the repository.
const { code: output } = await transform(source, {
  loader: 'js', target: 'es2022', minify: true, legalComments: 'none',
});
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/client.js'), output);
