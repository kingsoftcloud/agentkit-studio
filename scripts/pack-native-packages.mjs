import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source archives are development artifacts. This command never changes the
// reviewed registry dependencies or the release pins consumed by Studio.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, '.artifacts/native-source-pack');
mkdirSync(destination, { recursive: true });
for (const script of ['build-native-harness.mjs', 'build-native-node.mjs'])
  execFileSync(process.execPath, [join(root, 'scripts', script)], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'packages/agentkit-harness-ui/markdown/build/build-markdown.cjs')], { cwd: root, stdio: 'inherit' });
for (const name of ['agentkit-harness-core', 'agentkit-harness-node', 'agentkit-harness-ui']) {
  const cwd = join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  if (!manifest.name.startsWith('@kingsoftcloud/agentkit-harness-')) throw Error('Unexpected Native package');
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd, encoding: 'utf8' }));
  console.log(JSON.stringify({ name: packed.name, version: packed.version, archive: join(destination, packed.filename),
    integrity: packed.integrity, files: packed.entryCount }));
}
