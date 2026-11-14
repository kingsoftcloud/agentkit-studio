import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NATIVE_PACKAGES } from './native-package-integrity.mjs';
import { dshPin } from './dsh-pin.mjs';
const forbiddenPath = /\/Users\/|\/home\/[^/]+\/|file:\/\/\/Users\//;
// Assembled so this guard does not match its own text.
const containerHome = ['', 'home', 'node'].join('/');

const archive = process.argv[2];
if (!archive) { console.error('usage: node scripts/check-package.mjs <tarball>'); process.exit(2); }
const tarball = resolve(archive);
const list = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
if (list.some(path => !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..'))) throw Error('Unsafe package path');
const extracted = mkdtempSync(join(tmpdir(), 'studio-package-check-'));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
  const root = join(extracted, 'package'), files = new Set(list.map(path => path.replace(/^package\//, '')));
  const read = path => readFileSync(join(root, path), 'utf8');
  const metadata = JSON.parse(read('package.json')), manifest = JSON.parse(read('studio.plugin.json'));
  if (metadata.name !== '@kingsoftcloud/agentkit-studio' || metadata.private === true || metadata.publishConfig?.access !== 'public') throw Error('Studio package identity/publication mismatch');
  if (manifest.id !== 'agentkit-studio' || manifest.version !== metadata.version || manifest.requiredDsh !== dshPin.version) throw Error('Studio manifest identity/Host mismatch');
  if (metadata.exports?.['./agentkit-harness'] || metadata.scripts?.['build:native-source'] || metadata.scripts?.['pack:harness']) throw Error('Legacy Harness entry is still exposed');
  for (const file of files) {
    if (/^(?:docs|tests|examples|host-source|patches)\//.test(file)
      || /^packages\/agentkit-harness(?:-|\/)/.test(file)
      || /^scripts\/(?:build-native|pack-native|sync-from-studio|native-source-snapshot)/.test(file))
      throw Error('Development or duplicate Harness content must not ship in Studio: ' + file);
  }
  for (const target of Object.values(metadata.exports ?? {}))
    if (typeof target !== 'string' || !target.startsWith('./') || !files.has(target.slice(2))) throw Error('Missing Studio export: ' + target);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third-party/ZCode-LICENSE', 'dist/client.js',
    'dist/native-mcp-client.mjs', 'dist/native-mcp-client.json', 'dist/native-mcp-client.LICENSE.txt',
    'scripts/native-package-pins.json', 'scripts/native-package-integrity.mjs', 'scripts/verify-native-dependencies.mjs',
    'scripts/start-agent-bundle.mjs', 'scripts/start-agent-manifest.mjs', 'scripts/verify-agent-manifest.mjs'])
    if (!files.has(file)) throw Error('Missing runtime entry: ' + file);
  for (const name of NATIVE_PACKAGES)
    if (!/^\d+\.\d+\.\d+$/.test(metadata.dependencies?.[name]) || metadata.bundledDependencies?.includes(name))
      throw Error('Native library dependency must be installed from a pinned registry version: ' + name);
  if (files.has('src/host/services/native-harness.mjs') || list.some(path => path.startsWith('package/node_modules/')))
    throw Error('Studio archive contains the retired Harness entry or bundled dependencies');
  for (const path of list) {
    if (path.endsWith('/')) continue;
    const body = readFileSync(join(extracted, path), 'utf8');
    // The runtime image runs as `node`; mask exactly that fixed home before
    // scanning so a container constant is not mistaken for a developer path.
    if (forbiddenPath.test(body.split(containerHome).join('/<container-home>'))) throw Error('Package contains a personal path: ' + path);
    if (/AGENTKIT_MODEL_API_KEY\s*[:=]\s*['"]?[A-Za-z0-9_-]{12,}/.test(body)) throw Error('Package contains a credential-looking value: ' + path);
  }
  console.log(`package integrity: ${basename(tarball)} (${files.size} files) passed`);
} finally { rmSync(extracted, { recursive: true, force: true }); }
