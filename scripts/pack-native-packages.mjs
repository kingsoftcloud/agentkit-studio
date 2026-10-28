import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The staged source is reviewed in Studio first. Consumers continue to use
// npm package names and archives, exactly as an independent installation does.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'vendor/native');
const staging = join(root, '.artifacts/native-source-pack');
mkdirSync(staging, { recursive: true });
const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspace = YAML.parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'));
const retired = [];
for (const script of ['build-native-harness.mjs', 'build-native-node.mjs'])
  execFileSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'packages/agentkit-harness-ui/markdown/build/build-markdown.cjs')], { cwd: root, stdio: 'inherit' });

for (const name of ['agentkit-harness-core', 'agentkit-harness-node', 'agentkit-harness-ui']) {
  const cwd = join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (!manifest.name.startsWith('@kingsoftcloud/agentkit-harness-')) throw Error('Unexpected Native package');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', staging],
    { cwd, encoding: 'utf8' }));
  mkdirSync(destination, { recursive: true });
  const source = join(staging, packed.filename);
  const identity = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const filename = packed.filename.replace(/\.tgz$/, `-${identity}.tgz`);
  copyFileSync(source, join(destination, filename));
  const previous = product.dependencies[manifest.name];
  const next = `file:vendor/native/${filename}`;
  if (previous !== next && previous?.startsWith('file:vendor/native/')) retired.push(join(root, previous.slice(5)));
  product.dependencies[manifest.name] = next;
  if (manifest.name === '@kingsoftcloud/agentkit-harness-core') workspace.overrides[manifest.name] = next;
  console.log(JSON.stringify({ name: manifest.name, version: manifest.version, archive: filename,
    integrity: packed.integrity, files: packed.entryCount }));
}
writeFileSync(join(root, 'package.json'), JSON.stringify(product, null, 2) + '\n');
writeFileSync(join(root, 'pnpm-workspace.yaml'), YAML.stringify(workspace));
for (const filename of retired) rmSync(filename, { force: true });
