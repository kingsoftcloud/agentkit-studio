import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { basename, resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { verifyNativePackageTree } from './native-package-integrity.mjs';

const archive = process.argv[2];
if (!archive) {
  console.error('usage: node scripts/check-package.mjs <tarball>');
  process.exit(2);
}

const tarball = resolve(archive);
const list = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);
if (list.some(path => !path.startsWith('package/') || path.split('/').includes('..'))) throw new Error('unsafe package path');
const files = new Set(list.map(path => path.replace(/^package\//, '')));
const extracted = mkdtempSync(join(tmpdir(), 'studio-package-check-'));
try {
execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
const read = path => readFileSync(join(extracted, 'package', path), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('studio.plugin.json'));
// All adapters must share one Core identity. In particular, a second NativeError
// constructor changes recovery dispatch even when both copies have the same version.
const packageRoot = join(extracted, 'package');
verifyNativePackageTree(packageRoot);
const rootRequire = createRequire(join(packageRoot, 'package.json'));
const adapterRequire = createRequire(join(packageRoot, 'node_modules/@kingsoftcloud/agentkit-harness-node/package.json'));
if (rootRequire.resolve('@kingsoftcloud/agentkit-harness-core') !== adapterRequire.resolve('@kingsoftcloud/agentkit-harness-core'))
  throw new Error('Native adapters must resolve the same bundled Core instance as Studio');
if (!realpathSync(adapterRequire.resolve('diff')).startsWith(realpathSync(packageRoot) + sep))
  throw new Error('Native diff presentation must resolve from the isolated package archive');
const expected = [
  'package.json', 'studio.plugin.json', 'README.md', 'CHANGELOG.md',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'third-party/ZCode-LICENSE',
  'node_modules/@kingsoftcloud/agentkit-harness-node/dist/native-command-plan.mjs', 'node_modules/@kingsoftcloud/agentkit-harness-node/dist/native-command-plan.LICENSE.txt',
  ...['patch-parser', 'patch-apply', 'edit-matchers', 'tool-search-ranking', 'memory-extraction-scheduler',
    'todos', 'coordinator-response']
    .map(name => `node_modules/@kingsoftcloud/agentkit-harness-core/src/${name}.mts`),
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/model-anthropic-cache.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/workspace-display.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-ui/src/react-binding.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-ui/markdown/dist/markdown.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-ui/markdown/dist/THIRD_PARTY_LICENSES.txt',
  'cordis.patch.yml',
  'src/index.mjs', 'src/product.json', 'src/providers/agentkit-harness.mjs', 'dist/client.js',
  'dist/native-mcp-client.mjs', 'dist/native-mcp-client.json', 'dist/native-mcp-client.LICENSE.txt',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/python-syntax.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/python-syntax-worker.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-command-policy.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-command-tools.mjs',
  'src/build-engine.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/child-owner.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/child-tools.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/child-readers.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/child-history.mjs',
  'src/client/state/native-children.mjs', 'src/client/dsh/native-children.mjs',
  'src/providers/native-subagents.mjs',
  'src/providers/native-recovery-binding.mjs',
  'src/providers/native-hooks.mjs', 'docs/native-hooks.md', 'tests/studio-native-hooks.test.mjs',
  'src/providers/native-memory.mjs', 'docs/native-memory.md', 'tests/studio-native-memory.test.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/memory-candidate.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/memory-store.mjs',
  'packages/agentkit-harness/test/native-memory.test.mjs', 'tests/fixtures/native-memory-provider.mjs',
  'scripts/native-memory-proof.mjs',
  'src/providers/native-memory-recall.mjs', 'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/memory-recall.mjs',
  'packages/agentkit-harness/test/native-memory-recall.test.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-core/dist/context-contributions.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-core/dist/context-source-refresh.mjs',
  'host-source/dsh-v0.2.0-rc.2/maintenance.bundle',
  'host-source/dsh-v0.2.0-rc.2/LICENSE',
  'host-source/dsh-v0.2.1-rc.2/maintenance.bundle',
  'host-source/dsh-v0.2.1-rc.2/LICENSE',
  'scripts/verify-native-recovery-capability.mjs',
  'scripts/verify-native-owned-recovery.mjs',
  'tests/fixtures/native-owned-recovery.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/dsh-turn-ownership.mjs',
  'scripts/verify-studio-native-children.mjs',
  'tests/fixtures/studio-native-children.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-core/dist/child-contract.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-core/dist/child-runtime.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-core/dist/child-control.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-core/dist/guidance.mjs',
  'src/providers/native-tool-policy.mjs',
  'src/providers/native-host-interaction.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/owned-command.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-command-policy-worker.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/ruff-ast.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-process.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-process-launcher.c',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-process-manifest.json',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-background.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-background-supervisor.mjs',
  'node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-command-state.mjs',
  ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(target => `node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-process-bin/${target}/launcher`),
  ...['NOTICE', 'musl-COPYRIGHT', 'GCC-COPYING3', 'GCC-COPYING.RUNTIME'].map(name => `node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-process-licenses/${name}`),
  'scripts/check-local-process-launcher.mjs', 'scripts/verify-native-local-process-package.mjs',
  'packages/agentkit-harness/package.json', 'packages/agentkit-harness/agentkit-harness.plugin.json',
  'packages/agentkit-harness/src/index.mjs', 'packages/agentkit-harness/src/core.mjs',
  'packages/agentkit-harness/src/contract.mjs', 'packages/agentkit-harness/src/dsh-adapter.mjs',
  'packages/agentkit-harness/src/index.d.ts', 'scripts/start-agent-bundle.mjs',
];
const missing = expected.filter(path => !files.has(path));
if (missing.length) throw new Error(`package missing required files: ${missing.join(', ')}`);
// Source modes alone do not prove tarball modes: packers may normalize every
// non-bin file to 0644. Check the shipped executables without repairing them.
const launchers = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
  .map(target => `node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-process-bin/${target}/launcher`);
for (const path of launchers) {
  const stat = lstatSync(join(extracted, 'package', path));
  if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error(`package launcher is not executable: ${path}`);
}
for (const dependency of ['@kingsoftcloud/agentkit-harness-core', '@kingsoftcloud/agentkit-harness-node', '@kingsoftcloud/agentkit-harness-ui']) {
  if (!packageJson.dependencies?.[dependency] || !packageJson.bundledDependencies?.includes(dependency))
    throw new Error(`Native npm package is not bundled: ${dependency}`);
}
if (packageJson.name !== '@kingsoftcloud/agentkit-studio') throw new Error(`unexpected package name: ${String(packageJson.name)}`);
if (packageJson.exports?.['./host-bootstrap'] !== './src/host/bootstrap.mjs') throw new Error('trusted Native Hook bootstrap must be publicly importable');
if (packageJson.dependencies?.['@astral-sh/ruff-wasm-nodejs'] !== '0.16.8') throw new Error('Python-source syntax parser must be an exact production dependency');
if (!/^\d+\.\d+\.\d+$/.test(String(packageJson.version))) throw new Error(`package version must be stable semver: ${String(packageJson.version)}`);
if (manifest.id !== 'agentkit-studio' || manifest.version !== packageJson.version) throw new Error('plugin manifest identity/version does not match package.json');
if (manifest.requiredDsh !== '0.2.1-rc.2') throw new Error(`unexpected DSH pin: ${String(manifest.requiredDsh)}`);
if (packageJson.private === true) throw new Error('package.json must be publishable: registry publication is enabled for this release line');
if (packageJson.publishConfig?.access !== 'public') throw new Error('package.json publishConfig.access must be public');
const harnessPackage = JSON.parse(read('packages/agentkit-harness/package.json'));
for (const version of ['0.2.0-rc.2', '0.2.1-rc.2']) {
  const maintenance = JSON.parse(read(`patches/dsh-v${version}/source.json`));
  const bundledSource = readFileSync(join(extracted, 'package', `host-source/dsh-v${version}/maintenance.bundle`));
  if (createHash('sha256').update(bundledSource).digest('hex') !== maintenance.bundle.sha256) {
    throw new Error(`packaged ${version} maintenance source differs from its reviewed descriptor`);
  }
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
  // Bundled third-party dependencies are checked by their own package audits;
  // this product audit applies to Studio and the two owned Native packages.
  if (path.startsWith('package/node_modules/')
    && !/^package\/node_modules\/@kingsoftcloud\/agentkit-harness-(?:core|node)\//.test(path)) continue;
  const body = readFileSync(join(extracted, path), 'utf8');
  if (/\/Users\/|\/home\/[^/]+\/|file:\/\/\/Users\//.test(body)) throw new Error(`package contains a personal absolute path: ${path}`);
  if (/AGENTKIT_MODEL_API_KEY\s*[:=]\s*['"]?[A-Za-z0-9_-]{12,}/.test(body)) throw new Error(`package contains a model credential-looking value: ${path}`);
}

console.log(`package integrity: ${basename(tarball)} (${files.size} files) passed`);
} finally { rmSync(extracted, { recursive: true, force: true }); }
