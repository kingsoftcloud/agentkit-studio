import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Source dependencies are ES Modules. DSH receives one browser script and
// supplies React and UI capabilities through its existing ModuleLoader.
const result = await build({
  absWorkingDir: root, entryPoints: ['src/client.js'],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'none', write: false, metafile: true,
});
const output = result.outputFiles[0].text;
if (!output.includes('window.__ModuleLoader__.load({')) throw new Error('client bundle lost the DSH ModuleLoader registration');
if (!output.includes('@kingsoftcloud/agentkit-studio')) throw new Error('client bundle lost the Studio module id');
for (const input of Object.keys(result.metafile.inputs)) {
  if (/^(?:src\/(?:host|providers)\/|packages\/agentkit-harness\/|node_modules\/)/.test(input)) throw new Error(`Unexpected browser dependency: ${input}`);
}
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/client.js'), output);
await mkdir(resolve(root, '.artifacts/client'), { recursive: true });
await writeFile(resolve(root, '.artifacts/client/metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
