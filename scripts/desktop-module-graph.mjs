/** Parse packaged host modules without executing them; reject omitted build chunks. */
import { build } from 'esbuild';
import { posix } from 'node:path';

export const DESKTOP_HOST_ENTRIES = ['dsh-agent-preset-registry', 'dsh-agent', 'dsh-agent-loop',
  'dsh-tools', 'dsh-system-prompt', 'dsh-session', 'dsh-llm'].map(name =>
  `dsh/node_modules/@deepseek-ai/${name}/lib/index.js`);

export async function verifyDesktopModuleGraph(readModule, entryPoints = DESKTOP_HOST_ENTRIES) {
  const result = await build({ entryPoints, bundle: true, write: false, metafile: true,
    platform: 'node', outdir: 'module-graph', logLevel: 'silent', plugins: [{
      name: 'packaged-desktop-host', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind === 'entry-point') return { path: args.path, namespace: 'archive' };
          if (!args.path.startsWith('.')) return { path: args.path, external: true };
          const path = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
          if (!path.startsWith('dsh/node_modules/')) throw new Error('Desktop module import escapes the package root');
          return { path, namespace: 'archive' };
        });
        builder.onLoad({ filter: /.*/, namespace: 'archive' }, async args => {
          let contents;
          try { contents = await readModule(args.path); }
          catch { throw new Error(`Packaged desktop module is missing: ${args.path}`); }
          return { contents: String(contents), loader: 'js' };
        });
      },
    }] });
  return { entries: entryPoints, modules: Object.keys(result.metafile.inputs).length, verified: true };
}
