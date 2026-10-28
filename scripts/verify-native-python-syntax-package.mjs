/** Cold-install the shipped Python-source parser and command policy outside the checkout.
 * This is component evidence, not a full Studio installation acceptance.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

if (!process.argv[2]) throw Error('usage: verify-native-python-syntax-package.mjs <Studio tarball>');
const npm = (process.env.PATH ?? '').split(delimiter).map(path => join(path, 'npm')).find(existsSync);
if (!npm) throw Error('This verification requires the npm Node CLI on the parent PATH.');
const directory = await mkdtemp(join(tmpdir(), 'studio-python-syntax-'));
const run = async (args, env, timeout) => {
  const child = spawn(process.execPath, args, { cwd: directory, env, stdio: 'inherit', timeout });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, `Parser package verification process failed (${code})`);
};
try {
  execFileSync('tar', ['-xzf', resolve(process.argv[2]), '-C', directory,
    'package/package.json', 'package/node_modules/@kingsoftcloud/agentkit-harness-node/src/native/python-syntax.mjs',
    'package/node_modules/@kingsoftcloud/agentkit-harness-node/src/native/python-syntax-worker.mjs',
    ...['local-command-policy.mjs', 'local-command-policy-worker.mjs', 'ruff-ast.mjs']
      .map(file => 'package/node_modules/@kingsoftcloud/agentkit-harness-node/src/native/' + file)]);
  const manifest = JSON.parse(await readFile(join(directory, 'package/package.json'), 'utf8'));
  const dependency = '@astral-sh/ruff-wasm-nodejs', version = manifest.dependencies?.[dependency];
  assert.equal(version, '0.16.8');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'isolated-native-parser-proof', private: true,
    dependencies: { [dependency]: version } }));
  const binaries = join(directory, 'bin'); await mkdir(binaries); await symlink(process.execPath, join(binaries, 'node'));
  await writeFile(join(directory, 'user.npmrc'), ''); await writeFile(join(directory, 'global.npmrc'), '');
  const env = { ...process.env, PATH: binaries, NODE_PATH: '', NODE_OPTIONS: '',
    npm_config_userconfig: join(directory, 'user.npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc') };
  // A new cache, package root and dependency tree; install scripts cannot run.
  await run([realpathSync(npm), 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    '--workspaces=false', '--registry=https://registry.npmjs.org', `--cache=${join(directory, 'empty-cache')}`], env, 120000);
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[`node_modules/${dependency}`].integrity,
    'sha512-saSBCYcHUdAFM7i9gHZB2ciWtbjrsfWxcCDhn+PCsIXORVy7/h33xsGxv/F8bgMijoQlxUIokU/n8rYGFTxcEw==');
  const verify = async () => {
    const assert = (await import('node:assert/strict')).default;
    const { access } = await import('node:fs/promises');
    const { checkPythonSyntax, NATIVE_PYTHON_SYNTAX } = await import('./package/node_modules/@kingsoftcloud/agentkit-harness-node/src/native/python-syntax.mjs');
    await access('./node_modules/@astral-sh/ruff-wasm-nodejs/LICENSE');
    assert.equal(NATIVE_PYTHON_SYNTAX.parserVersion, '0.16.8');
    assert.deepEqual(await checkPythonSyntax('async def check():\n    return await task()\n'), []);
    assert.deepEqual(await checkPythonSyntax('def duplicate(x, x): pass'), []);
    assert.equal((await checkPythonSyntax('def broken(:\n')).length, 1);
    assert.deepEqual(await checkPythonSyntax('type Alias = int'), []);
    assert.match((await checkPythonSyntax('def generic[T = int](): pass'))[0].message, /Python 3\.12/);
    assert.match((await checkPythonSyntax(`number = ${'1'.repeat(4301)}`))[0].message, /4300-digit/);
    const { checkLocalCommand } = await import('./package/node_modules/@kingsoftcloud/agentkit-harness-node/src/native/local-command-policy.mjs');
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir('workspace'); const cwd = new URL('./workspace/', import.meta.url).pathname;
    const options = { cwd, allowedRoots: [cwd] };
    assert.equal(await checkLocalCommand('echo safe', options), null);
    assert.equal((await checkLocalCommand(['python', '-c', 'import os as o; o.kill(1,9)'], options)).rule, 'python.process_control');
    await writeFile('workspace/danger.py', 'from subprocess import Popen as p\np(["echo"], start_new_session=True)');
    assert.equal((await checkLocalCommand('python danger.py', options)).rule, 'python.detached_process');
    assert.equal((await checkLocalCommand('bash -c "rm -rf scratch"', options)).rule, 'shell.recursive_force_remove');
    console.log('PASS: packed Python-source parser and AST command policy cold-install and run outside the checkout with only Node on PATH; no Python, uv or install scripts.');
  };
  await writeFile(join(directory, 'verify.mjs'), `(${verify.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`);
  await run([join(directory, 'verify.mjs')], env, 20000);
} finally { await rm(directory, { recursive: true, force: true }); }
