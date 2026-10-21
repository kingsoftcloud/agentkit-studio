import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

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
  'src/index.mjs', 'src/product.json', 'src/providers/agentkit-harness.mjs', 'dist/client.js',
  'dist/native-mcp-client.mjs', 'dist/native-mcp-client.json', 'dist/native-mcp-client.LICENSE.txt',
  'packages/agentkit-harness/src/native/python-syntax.mjs',
  'packages/agentkit-harness/src/native/python-syntax-worker.mjs',
  'packages/agentkit-harness/src/native/local-command-policy.mjs',
  'packages/agentkit-harness/src/native/local-command-tools.mjs',
  'src/build-engine.mjs',
  'packages/agentkit-harness/src/native/child-owner.mjs',
  'packages/agentkit-harness/src/native/child-tools.mjs',
  'packages/agentkit-harness/src/native/child-readers.mjs',
  'packages/agentkit-harness/src/native/child-history.mjs',
  'src/client/state/native-children.mjs', 'src/client/dsh/native-children.mjs',
  'src/providers/native-subagents.mjs',
  'src/providers/native-recovery-binding.mjs',
  'src/providers/native-hooks.mjs', 'docs/native-hooks.md', 'tests/studio-native-hooks.test.mjs',
  'host-source/dsh-v0.2.1-rc.2/maintenance.bundle',
  'host-source/dsh-v0.2.1-rc.2/LICENSE',
  'scripts/verify-native-recovery-capability.mjs',
  'scripts/verify-native-owned-recovery.mjs',
  'tests/fixtures/native-owned-recovery.mjs',
  'packages/agentkit-harness/src/native/dsh-turn-ownership.mjs',
  'scripts/verify-studio-native-children.mjs',
  'tests/fixtures/studio-native-children.mjs',
  'packages/agentkit-harness-core/dist/child-contract.mjs',
  'packages/agentkit-harness-core/dist/child-runtime.mjs',
  'packages/agentkit-harness-core/dist/child-control.mjs',
  'packages/agentkit-harness-core/dist/guidance.mjs',
  'src/providers/native-tool-policy.mjs',
  'src/providers/native-host-interaction.mjs',
  'packages/agentkit-harness/src/native/owned-command.mjs',
  'packages/agentkit-harness/src/native/local-command-policy-worker.mjs',
  'packages/agentkit-harness/src/native/ruff-ast.mjs',
  'packages/agentkit-harness/src/native/local-process.mjs',
  'packages/agentkit-harness/src/native/local-process-launcher.c',
  'packages/agentkit-harness/src/native/local-process-manifest.json',
  'packages/agentkit-harness/src/native/local-background.mjs',
  'packages/agentkit-harness/src/native/local-background-supervisor.mjs',
  'packages/agentkit-harness/src/native/local-command-state.mjs',
  ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(target => `packages/agentkit-harness/src/native/local-process-bin/${target}/launcher`),
  ...['NOTICE', 'musl-COPYRIGHT', 'GCC-COPYING3', 'GCC-COPYING.RUNTIME'].map(name => `packages/agentkit-harness/src/native/local-process-licenses/${name}`),
  'scripts/check-local-process-launcher.mjs', 'scripts/build-local-process-launcher.mjs', 'scripts/verify-native-local-process-package.mjs',
  'packages/agentkit-harness/package.json', 'packages/agentkit-harness/agentkit-harness.plugin.json',
  'packages/agentkit-harness/src/index.mjs', 'packages/agentkit-harness/src/core.mjs',
  'packages/agentkit-harness/src/contract.mjs', 'packages/agentkit-harness/src/dsh-adapter.mjs',
  'packages/agentkit-harness/src/index.d.ts',
  'scripts/build-client.mjs', 'docs/brand/visual-system.md',
  'docs/README.md', 'docs/architecture.md', 'docs/getting-started.md',
  'patches/dsh-v0.2.1-rc.2/README.md',
];
const missing = expected.filter(path => !files.has(path));
if (missing.length) throw new Error(`package missing required files: ${missing.join(', ')}`);
// Source modes alone do not prove tarball modes: packers may normalize every
// non-bin file to 0644. Check the shipped executables without repairing them.
const launchers = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
  .map(target => `packages/agentkit-harness/src/native/local-process-bin/${target}/launcher`);
const extracted = mkdtempSync(join(tmpdir(), 'studio-package-modes-'));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', extracted, ...launchers.map(path => `package/${path}`)]);
  for (const path of launchers) {
    const stat = lstatSync(join(extracted, 'package', path));
    if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error(`package launcher is not executable: ${path}`);
  }
} finally { rmSync(extracted, { recursive: true, force: true }); }
if (packageJson.name !== '@kingsoftcloud/agentkit-studio') throw new Error(`unexpected package name: ${String(packageJson.name)}`);
if (packageJson.exports?.['./host-bootstrap'] !== './src/host/bootstrap.mjs') throw new Error('trusted Native Hook bootstrap must be publicly importable');
if (packageJson.dependencies?.['@astral-sh/ruff-wasm-nodejs'] !== '0.16.8') throw new Error('Python-source syntax parser must be an exact production dependency');
if (!/^\d+\.\d+\.\d+$/.test(String(packageJson.version))) throw new Error(`package version must be stable semver: ${String(packageJson.version)}`);
if (manifest.id !== 'agentkit-studio' || manifest.version !== packageJson.version) throw new Error('plugin manifest identity/version does not match package.json');
if (manifest.requiredDsh !== '0.2.1-rc.2') throw new Error(`unexpected DSH pin: ${String(manifest.requiredDsh)}`);
if (packageJson.private !== true) throw new Error('package.json must remain private until registry publication is approved');
const harnessPackage = JSON.parse(read('packages/agentkit-harness/package.json'));
const maintenance = JSON.parse(read('patches/dsh-v0.2.1-rc.2/source.json'));
const bundledSource = execFileSync('tar', ['-xOzf', tarball, 'package/host-source/dsh-v0.2.1-rc.2/maintenance.bundle']);
if (createHash('sha256').update(bundledSource).digest('hex') !== maintenance.bundle.sha256) {
  throw new Error('packaged maintenance source differs from its reviewed descriptor');
}
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
