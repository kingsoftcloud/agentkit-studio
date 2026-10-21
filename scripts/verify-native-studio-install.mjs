/** Fresh registry installation and Native component proof; does not start the
 * DSH Host, exercise Codex, or replace product end-to-end acceptance. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { archive: { type: 'string' }, keep: { type: 'boolean', default: false } } });
assert.ok(values.archive, 'Use --archive <packed Studio.tgz> [--keep]');
const archive = resolve(values.archive);
const npm = process.env.PATH.split(delimiter).map(dir => join(dir, 'npm')).find(existsSync);
assert.ok(npm);
const directory = await mkdtemp(join(tmpdir(), 'studio-native-fresh-install-'));
const bin = join(directory, 'node-only-bin');
await mkdir(bin); await symlink(process.execPath, join(bin, 'node'));
await writeFile(join(directory, 'user.npmrc'), ''); await writeFile(join(directory, 'global.npmrc'), '');
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'native-studio-install-proof', version: '1.0.0', private: true,
  dependencies: { '@kingsoftcloud/agentkit-studio': 'file:' + archive } }));
const env = { ...process.env, PATH: bin, NODE_PATH: '', NODE_OPTIONS: '',
  npm_config_userconfig: join(directory, 'user.npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc'),
  AGENTKIT_PYTHON: '/unavailable/python', AGENTKIT_PYTHON_ROOT: '/unavailable/ksadk' };
console.log(JSON.stringify({ stage: 'installing', directory, archive, node: process.version }));
const child = spawn(process.execPath, [realpathSync(npm), 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
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
import * as Harness from './node_modules/@kingsoftcloud/agentkit-studio/packages/agentkit-harness/src/native/sqlite-store.mjs';
import { SqliteNativeMemoryProvider } from './node_modules/@kingsoftcloud/agentkit-studio/packages/agentkit-harness/src/native/memory-store.mjs';
import { nativeUserMemoryCandidate,memoryDigest,nativeMemoryScopeBindings } from './node_modules/@kingsoftcloud/agentkit-studio/packages/agentkit-harness/src/native/memory-candidate.mjs';
import { checkPythonSyntax } from './node_modules/@kingsoftcloud/agentkit-studio/packages/agentkit-harness/src/native/python-syntax.mjs';
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
await writeFile(join(directory, 'proof.json'), JSON.stringify({ passed: true, node: process.version, directory, archive,
  packageCount: Object.keys(lock.packages).length, scope: 'fresh install and component loading; full mounted Host execution pending', installScripts: false }, null, 2));
console.log(JSON.stringify({ passed: true, directory, packageCount: Object.keys(lock.packages).length }));
if (!values.keep) await (await import('node:fs/promises')).rm(directory, { recursive: true, force: true });
