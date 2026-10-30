// Builds @kingsoftcloud/agentkit-harness-node: bundles the shared Native Node
// adapters (SQLite store + one-request model HTTP port) into dist/index.mjs,
// and bundles the JSON-RPC process entry (src/rpc-entry.mjs, which reuses the
// adapters) into dist/rpc-entry.mjs with a node shebang + exec bit. Both bundles
// externalize @kingsoftcloud/agentkit-harness-core and Node builtins.
//
// Each bundle may include only this package's adapters. Core remains an
// external npm dependency; Studio, DSH and product configuration stay outside.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { rm, mkdir, readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkgDir = resolve(root, 'packages/agentkit-harness-node');
const outDir = resolve(pkgDir, 'dist');

// Externalize the shared adapters' relative `agentkit-harness-core/dist` import
// to the public npm name. Matches any import path containing the core package
// directory; the rewrite is applied before default resolution, so esbuild
// never reads the core dist to bundle it.
const externalizeCore = {
  name: 'externalize-agentkit-harness-core',
  setup(build) {
    build.onResolve({ filter: /agentkit-harness-core/ }, ({ path }) => {
      // Public subpaths are distinct APIs. Collapsing /tool-context (or any
      // future subpath) into the root can produce an unimportable npm bundle.
      if (path === '@kingsoftcloud/agentkit-harness-core' || path.startsWith('@kingsoftcloud/agentkit-harness-core/'))
        return { path, external: true };
      if (/agentkit-harness-core\/dist\/index\.mjs$/.test(path))
        return { path: '@kingsoftcloud/agentkit-harness-core', external: true };
      throw Error('Native Node adapter must use a declared Core package export');
    });
  },
};

// Positive closure guarantee: every bundled input must live inside the native
// adapter directory or be this node package's own src entry. Anything else
// (host, global config, model-service, dsh, studio, src/..) is a leak.
const allowed = [
  /^packages\/agentkit-harness-node\/src\/(?:native\/)?[^/]+\.mjs$/,
];
const forbidden = /(?:from\s+|require\s*\(\s*)['"][^'"]*(?:\/agentkit-harness\/src\/|\/dsh\/|\/studio\/|global-config|model-service|credentials)[^'"]*['"]/;

function assertClosureAndBoundary(label, result, distPath) {
  const leaked = Object.keys(result.metafile.inputs).filter(path =>
    !allowed.some(re => re.test(path.replace(/\\/g, '/'))));
  if (leaked.length) {
    console.error(`\nbuild FAILED (${label}): bundled inputs outside the native adapter closure:`);
    for (const path of leaked) console.error('  ' + path);
    console.error('\nThis package must not bundle Studio/DSH/host or core code.');
    process.exit(1);
  }
  const distText = readFile(distPath, 'utf8'); // promise
  return distText.then(text => {
    if (!/from ['"]@kingsoftcloud\/agentkit-harness-core['"]/.test(text)) {
      console.error(`build FAILED (${label}): dist does not externalize @kingsoftcloud/agentkit-harness-core`);
      process.exit(1);
    }
    if (forbidden.test(text)) {
      console.error(`build FAILED (${label}): dist imports Studio/DSH/host code`);
      for (const m of text.match(new RegExp(forbidden, 'g')) ?? []) console.error('  ' + m);
      process.exit(1);
    }
    return text;
  });
}

await Promise.all(['index.mjs', 'rpc-entry.mjs'].map(name => rm(resolve(outDir, name), { force: true })));
await mkdir(outDir, { recursive: true });

const bundledAdapters = new Set();

// 1. Adapter bundle (re-export only) -> dist/index.mjs. No shebang: this is an
//    imported module, not an executable.
const indexResult = await build({
  entryPoints: [resolve(pkgDir, 'src/index.mjs')],
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  outfile: resolve(outDir, 'index.mjs'),
  absWorkingDir: root, plugins: [externalizeCore], metafile: true,
  sourcesContent: false, logLevel: 'info',
});
const indexDist = resolve(outDir, 'index.mjs');
await assertClosureAndBoundary('index', indexResult, indexDist);
for (const path of Object.keys(indexResult.metafile.inputs)) {
  const norm = path.replace(/\\/g, '/');
  if (/packages\/agentkit-harness-node\/src\/native\//.test(norm)) bundledAdapters.add(relative(root, path).replace(/\\/g, '/'));
}

// 2. JSON-RPC process entry -> dist/rpc-entry.mjs. Preserve its shebang + exec bit so
//    it runs as the package bin. It imports ./index.mjs (adapters) and core
//    (externalized), so it bundles the adapter closure too.
const rpcResult = await build({
  entryPoints: [resolve(pkgDir, 'src/rpc-entry.mjs')],
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  outfile: resolve(outDir, 'rpc-entry.mjs'),
  absWorkingDir: root, plugins: [externalizeCore], metafile: true,
  sourcesContent: false, logLevel: 'info',
});
const rpcDist = resolve(outDir, 'rpc-entry.mjs');
await assertClosureAndBoundary('rpc-entry', rpcResult, rpcDist);
execFileSync(process.execPath, ['--check', rpcDist]);
chmodSync(rpcDist, 0o755);
for (const path of Object.keys(rpcResult.metafile.inputs)) {
  const norm = path.replace(/\\/g, '/');
  if (/packages\/agentkit-harness-node\/src\/native\//.test(norm)) bundledAdapters.add(relative(root, path).replace(/\\/g, '/'));
}

const outputSummary = result => {
  const output = Object.values(result.metafile.outputs).find(entry => entry.entryPoint);
  return { distBytes: output.bytes, externalModules: output.imports.map(entry => entry.path) };
};
const summary = {
  stage: 'agentkit-harness-node built',
  outputs: {
    'dist/index.mjs': outputSummary(indexResult),
    'dist/rpc-entry.mjs': outputSummary(rpcResult),
  },
  bundledAdapters: [...bundledAdapters].sort(),
};
console.log(JSON.stringify(summary, null, 2));
