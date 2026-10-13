import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const archive = process.argv[2];
if (!archive) {
  console.error('usage: node scripts/check-package.mjs <tarball>');
  process.exit(2);
}

const tarball = resolve(archive);
const list = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);
const files = new Set(list.map(path => path.replace(/^package\//, '')));
const read = path => execFileSync('tar', ['-xOzf', tarball, `package/${path}`], { encoding: 'utf8' });
const packageJson = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('studio.plugin.json'));
const expected = [
  'package.json', 'studio.plugin.json', 'README.md', 'CHANGELOG.md',
  'LICENSE',
  'src/index.mjs', 'src/providers/agentkit-harness.mjs', 'dist/client.js',
  'packages/agentkit-harness/package.json', 'packages/agentkit-harness/agentkit-harness.plugin.json',
  'packages/agentkit-harness/src/index.mjs', 'packages/agentkit-harness/src/core.mjs',
  'packages/agentkit-harness/src/contract.mjs', 'packages/agentkit-harness/src/dsh-adapter.mjs',
  'packages/agentkit-harness/src/index.d.ts',
  'scripts/build-client.mjs', 'docs/brand/visual-system.md',
  'docs/README.md', 'docs/architecture.md', 'docs/getting-started.md',
  'patches/dsh-v0.2.0-rc.2/README.md',
];
const missing = expected.filter(path => !files.has(path));
if (missing.length) throw new Error(`package missing required files: ${missing.join(', ')}`);
if (packageJson.name !== '@kingsoftcloud/agentkit-studio') throw new Error(`unexpected package name: ${String(packageJson.name)}`);
if (!/^\d+\.\d+\.\d+$/.test(String(packageJson.version))) throw new Error(`package version must be stable semver: ${String(packageJson.version)}`);
if (manifest.id !== 'agentkit-studio' || manifest.version !== packageJson.version) throw new Error('plugin manifest identity/version does not match package.json');
if (manifest.requiredDsh !== '0.2.0-rc.2') throw new Error(`unexpected DSH pin: ${String(manifest.requiredDsh)}`);
if (packageJson.private !== true) throw new Error('package.json must remain private until registry publication is approved');
const harnessPackage = JSON.parse(read('packages/agentkit-harness/package.json'));
const harnessManifest = JSON.parse(read('packages/agentkit-harness/agentkit-harness.plugin.json'));
if (harnessPackage.name !== '@kingsoftcloud/agentkit-harness' || harnessPackage.private === true) throw new Error('Harness package must be independently packable');
if (harnessManifest.type !== 'dsh-plugin' || harnessManifest.package !== harnessPackage.name) throw new Error('Harness manifest is not a DSH plugin manifest');
if (JSON.stringify(harnessManifest.inject) !== JSON.stringify(['agents', 'sessions', 'llm'])) throw new Error('Harness manifest inject list must match the DSH plugin entry');
for (const dependency of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm']) {
  if (!harnessPackage.peerDependencies?.[dependency]) throw new Error(`Harness package is missing DSH peer dependency ${dependency}`);
}

for (const path of list) {
  if (!path.startsWith('package/') || path.endsWith('/')) continue;
  const body = execFileSync('tar', ['-xOzf', tarball, path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (/\/Users\/|\/home\/[^/]+\/|file:\/\/\/Users\//.test(body)) throw new Error(`package contains a personal absolute path: ${path}`);
  if (/AGENTKIT_MODEL_API_KEY\s*[:=]\s*['"]?[A-Za-z0-9_-]{12,}/.test(body)) throw new Error(`package contains a model credential-looking value: ${path}`);
}

console.log(`package integrity: ${basename(tarball)} (${files.size} files) passed`);
