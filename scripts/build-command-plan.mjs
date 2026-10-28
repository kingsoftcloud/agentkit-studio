/** Bundle the pinned ZCode shell classifier; no external parser at runtime. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const contract = 'zcode-posix-readonly/v1';
const sourceRoot = join(root, 'third-party/zcode-command-plan');
const source = JSON.parse(await readFile(join(sourceRoot, 'source.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of [...source.files, source.entry]) {
  if (hash(await readFile(join(sourceRoot, file.path))) !== file.sha256) throw Error(`Command Plan reference drift: ${file.path}`);
}
let parserRoot = dirname(fileURLToPath(import.meta.resolve('unbash')));
while (!(await readFile(join(parserRoot, 'package.json'), 'utf8').then(JSON.parse).catch(() => null))?.name) {
  const parent = dirname(parserRoot);
  if (parent === parserRoot) throw Error('Command Plan parser package missing');
  parserRoot = parent;
}
const parser = JSON.parse(await readFile(join(parserRoot, 'package.json'), 'utf8'));
if (parser.name !== 'unbash' || parser.version !== '4.0.1') throw Error('Command Plan parser version mismatch');
const result = await build({ entryPoints: [join(sourceRoot, 'index.ts')], bundle: true,
  platform: 'node', format: 'esm', target: 'node22', write: false, minify: true, legalComments: 'eof' });
const code = result.outputFiles[0].text;
await mkdir(join(root, 'packages/agentkit-harness-node/dist'), { recursive: true });
await writeFile(join(root, 'packages/agentkit-harness-node/dist/native-command-plan.mjs'), code);
await writeFile(join(root, 'packages/agentkit-harness-node/dist/native-command-plan.LICENSE.txt'),
  `ZCode ${source.commit}\n${await readFile(join(root, 'third-party/ZCode-LICENSE'), 'utf8')}\n\nunbash@4.0.1\n${await readFile(join(parserRoot, 'LICENSE'), 'utf8')}`);
await writeFile(join(root, 'packages/agentkit-harness-node/dist/native-command-plan.json'), JSON.stringify({ contract, sha256: hash(code),
  referenceCommit: source.commit, sourceDigest: hash(await readFile(join(sourceRoot, 'source.json'))),
  dependencies: [{ name: parser.name, version: parser.version, license: parser.license }], bytes: Buffer.byteLength(code) }, null, 2) + '\n');
console.log(`Built ${contract}: ${Buffer.byteLength(code)} bytes, pinned ZCode + unbash@4.0.1.`);
