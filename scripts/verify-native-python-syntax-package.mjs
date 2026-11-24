/** Cold-install Studio production dependencies and exercise the local command path. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  const archive = resolve(process.argv[2]);
  const product = 'node_modules/@kingsoftcloud/agentkit-studio';
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'isolated-studio-command-proof', private: true }));
  const binaries = join(directory, 'bin'); await mkdir(binaries); await symlink(process.execPath, join(binaries, 'node'));
  await writeFile(join(directory, 'user.npmrc'), ''); await writeFile(join(directory, 'global.npmrc'), '');
  const env = { ...process.env, PATH: binaries, NODE_PATH: '', NODE_OPTIONS: '',
    npm_config_userconfig: join(directory, 'user.npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc') };
  // A new cache, package root and dependency tree; install scripts cannot run.
  await run([realpathSync(npm), 'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    '--workspaces=false', '--registry=https://registry.npmjs.org', `--cache=${join(directory, 'empty-cache')}`, archive], env, 240000);
  const installed = JSON.parse(await readFile(join(directory, product, 'package.json'), 'utf8'));
  assert.equal(installed.dependencies['@astral-sh/ruff-wasm-nodejs'], '0.16.8');
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  assert.ok(Object.keys(lock.packages).every(path => !path.includes('/@kingsoftcloud/agentkit-harness-')));
  assert.equal(lock.packages['node_modules/@astral-sh/ruff-wasm-nodejs'].integrity,
    'sha512-saSBCYcHUdAFM7i9gHZB2ciWtbjrsfWxcCDhn+PCsIXORVy7/h33xsGxv/F8bgMijoQlxUIokU/n8rYGFTxcEw==');
  const verify = async () => {
    const assert = (await import('node:assert/strict')).default;
    const { access } = await import('node:fs/promises');
    const { checkPythonSyntax, NATIVE_PYTHON_SYNTAX } = await import('./node_modules/@kingsoftcloud/agentkit-studio/src/providers/studio-workspace/python-syntax.mjs');
    await access('./node_modules/@astral-sh/ruff-wasm-nodejs/LICENSE');
    assert.equal(NATIVE_PYTHON_SYNTAX.parserVersion, '0.16.8');
    assert.deepEqual(await checkPythonSyntax('async def check():\n    return await task()\n'), []);
    assert.deepEqual(await checkPythonSyntax('def duplicate(x, x): pass'), []);
    assert.equal((await checkPythonSyntax('def broken(:\n')).length, 1);
    assert.deepEqual(await checkPythonSyntax('type Alias = int'), []);
    assert.match((await checkPythonSyntax('def generic[T = int](): pass'))[0].message, /Python 3\.12/);
    assert.match((await checkPythonSyntax(`number = ${'1'.repeat(4301)}`))[0].message, /4300-digit/);
    const { checkGovernedCommand } = await import('./node_modules/@kingsoftcloud/agentkit-studio/src/providers/studio-local-command/local-command-policy.mjs');
    const { fileURLToPath } = await import('node:url');
    const { writeFile, mkdir, readFile } = await import('node:fs/promises');
    await mkdir('workspace'); const cwd = fileURLToPath(new URL('./workspace', import.meta.url));
    const options = { cwd, allowedRoots: [cwd] };
    assert.equal(await checkGovernedCommand('echo safe', options), null);
    await writeFile('workspace/danger.py', 'from subprocess import Popen as p\np(["echo"], start_new_session=True)');
    assert.equal((await checkGovernedCommand('python danger.py', options)).rule, 'python.detached_process');
    assert.equal((await checkGovernedCommand('bash -c "rm -rf scratch"', options)).rule, 'shell.recursive_force_remove');
    const { createDshNodeCommandTools } = await import('./node_modules/@kingsoftcloud/agentkit-studio/src/providers/dsh-node-command-tools.mjs');
    const bind = () => createDshNodeCommandTools({ workspaceRoot: cwd, stateDir: fileURLToPath(new URL('./state', import.meta.url)),
      agentId: 'cold-install', ctx: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } } });
    let port = bind();
    const launch = { command: 'printf x >> effects; printf "原任务 😀"; sleep 0.2', background: true };
    const invoke = (name, args, callId) => port.execute(name, args, { name, arguments: args, callId, signal: AbortSignal.timeout(10000),
      agent: { session: { id: 'stable-session' } } });
    const first = await invoke('run_command', launch, 'one-launch');
    assert.equal(first.status, 'ok', JSON.stringify(first));
    const taskId = first.content.task_id;
    port.close();
    port = bind();
    try {
      const again = await invoke('run_command', launch, 'one-launch');
      assert.equal(again.content.task_id, taskId);
      const output = await invoke('read_command_output', { task_id: taskId, wait_seconds: 5 }, 'read');
      assert.equal(output.content.status, 'completed', JSON.stringify(output));
      assert.equal(output.content.stdout, '原任务 😀');
      assert.equal(await readFile(new URL('./workspace/effects', import.meta.url), 'utf8'), 'x');
    } finally { port.close(); }
    console.log('PASS: cold Studio production install has no Harness npm packages and executes its own Python parser, command policy and durable local commands.');
  };
  await writeFile(join(directory, 'verify.mjs'), `(${verify.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`);
  await run([join(directory, 'verify.mjs')], env, 20000);
} finally { await rm(directory, { recursive: true, force: true }); }
