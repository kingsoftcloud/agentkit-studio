import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { CLIENT_PRIVATE_PROPERTIES } from './client-private-properties.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Source dependencies are ES Modules. DSH receives one browser script and
// supplies React and UI capabilities through its existing ModuleLoader.
const result = await build({
  absWorkingDir: root, entryPoints: ['src/client.js'],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'none', write: false, metafile: true,
  mangleProps: new RegExp('^(' + CLIENT_PRIVATE_PROPERTIES.join('|') + ')$'),
  mangleCache: {},
  plugins: [{
    name: 'studio-css-text',
    setup(builder) {
      builder.onLoad({ filter: /\.css\.mjs$/ }, async ({ path }) => {
        // CSS-only ES Modules also load in source behavior tests. Keep this
        // format data-only; the build never evaluates an asset as JavaScript.
        const source = await readFile(path, 'utf8');
        const match = source.match(/^export default String\.raw`([\s\S]*)`;\s*$/);
        if (!match || /`|\$\{/.test(match[1])) throw new Error(`Invalid static CSS asset: ${path}`);
        const result = await transform(match[1], { loader: 'css', minify: true, legalComments: 'none' });
        return { contents: `export default ${JSON.stringify(result.code)};`, loader: 'js' };
      });
    },
  }],
});
const output = result.outputFiles[0].text;
if (!output.includes('window.__ModuleLoader__.load({')) throw new Error('client bundle lost the DSH ModuleLoader registration');
if (!output.includes('@kingsoftcloud/agentkit-studio')) throw new Error('client bundle lost the Studio module id');
for (const input of Object.keys(result.metafile.inputs)) {
  if (/^node_modules\/@kingsoftcloud\/agentkit-harness-ui\/(?:src\/|markdown\/dist\/markdown\.mjs$)/.test(input)) continue;
  if (/^(?:src\/(?:host|providers)\/|packages\/agentkit-harness\/|node_modules\/)/.test(input)) throw new Error(`Unexpected browser dependency: ${input}`);
}
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/client.js'), output);
await mkdir(resolve(root, '.artifacts/client'), { recursive: true });
await writeFile(resolve(root, '.artifacts/client/metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
await writeFile(resolve(root, '.artifacts/client/private-properties.json'), JSON.stringify(result.mangleCache || {}, null, 2) + '\n');
