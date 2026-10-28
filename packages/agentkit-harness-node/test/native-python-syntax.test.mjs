import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPythonSyntax, NATIVE_PYTHON_SYNTAX } from '../src/native/python-syntax.mjs';
import { createNativeWorkspaceTools } from '../src/native/workspace-tools.mjs';

// Behavioral cases derived from the pinned workspace.py ast.parse boundary
// and CPython 3.12 (the reference project's minimum). Never execute Python.
test('Python grammar covers async, pattern matching, exceptions, strings and type syntax', async () => {
  const sources = [
    '', '# a comment\n', 'import module_not_installed\nunused = 1  \n',
    'async def work(xs):\n    return [x async for x in xs if x]\n',
    'match item:\n    case {"id": value} if value > 0:\n        pass\n',
    'try:\n    work()\nexcept* ValueError as error:\n    raise error\n',
    'def combine(a, /, b=1, *items: *tuple[int, ...], flag=True, **options):\n    return a + b\n',
    'result = f"{lookup[\'key\']!r:>10}"\n',
    'type Alias = list[int]\ndef generic[T](value: T): return value\n',
    'result = f"{lookup["key"]}"\n',
    '雪 = "\\N{SNOWMAN}"\r\n',
  ];
  for (const source of sources) assert.deepEqual(await checkPythonSyntax(source), [], source);
});

test('AST parsing preserves compile-time-only failures rather than adding lint policy', async () => {
  // ast.parse explicitly omits scoping checks. Ruff.check alone rejects some
  // of these even with lint.select=[], so this protects the grammar-only API.
  for (const source of ['return 9', 'await task()', 'break', 'continue', 'yield 1',
    'nonlocal item', '__debug__ = False', 'def duplicate(x, x): pass',
    'fn(key=1, key=2)', 'def function(arg):\n    global arg\n',
    'match item:\n    case first:\n        pass\n    case second:\n        pass\n'])
    assert.deepEqual(await checkPythonSyntax(source), [], source);
});

test('invalid syntax cannot be suppressed and newer syntax cannot override the pinned target', async () => {
  for (const source of ['def broken(:\n    pass\n', 'if True:\npass\n', 'value = "unterminated',
    '# ruff: noqa\nvalue =\n', 'value = (1 + 2', 'del function()',
    'def generic[T = int](value: T): return value', 'value = t"template"']) {
    const issues = await checkPythonSyntax(source);
    assert.equal(issues.length, 1, source); assert.equal(issues[0].severity, 'error');
    assert.ok(issues[0].line > 0 && issues[0].column > 0 && issues[0].message, source);
  }
});

test('grammar diagnostics use one-based Unicode columns across CRLF and bare CR', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const [issue] = await checkPythonSyntax(`okay = 1${newline}"😀"; x =${newline}`);
    assert.equal(issue.line, 2); assert.equal(issue.column, 9);
  }
});

test('NUL is rejected even inside comments and string literals', async () => {
  for (const source of ['# ignored\0\n', 'text = "a\0b"', 'pass\n\0']) {
    const [issue] = await checkPythonSyntax(source);
    assert.match(issue.message, /NUL/); assert.equal(issue.severity, 'error');
  }
});

test('CPython default decimal conversion limit counts actual integer tokens only', async () => {
  assert.deepEqual(await checkPythonSyntax(`number = ${'9'.repeat(4300)}`), []);
  for (const token of ['9'.repeat(4301), Array(4301).fill('1').join('_'), '0'.repeat(4301)]) {
    const [issue] = await checkPythonSyntax(`number = ${token}`);
    assert.match(issue.message, /4300-digit/); assert.equal(issue.column, 10);
  }
  for (const source of [`text = "${'9'.repeat(4400)}"`, `# ${'9'.repeat(4400)}`,
    `number = 0x${'f'.repeat(4400)}`, `number = ${'9'.repeat(4400)}.0`,
    `number = ${'9'.repeat(4400)}j`]) assert.deepEqual(await checkPythonSyntax(source), [], source.slice(0, 30));
  assert.match((await checkPythonSyntax(`f"{${'9'.repeat(4301)}}"`))[0].message, /4300-digit/);
});

test('parser nesting and indentation remain within the pinned tokenizer limits', async () => {
  assert.deepEqual(await checkPythonSyntax(`x = ${'('.repeat(200)}0${')'.repeat(200)}`), []);
  assert.match((await checkPythonSyntax(`x = ${'('.repeat(201)}0${')'.repeat(201)}`))[0].message, /nested parentheses/);
  const nested = count => Array.from({ length: count }, (_, i) => ' '.repeat(i) + 'if True:\n').join('') + ' '.repeat(count) + 'pass\n';
  assert.deepEqual(await checkPythonSyntax(nested(99)), []);
  assert.match((await checkPythonSyntax(nested(100)))[0].message, /indentation/);
});

test('worker cancellation and deadline terminate parsing without blocking the Host', async () => {
  const controller = new AbortController(), reason = new Error('cancel syntax');
  const pending = checkPythonSyntax('value = 1\n'.repeat(100000), { signal: controller.signal });
  const rejection = assert.rejects(pending, error => error === reason);
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort(reason); await rejection;
  await assert.rejects(checkPythonSyntax('pass', { timeoutMs: 1 }), { code: 'python_syntax_timeout' });
  // A terminated worker cannot poison a later invocation.
  assert.deepEqual(await checkPythonSyntax('value = 2'), []);
});

test('invalid inputs and pre-cancelled requests never acquire a parser worker', async () => {
  await assert.rejects(checkPythonSyntax('x'.repeat(2 * 1024 * 1024 + 1)), { code: 'python_syntax_input_invalid' });
  await assert.rejects(checkPythonSyntax(null), { code: 'python_syntax_input_invalid' });
  await assert.rejects(checkPythonSyntax('pass', { timeoutMs: 0 }), { code: 'python_syntax_deadline_invalid' });
  await assert.rejects(checkPythonSyntax('pass', { signal: AbortSignal.abort(new Error('before parse')) }), /before parse/);
});

test('workspace lint retains path authority, ignores project policy and never executes source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-python-syntax-')), workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tools = createNativeWorkspaceTools({ workspaceRoot, stateDir: join(root, 'state'), sessionId: 's', authorize: async () => 'allow' });
  const call = (path, signal) => tools.execute({ sessionId: 's', operationKey: 'lint', signal: signal ?? new AbortController().signal,
    call: { callId: 'lint', name: 'lint_workspace_file', arguments: { path } } });
  writeFileSync(join(workspaceRoot, 'pyproject.toml'), '[tool.ruff]\ntarget-version="py314"\n[tool.ruff.lint]\nignore=["ALL"]\n');
  writeFileSync(join(workspaceRoot, 'bad.py'), '# noqa\ndef broken(:\n');
  assert.equal((await call('bad.py')).content.ok, false);
  writeFileSync(join(workspaceRoot, 'new.py'), 'def generic[T = int](value: T): return value\n');
  assert.equal((await call('new.py')).content.ok, false);
  const program = 'from pathlib import Path\nPath("EXECUTED").touch()\nraise RuntimeError("never run")\n';
  writeFileSync(join(workspaceRoot, 'program.py'), program);
  const valid = await call('program.py');
  assert.equal(valid.status, 'ok'); assert.deepEqual(valid.content.syntax_engine, NATIVE_PYTHON_SYNTAX);
  assert.equal(existsSync(join(workspaceRoot, 'EXECUTED')), false);
  assert.equal(readFileSync(join(workspaceRoot, 'program.py'), 'utf8'), program);
  writeFileSync(join(root, 'outside.py'), 'pass'); symlinkSync(join(root, 'outside.py'), join(workspaceRoot, 'outside.py'));
  for (const path of ['../outside.py', 'outside.py']) assert.equal((await call(path)).content.error_type, 'path_escape');
  const pending = call('program.py', AbortSignal.timeout(1));
  const cancelled = await pending;
  assert.equal(cancelled.status, 'error'); assert.equal(cancelled.content.code, 'canceled');
});
