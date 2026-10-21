import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLocalCommand, checkGovernedCommand } from '../src/native/local-command-policy.mjs';
import { decodeRuffAst } from '../src/native/ruff-ast.mjs';

// Deterministic behavior cases transcribed from pinned 355059d local_controls.py
// and resource_runtime/test_local_process_phase_one_controls.py. No Python runs.
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'native-policy-')), cwd = join(root, 'workspace'); mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { cwd, allowedRoots: [cwd] };
  return { root, cwd, check: (command, extra = {}) => checkLocalCommand(command, { ...options, ...extra }),
    py: (source, extra = {}) => checkLocalCommand(['python', '-c', source], { ...options, ...extra }) };
}
test('governed command policy preserves the separate gateway shlex rules before local risk checks', async t => {
  const f = fixture(t), check = command => checkGovernedCommand(command, { cwd: f.cwd, allowedRoots: [f.cwd] });
  for (const command of ['sudo true', 'printf docker', 'kubectl get pods', 'rm -r scratch', 'git push', 'git checkout main',
    'printf metadata.google.internal', 'curl http://169.254.169.254']) assert.equal((await check(command)).rule, 'command_rejected', command);
  for (const command of ['echo "unclosed', 'echo trailing\\']) assert.equal((await check(command)).rule, 'invalid_command');
  for (const command of ['printf "%s" "sudo value"', 'printf sudo\u00a0value', 'git status metadata.google.internal', 'printf "# data"'])
    assert.equal(await check(command), null, command);
  assert.equal((await check('sh -c "setsid sleep 5"')).rule, 'shell.blocked_command.setsid');
});
test('shell control operators, executable basenames and recursive-force flags match source policy', async t => {
  const f = fixture(t);
  for (const command of ['kill', 'killall', 'nohup', 'pkill', 'setsid']) {
    assert.equal((await f.check(`/bin/${command} target`)).rule, `shell.blocked_command.${command}`);
    assert.equal((await f.check(['X=1', command, 'target'])).rule, `shell.blocked_command.${command}`);
  }
  for (const command of ['rm -rf scratch', 'rm --recursive --force scratch', 'true && rm -r -f scratch', 'false || rm -Rf scratch', 'echo x | rm -rf scratch'])
    assert.equal((await f.check(command)).rule, 'shell.recursive_force_remove', command);
  for (const command of ['sleep 5 &', 'echo x &> output', 'echo x # data &'])
    assert.equal((await f.check(command)).rule, 'shell.background_process', command);
});
test('quoted shell data, redirects, ordinary deletes and arguments never become executables', async t => {
  const f = fixture(t);
  for (const command of ["printf '%s' /etc/example", 'echo setsid', 'chmod +x run.sh', 'echo "kill; rm -rf"',
    "printf '%s' 'a&b'", 'echo a\\&b', 'echo x 2>&1', 'rm -r scratch', 'rm -f file', 'rm -- -rf', '# setsid\necho safe'])
    assert.equal(await f.check(command), null, command);
  assert.equal(await f.check(['printf', 'setsid', '&&', 'data']), null);
});
test('nested shell and inline Python are recursively analyzed without executing either language', async t => {
  const f = fixture(t);
  assert.equal((await f.check("bash -c 'rm -rf scratch'")).rule, 'shell.recursive_force_remove');
  assert.equal((await f.check(['sh', '-c', "python3 -c 'import os; os.kill(1,9)' "])).rule, 'python.process_control');
  assert.equal((await f.py('import os; os.system("sh -c \'setsid sleep 5\'")')).rule, 'shell.blocked_command.setsid');
  assert.equal((await f.py('from os import popen as p; p("sleep 5 &")')).rule, 'shell.background_process');
});
test('AST import aliases, attribute calls and Unicode line positions preserve process-control checks', async t => {
  const f = fixture(t);
  for (const source of ['import os as o\no.kill(1, 9)', 'from os import kill as k\nk(1, 9)',
    'import os\nos.killpg(1, 9)', 'from os import setsid\nsetsid()', 'label="中文"\nimport os\nos.kill(1, 9)']) {
    const result = await f.py(source); assert.equal(result.rule, 'python.process_control');
    assert.equal(result.path, '<command>'); assert.equal(result.line, source.split('\n').length);
  }
  // ast.parse admits compilation-invalid duplicate parameters: still scan calls.
  assert.equal((await f.py('import os\ndef f(x,x): os.kill(1,9)')).rule, 'python.process_control');
  assert.equal(await f.py('import os\nos.kill('), null); // Source skips syntax errors.
});
test('subprocess tuple/list, literal shell flags and detached process checks use AST literals', async t => {
  const f = fixture(t);
  for (const method of ['call', 'check_call', 'check_output', 'Popen', 'run'])
    assert.equal((await f.py(`import subprocess as s\ns.${method}(['rm', '-rf', 'scratch'])`)).rule, 'shell.recursive_force_remove');
  assert.equal((await f.py('from subprocess import run as r\nr(("setsid", "sleep", "5"))')).rule, 'shell.blocked_command.setsid');
  assert.equal((await f.py('from subprocess import Popen as p\np(["echo"], start_new_session=True)')).rule, 'python.detached_process');
  assert.equal((await f.py('import subprocess\nsubprocess.run("rm -rf scratch", shell=True)')).rule, 'shell.recursive_force_remove');
  for (const source of ['import subprocess\nsubprocess.run("rm -rf scratch", shell=False)',
    'import subprocess\nsubprocess.run("rm -rf scratch", shell=1)',
    'import subprocess\nsubprocess.run("rm -rf scratch", shell=flag)',
    'import subprocess\ncommand=["echo"]; subprocess.Popen(command, stdout=subprocess.PIPE)',
    'import subprocess\nsubprocess.Popen(["echo"], start_new_session=False)']) assert.equal(await f.py(source), null, source);
});
test('rmtree resolves workspace roots, relative targets and existing or dangling symlink ancestors', async t => {
  const f = fixture(t); mkdirSync(join(f.root, 'outside')); symlinkSync(join(f.root, 'outside'), join(f.cwd, 'escape'));
  symlinkSync(join(f.root, 'absent'), join(f.cwd, 'dangling'));
  for (const target of ['../outside', '/outside', 'escape/not-yet-created', 'dangling/not-yet-created'])
    assert.equal((await f.py(`import shutil as s\ns.rmtree(${JSON.stringify(target)})`)).rule, 'path.destructive_outside_workspace');
  assert.equal(await f.py('from shutil import rmtree\nrmtree("scratch/not-yet-created")'), null);
  assert.equal(await f.py('import shutil\nshutil.rmtree(target)'), null);
  assert.equal(await f.py('import shutil\nshutil.rmtree("/outside")', { allowedRoots: ['/'] }), null);
  await assert.rejects(f.py('import shutil\nshutil.rmtree("~another-user/data")'), { code: 'command_policy_unavailable' });
  assert.equal(await f.py('import shutil\nshutil.rmtree("../outside")',
    { allowedRoots: [f.cwd, join(f.root, 'outside')] }), null, 'multiple roots can be authorized by Host');
});
test('direct entry scripts are scanned; unused Python helpers, ordinary arguments and external entries are untouched', async t => {
  const f = fixture(t);
  const bad = join(f.cwd, 'danger.py'); writeFileSync(bad, 'import os\nos.kill(os.getpid(), 9)\n');
  writeFileSync(join(f.cwd, 'safe.sh'), '#!/bin/sh\nprintf safe\n');
  writeFileSync(join(f.cwd, 'danger.sh'), '#!/bin/sh\nrm -rf scratch\n');
  writeFileSync(join(f.root, 'external.py'), 'import os\nos.kill(1,9)\n');
  for (const command of ['python danger.py', './danger.py', 'python3.12 -- danger.py']) {
    const result = await f.check(command); assert.equal(result.rule, 'python.process_control'); assert.equal(result.path, bad); assert.equal(result.line, 2);
  }
  assert.equal((await f.check('bash danger.sh')).rule, 'shell.recursive_force_remove');
  for (const command of ['sh safe.sh', 'printf "%s" danger.py', 'python ../external.py', 'python -m danger.py', 'python missing.py'])
    assert.equal(await f.check(command), null, command);
});
test('AST decoding distinguishes comments, strings, f-strings, bytes and escaped or concatenated literals', async t => {
  const f = fixture(t);
  for (const source of ['# os.kill(1,9)\nprint("os.kill(1,9)")', 'print(f"os.kill({1}, {9})")',
    'print(b"rm -rf x")', 'x=1+2j; print({n for n in range(3)})', 'match x:\n case 1: print(x)'])
    assert.equal(await f.py(source), null, source);
  for (const source of ['import os; os.system("rm " "-rf scratch")',
    'import subprocess; subprocess.run(["r\\u006d", "-rf", "\\x00\\v😀"])'])
    assert.equal((await f.py(source)).rule, 'shell.recursive_force_remove');
  assert.equal(await f.py(`
type Alias[T] = list[T]
@decorate(flag=True)
class Example(Base):
    value: int | None = None
    def method(self, x=..., *args, **kwargs):
        try:
            return {k: v for k, v in source if k}, [*args], b"\\x00", 1e999, 2j
        except Exception as error:
            raise RuntimeError("example") from error
async def work():
    async with manager() as resource:
        yield await resource.run()
`), null);
  assert.throws(() => decodeRuffAst('Module(Unexpected<wire>)'), /unsupported_ruff_ast_encoding/);
});
test('invalid inputs, bounded source, deadline and cancellation fail closed with no command side effects', async t => {
  const f = fixture(t);
  await assert.rejects(f.check(42), { code: 'invalid_command_policy_input' });
  await assert.rejects(f.check('echo safe', { timeoutMs: 0 }), { code: 'invalid_command_policy_deadline' });
  await assert.rejects(f.check('x'.repeat(2 * 1024 * 1024)), { code: 'invalid_command_policy_input' });
  writeFileSync(join(f.cwd, 'large.py'), '#'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(f.check('python large.py'), { code: 'command_policy_unavailable' });
  await assert.rejects(f.py('print("safe")', { timeoutMs: 1 }), { code: 'command_policy_timeout' });
  const controller = new AbortController(), reason = Error('stop policy');
  const pending = f.py('print("safe")', { signal: controller.signal }); controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  await assert.rejects(f.check('echo safe', { signal: controller.signal }), error => error === reason);
});
