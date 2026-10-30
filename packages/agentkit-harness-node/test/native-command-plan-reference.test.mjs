import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRuntimeReadOnlyBashCommand as readOnly } from '../dist/native-command-plan.mjs';
import { checkPlanCommand } from '@kingsoftcloud/agentkit-harness-node/native/command-plan';

// Source: pinned ZCode tests/bash-permission.test.ts; no shell runs in these tests.
test('reference read/search, safe redirects, wrappers and pipelines remain usable in planning', () => {
  for (const command of ['pwd', 'whoami', "printf '%s\\n' hello", 'cat < README.md', 'head -n 20 README.md',
    'rg --files src', "rg -g '*.ts' foo src", "sed -n '1,20p' README.md", 'grep -R -n foo src 2>&1',
    'grep -R -n foo src 2>/dev/null', 'LC_ALL=C grep -R -n foo src', 'command grep -n foo file',
    'git status --short', 'git diff --stat', 'cat README.md | head -n 2', 'cd src && grep -n foo file', 'tree -L 2'])
    assert.equal(readOnly(command), true, command);
});

test('reference rejects writes, dynamic words, unsafe options and unsupported syntax', () => {
  for (const command of ['ls > out.txt', 'find . -exec rm {} \\;', 'ls $(touch out.txt)', 'ls `touch out.txt`',
    'tree -o out.txt', 'tree --bogus', 'sed -i s/a/b/ file', 'git reset --hard', 'git -c core.pager=evil diff',
    'node -e "console.log(1)"', 'PATH=./bin ls', 'GIT_DIR=evil git status', 'cd src && git status',
    'for x in a; do echo "$x"; done', '', 'x'.repeat(10001)]) assert.equal(readOnly(command), false, command.slice(0, 100));
});

test('real workspace Git structure changes the reference runtime classification', t => {
  const root = mkdtempSync(join(tmpdir(), 'command-plan-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = { workingDirectory: root, workspaceRoot: root };
  assert.equal(readOnly('git status --short', context), true);
  // A bare-repository indicator makes a generic workspace directory unsafe.
  writeFileSync(join(root, 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(readOnly('git status --short', context), false); rmSync(join(root, 'HEAD'));
  mkdirSync(join(root, '.git/objects'), { recursive: true }); mkdirSync(join(root, '.git/refs'));
  writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  assert.equal(readOnly('git status --short', context), true);
  rmSync(join(root, '.git'), { recursive: true }); mkdirSync(join(root, 'evil'));
  writeFileSync(join(root, '.git'), 'gitdir: evil\n');
  assert.equal(readOnly('git status --short', context), false);
  assert.equal(readOnly('cat README.md', context), true);
});

test('bounded worker applies the same policy to Native environment overrides and honors cancellation', async () => {
  const context = { cwd: process.cwd(), workspaceRoot: process.cwd() };
  assert.equal(await checkPlanCommand('pwd', { ...context, env: { LC_ALL: 'C' } }), true);
  for (const env of [{ PATH: './bin' }, { GIT_DIR: 'evil' }, { BASH_ENV: 'evil' }])
    assert.equal(await checkPlanCommand('pwd', { ...context, env }), false);
  assert.equal(await checkPlanCommand('pwd', { ...context, timeoutMs: 1 }), false);
  await assert.rejects(checkPlanCommand('pwd', { ...context, signal: AbortSignal.abort(Error('cancel-plan-check')) }), /cancel-plan-check/);
  const controller = new AbortController(), pending = checkPlanCommand('pwd', { ...context, signal: controller.signal });
  controller.abort(); assert.equal(await pending, false);
});
