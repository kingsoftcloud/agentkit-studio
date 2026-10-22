import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinExecutor } from '../src/providers/dsh-runtime-plugin.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      child.stdout.write(JSON.stringify({ ok: true }));
      queueMicrotask(() => child.emit('close', 0, null));
      callback();
    },
  });
  child.kill = () => {};
  return child;
}

function roots() {
  const root = mkdtempSync(join(tmpdir(), 'ksadk-root-'));
  const workspace = mkdtempSync(join(tmpdir(), 'ksadk-workspace-'));
  return {
    root, workspace,
    cleanup() { rmSync(root, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); },
  };
}

test('Windows builtin executor uses Scripts python.exe and never opens a console', async t => {
  const { root, workspace, cleanup } = roots();
  t.after(cleanup);
  mkdirSync(join(root, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(join(root, '.venv', 'Scripts', 'python.exe'), '');
  let captured;
  const execute = createBuiltinExecutor({
    platform: 'win32', pythonRoot: root, workspaceRoot: workspace,
    spawnImpl: (command, args, options) => { captured = { command, args, options }; return fakeChild(); },
  });
  assert.deepEqual(await execute({ name: 'some_tool', timeoutSeconds: 5 }, { value: 1 }), { ok: true });
  assert.equal(captured.command, join(root, '.venv', 'Scripts', 'python.exe'));
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.detached, false);
});

test('POSIX builtin executor keeps process-group isolation and hides no console', async t => {
  const { root, workspace, cleanup } = roots();
  t.after(cleanup);
  mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(root, '.venv', 'bin', 'python'), '');
  let captured;
  const execute = createBuiltinExecutor({
    platform: 'linux', pythonRoot: root, workspaceRoot: workspace,
    spawnImpl: (command, args, options) => { captured = { command, args, options }; return fakeChild(); },
  });
  assert.deepEqual(await execute({ name: 'some_tool', timeoutSeconds: 5 }, {}), { ok: true });
  assert.equal(captured.command, join(root, '.venv', 'bin', 'python'));
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.detached, true);
});
