/** Fresh installation with lifecycle scripts and Native components.
 * --host mounts the installed Host, checks DSH/Codex builtin pipelines and
 * deterministic Native full turns across restart. Real models/Codex CLI and
 * complete product acceptance remain separate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readNodeHostPackages } from './node-host-packages.mjs';

const { values } = parseArgs({ options: { archive: { type: 'string' }, keep: { type: 'boolean', default: false },
  host: { type: 'boolean', default: false }, 'host-packages': { type: 'string' } } });
assert.ok(values.archive, 'Use --archive <packed Studio.tgz> [--host [--host-packages <manifest>]] [--keep]');
const archive = resolve(values.archive);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveSha256 = digest(await readFile(archive));
assert.ok(!values['host-packages'] || values.host, '--host-packages requires --host');
const maintained = values['host-packages'] ? await readNodeHostPackages(values['host-packages']) : null;
const npm = process.env.PATH.split(delimiter).map(dir => join(dir, 'npm')).find(existsSync);
assert.ok(npm);
const directory = await mkdtemp(join(tmpdir(), 'studio-native-fresh-install-'));
const bin = join(directory, 'node-only-bin');
await mkdir(bin); await symlink(process.execPath, join(bin, 'node'));
// npm lifecycle scripts need an OS shell. Supplying it explicitly keeps the
// rest of the machine's PATH (including Python/uv) outside this proof.
assert.equal(process.platform === 'win32', false, 'This verifier currently requires POSIX shells');
await symlink('/bin/sh', join(bin, 'sh')); await symlink('/bin/bash', join(bin, 'bash'));
if (values.host) for (const tool of ['openssl', 'tar']) {
  const path = process.env.PATH.split(delimiter).map(dir => join(dir, tool)).find(existsSync);
  assert.ok(path, `Host verification requires ${tool}`);
  await symlink(realpathSync(path), join(bin, tool));
}
await writeFile(join(directory, 'user.npmrc'), ''); await writeFile(join(directory, 'global.npmrc'), '');
const { requiredDsh } = JSON.parse(await readFile(new URL('../studio.plugin.json', import.meta.url), 'utf8'));
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'native-studio-install-proof', version: '1.0.0', private: true,
  dependencies: { '@kingsoftcloud/agentkit-studio': 'file:' + archive, ...(values.host ? {
    '@deepseek-ai/dsh': requiredDsh, '@deepseek-ai/dsh-base': requiredDsh,
    '@deepseek-ai/dsh-web-app': requiredDsh, '@deepseek-ai/dsh-sdk-client': requiredDsh,
  } : {}), ...(maintained?.dependencies ?? {}) }, ...(maintained ? { overrides: maintained.overrides } : {}) }));
const env = { ...process.env, PATH: bin, NODE_PATH: '', NODE_OPTIONS: '',
  npm_config_userconfig: join(directory, 'user.npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc'),
  PYTHON: '/unavailable/python', npm_config_python: '/unavailable/python',
  AGENTKIT_KSADK_PYTHON: '/unavailable/python', AGENTKIT_KSADK_ROOT: '/unavailable/ksadk',
  KSADK_PYTHON: '/unavailable/python', KSADK_ROOT: '/unavailable/ksadk' };
console.log(JSON.stringify({ stage: 'installing', directory, archive, node: process.version }));
const child = spawn(process.execPath, [realpathSync(npm), 'install', '--foreground-scripts', '--ignore-scripts=false', '--omit=dev', '--no-audit', '--no-fund',
  '--workspaces=false', '--registry=https://registry.npmjs.org', '--cache=' + join(directory, 'empty-cache')],
{ cwd: directory, env, stdio: 'inherit', timeout: 240000 });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
assert.equal(code, 0);
const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
assert.ok(Object.keys(lock.packages).length > 10);
assert.ok(Object.entries(lock.packages).filter(([path]) => path.startsWith('node_modules/')).every(([, entry]) => !entry.link));
const studio = join(directory, 'node_modules/@kingsoftcloud/agentkit-studio');
assert.ok(realpathSync(studio).startsWith(realpathSync(directory) + '/'));
const verify = `import assert from 'node:assert/strict';
import Studio from '@kingsoftcloud/agentkit-studio';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const fromStudio = createRequire(import.meta.resolve('@kingsoftcloud/agentkit-studio'));
const loadNative = name => import(pathToFileURL(fromStudio.resolve('@kingsoftcloud/agentkit-harness-node/native/' + name)).href);
const Harness = await loadNative('sqlite-store');
const { SqliteNativeMemoryProvider } = await loadNative('memory-store');
const { nativeUserMemoryCandidate, memoryDigest, nativeMemoryScopeBindings } = await loadNative('memory-candidate');
const { checkPythonSyntax } = await loadNative('python-syntax');
import { createStudioNativeHarness } from './node_modules/@kingsoftcloud/agentkit-studio/src/host/services/native-harness.mjs';
assert.equal(typeof Studio.apply,'function'); assert.equal(typeof createStudioNativeHarness,'function');
const scope={tenantId:'local',workspaceId:'fresh',agentId:'agent',userId:'user'};
const store=new Harness.SqliteRunStore('./runs.sqlite'); store.close();
const memory=new SqliteNativeMemoryProvider('./memory.sqlite',{principal:scope});
const candidate=nativeUserMemoryCandidate({text:'记住：我喜欢用Vim',sourceEventId:'original',...nativeMemoryScopeBindings(scope)[0]});
const receipt=memory.applyCandidate({candidate,operationKey:'candidate',sourceSessionId:'session',sourceDigest:memoryDigest(candidate.content)});
assert.equal(receipt.committed,true); assert.equal(memory.get(receipt.memoryId).content,'我喜欢用Vim'); memory.close();
assert.deepEqual(await checkPythonSyntax('def answer():\\n    return 42\\n'),[]);
console.log('PASS: full Studio package imports, Native SQLite/Memory and shipped source parser execute with fresh installed dependencies and Node-only PATH.');
`;
await writeFile(join(directory, 'verify.mjs'), verify);
const proof = spawn(process.execPath, [join(directory, 'verify.mjs')], { cwd: directory, env, stdio: 'inherit', timeout: 30000 });
assert.equal(await new Promise((resolve, reject) => { proof.once('error', reject); proof.once('exit', resolve); }), 0);
if (values.host) {
  for (const [script, flags] of [['verify-studio-node-builtins.mjs', []], ['verify-studio-native-harness.mjs', ['--mount-host']]]) {
    const host = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)),
      '--installation', directory, '--archive', archive, '--keep', ...flags], { cwd: directory, env, stdio: 'inherit', timeout: 120000 });
    assert.equal(await new Promise((resolve, reject) => { host.once('error', reject); host.once('exit', resolve); }), 0);
  }
}
await writeFile(join(directory, 'proof.json'), JSON.stringify({ format: 'agentkit.native-node-install-proof/v1', passed: true, node: process.version, directory, archive,
  archiveSha256, lockSha256: digest(await readFile(join(directory, 'package-lock.json'))),
  packageCount: Object.keys(lock.packages).length, scope: values.host
    ? 'fresh Host dependency install, mount, Native full turns and restart, DSH/Codex builtin pipeline and cold restore; no real model/CLI or full product acceptance'
    : 'fresh install and component loading; full mounted Host execution pending', installScripts: true, host: values.host,
  ...(maintained ? { maintainedHost: maintained.evidence } : {}) }, null, 2));
console.log(JSON.stringify({ passed: true, directory, packageCount: Object.keys(lock.packages).length }));
if (!values.keep) await (await import('node:fs/promises')).rm(directory, { recursive: true, force: true });
