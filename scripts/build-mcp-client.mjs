/** Ship the reviewed transport patch even when a consumer installs with npm. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const contract = 'mcp.json-parser/v1';
if ([StdioClientTransport, SSEClientTransport, StreamableHTTPClientTransport].some(Transport => Transport.jsonParserContract !== contract)) {
  throw Error('MCP transport patch missing: install this checkout with pnpm --frozen-lockfile before building');
}
const exports = [
  ['client/index.js', ['Client']], ['client/stdio.js', ['StdioClientTransport', 'getDefaultEnvironment']],
  ['client/sse.js', ['SSEClientTransport']], ['client/streamableHttp.js', ['StreamableHTTPClientTransport']],
];
const result = await build({
  absWorkingDir: root,
  stdin: { contents: exports.map(([path, names]) => `export {${names.join(',')}} from ${JSON.stringify(fileURLToPath(import.meta.resolve(`@modelcontextprotocol/sdk/${path}`)))};`).join('\n'),
    resolveDir: root, sourcefile: 'studio-mcp-client.mjs', loader: 'js' },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true,
  minify: true, legalComments: 'eof',
  banner: { js: "import { createRequire as __mcpCreateRequire } from 'node:module'; const require = __mcpCreateRequire(import.meta.url);" },
});
const packages = new Map();
for (const path of Object.keys(result.metafile.inputs)) {
  if (path === 'studio-mcp-client.mjs') continue;
  let directory = dirname(await realpath(resolve(root, path)));
  for (;;) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (manifest?.name && manifest?.version) { packages.set(directory, manifest); break; }
    const parent = dirname(directory);
    if (parent === directory) throw Error(`MCP dependency manifest missing for ${path}`);
    directory = parent;
  }
}
const licenses = [], dependencies = [];
for (const [directory, manifest] of [...packages].sort(([, a], [, b]) => a.name.localeCompare(b.name))) {
  const files = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name)).sort();
  if (!files.length) throw Error(`MCP dependency license missing: ${manifest.name}@${manifest.version}`);
  const id = `${manifest.name}@${manifest.version}`;
  licenses.push(id, ...(await Promise.all(files.map(async name => `${name}\n${await readFile(join(directory, name), 'utf8')}`))));
  dependencies.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? null });
}
const code = result.outputFiles[0].text;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const patchHash = hash(await readFile(join(root, 'patches/@modelcontextprotocol__sdk@1.32.0.patch')));
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(join(root, 'dist/native-mcp-client.mjs'), code);
await writeFile(join(root, 'dist/native-mcp-client.LICENSE.txt'), licenses.join('\n\n') + '\n');
await writeFile(join(root, 'dist/native-mcp-client.json'), JSON.stringify({ parserContract: contract,
  sha256: hash(code), patchSha256: patchHash, dependencies }, null, 2) + '\n');
console.log(`Built MCP client with ${contract}; ${dependencies.length} dependency licenses included.`);
