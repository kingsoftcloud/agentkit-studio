import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { minify } from 'terser';
import { CLIENT_PRIVATE_PROPERTIES } from './client-private-properties.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Source dependencies are ES Modules. DSH receives one browser script and
// supplies React and UI capabilities through its existing ModuleLoader.
// The bundle is served as UTF-8; keep localized text in UTF-8 instead of
// expanding it into JavaScript Unicode escapes in the shipped asset.
const result = await build({
  absWorkingDir: root, entryPoints: ['src/client.js'],
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', charset: 'utf8',
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
      // The published Harness package exports these styles as static template
      // strings. Minify the CSS with the same parser used for Studio assets.
      builder.onLoad({ filter: /agentkit-harness-ui[\/]src[\/](styles|status-panel)\.mjs$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const declaration = /(export const (?:styles|statusPanelStyles) = )`([^`]+)`;/;
        const match = source.match(declaration);
        if (!match || /\$\{/.test(match[2])) return;
        const css = await transform(match[2], { loader: 'css', minify: true, legalComments: 'none' });
        return { contents: source.replace(declaration, () => match[1] + JSON.stringify(css.code) + ';'), loader: 'js' };
      });
      // Compress the published renderer before linking it into the host script
      // so syntax highlighting fits Studio's existing client budget.
      builder.onLoad({ filter: /agentkit-harness-ui[\\/]markdown[\\/]dist[\\/]markdown\.mjs$/ }, async ({ path }) => {
        const { code } = await minify(await readFile(path, 'utf8'), {
          ecma: 2022, module: true, compress: { passes: 2 },
        });
        if (!code) throw new Error('Harness Markdown compression produced no code');
        return { contents: code, loader: 'js' };
      });
    },
  }],
});
// Run the linked browser script through the same semantics-preserving
// compressor so dependency upgrades remain within the approved size budget.
const { code: output } = await minify(result.outputFiles[0].text, {
  ecma: 2022, compress: { passes: 2 },
});
if (!output) throw new Error('Studio browser compression produced no code');
if (!output.includes('window.__ModuleLoader__.load({')) throw new Error('client bundle lost the DSH ModuleLoader registration');
if (!output.includes('@kingsoftcloud/agentkit-studio')) throw new Error('client bundle lost the Studio module id');
for (const input of Object.keys(result.metafile.inputs)) {
  if (/^node_modules\/@kingsoftcloud\/agentkit-harness-ui\/(?:src\/|markdown\/dist\/markdown\.mjs$)/.test(input)) continue;
  if (/^node_modules\/@kingsoftcloud\/agentkit-harness-core\/dist\/(?:child-workspace-tools|capability-profile|model-capabilities|values|error-presentation)\.mjs$/.test(input)) continue;
  if (/^(?:src\/(?:host|providers)\/|packages\/agentkit-harness\/|node_modules\/)/.test(input)) throw new Error(`Unexpected browser dependency: ${input}`);
}
await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/client.js'), output);
await mkdir(resolve(root, '.artifacts/client'), { recursive: true });
await writeFile(resolve(root, '.artifacts/client/metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
await writeFile(resolve(root, '.artifacts/client/private-properties.json'), JSON.stringify(result.mangleCache || {}, null, 2) + '\n');
